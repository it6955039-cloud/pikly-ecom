// src/payments/adapters/stripe.adapter.ts
// Implements IPaymentProvider — zero Stripe types leak into domain logic
import { Injectable, Logger, InternalServerErrorException, BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Stripe from 'stripe'
import { IPaymentProvider, CreateSessionParams, CheckoutSessionResult, RetrievedSession, InboundWebhookEvent } from '../ports/payment-provider.port'

// In newer Stripe SDK versions the merged class+namespace types were split —
// derive the event type from constructEvent's return so it survives version bumps.
type StripeWebhookEvent = ReturnType<InstanceType<typeof Stripe>['webhooks']['constructEvent']>

@Injectable()
export class StripeAdapter extends IPaymentProvider {
  readonly providerName = 'stripe'
  private readonly stripe: InstanceType<typeof Stripe>
  private readonly webhookSecret: string
  private readonly livemode: boolean
  private readonly logger = new Logger(StripeAdapter.name)

  constructor(private readonly config: ConfigService) {
    super()
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY')
    if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required')
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET')
    if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is required')

    this.webhookSecret = webhookSecret
    this.livemode = secretKey.startsWith('sk_live_')
    this.stripe = new Stripe(secretKey, { apiVersion: '2026-04-22.dahlia', telemetry: false, maxNetworkRetries: 2 })
    this.logger.log(`Stripe initialized — mode: ${this.livemode ? 'LIVE' : 'TEST'}`)
  }

  async createCheckoutSession(params: CreateSessionParams): Promise<CheckoutSessionResult> {
    try {
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          payment_method_types: ['card'],
          line_items: [{ price_data: { currency: params.currency, unit_amount: params.amountCents, product_data: { name: params.description ?? `Order ${params.orderId}` } }, quantity: 1 }],
          metadata: { order_id: params.orderId, user_id: params.userId },
          customer_email: params.customerEmail,
          success_url: params.successUrl,
          cancel_url: params.cancelUrl,
          expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        },
        { idempotencyKey: `checkout_${params.idempotencyKey}` },
      )
      if (!session.url) throw new InternalServerErrorException('Stripe did not return checkout URL')
      return { sessionId: session.id, url: session.url, expiresAt: new Date((session.expires_at ?? 0) * 1000) }
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) {
        this.logger.error(`Stripe error for order ${params.orderId}: ${err.message}`)
        throw new InternalServerErrorException({ code: 'STRIPE_SESSION_FAILED', message: 'Payment session creation failed. Please retry.' })
      }
      throw err
    }
  }

  async retrieveSession(sessionId: string): Promise<RetrievedSession> {
    const s = await this.stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] })
    return {
      sessionId:     s.id,
      status:        s.status as any,
      paymentStatus: s.payment_status as any,
      paymentIntent: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id,
      amountTotal:   s.amount_total ?? undefined,
      currency:      s.currency ?? undefined,
      metadata:      s.metadata ?? {},
    }
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): InboundWebhookEvent {
    let event: StripeWebhookEvent
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret)
    } catch (err) {
      this.logger.warn(`Stripe signature verification failed`)
      throw err
    }

    // Livemode guard — test events cannot affect production
    if (event.livemode !== this.livemode) {
      const expected = this.livemode ? 'live' : 'test'
      this.logger.error(`Livemode mismatch: server=${expected} event=${event.livemode ? 'live' : 'test'} id=${event.id}`)
      throw new BadRequestException({ code: 'STRIPE_LIVEMODE_MISMATCH' })
    }

    return this.normalizeEvent(event)
  }

  // ── Normalize Stripe event to provider-agnostic type ─────────────────────
  // Note: Stripe.Checkout.Session / Stripe.PaymentIntent etc. were removed
  // from the StripeConstructor namespace in newer SDK versions. We use inline
  // structural types here so the code stays independent of SDK version bumps.

  private normalizeEvent(event: StripeWebhookEvent): InboundWebhookEvent {
    const obj = event.data.object as any
    const base = {
      eventId:    event.id,
      eventType:  event.type,
      objectId:   (obj as any)?.id ?? null,
      livemode:   event.livemode,
      rawPayload: event,
    }

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.expired': {
        const s = obj as {
          id: string
          metadata?: Record<string, string> | null
          payment_intent?: string | { id: string } | null
          amount_total?: number | null
          currency?: string | null
        }
        return { ...base, data: {
          orderId:       s.metadata?.order_id,
          userId:        s.metadata?.user_id,
          sessionId:     s.id,
          paymentIntent: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id,
          amountTotal:   s.amount_total ?? undefined,
          currency:      s.currency ?? undefined,
        }}
      }
      case 'payment_intent.payment_failed': {
        const pi = obj as {
          id: string
          last_payment_error?: { message?: string } | null
        }
        return { ...base, data: {
          paymentIntent: pi.id,
          failureReason: pi.last_payment_error?.message,
        }}
      }
      case 'charge.refunded': {
        const c = obj as {
          payment_intent?: string | { id: string } | null
          amount_refunded: number
          refunded: boolean
          currency: string
        }
        const piId = typeof c.payment_intent === 'string' ? c.payment_intent : c.payment_intent?.id
        return { ...base, data: {
          paymentIntent: piId,
          refundAmount:  c.amount_refunded,
          refunded:      c.refunded,
          currency:      c.currency,
        }}
      }
      case 'charge.dispute.created': {
        const d = obj as {
          payment_intent?: string | { id: string } | null
          reason: string
        }
        const piId = typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id
        return { ...base, data: { paymentIntent: piId, disputeReason: d.reason } }
      }
      default:
        return { ...base, data: {} }
    }
  }
}
