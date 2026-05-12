// src/payments/payments.service.ts — FINAL HARDENED IMPLEMENTATION
//
// Uses: IPaymentProvider | PaymentStateMachine | PaymentLedgerService | PaymentOutboxService
// Guarantees: outbox atomicity | ledger immutability | state machine enforcement | optimistic locking

import {
  BadRequestException, ForbiddenException, Injectable,
  Logger, NotFoundException,
} from '@nestjs/common'
import { randomUUID }       from 'node:crypto'
import { ConfigService }    from '@nestjs/config'
import { PoolClient }       from 'pg'
import { DatabaseService }  from '../database/database.service'
import { IPaymentProvider, InboundWebhookEvent } from './ports/payment-provider.port'
import { PaymentStateMachine, PaymentStatus, IllegalTransitionError } from './state-machine/payment.state-machine'
import { PaymentLedgerService }  from './ledger/payment.ledger.service'
import { PaymentOutboxService }  from './outbox/payment-outbox.service'
import { SessionStatus }         from './types/payment.types'

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name)

  constructor(
    private readonly db:           DatabaseService,
    private readonly provider:     IPaymentProvider,
    private readonly stateMachine: PaymentStateMachine,
    private readonly ledger:       PaymentLedgerService,
    private readonly outbox:       PaymentOutboxService,
    private readonly config:       ConfigService,
  ) {}

  // ── 1. Create Checkout Session ─────────────────────────────────────────────

  async createCheckoutSession(userId: string, orderId: string) {
    const correlationId = randomUUID()

    const orderCheck = await this.db.queryOne<any>(
      'SELECT id, user_id FROM store.orders WHERE id = $1', [orderId],
    )
    if (!orderCheck)                   throw new NotFoundException({ code: 'ORDER_NOT_FOUND' })
    if (orderCheck.user_id !== userId) throw new ForbiddenException({ code: 'ORDER_ACCESS_DENIED' })

    return this.db.transaction(async (client) => {
      const order = await client.query(
        'SELECT * FROM store.orders WHERE id = $1 FOR UPDATE', [orderId],
      ).then(r => r.rows[0])

      // Migration 007 replaced the legacy `payment` JSONB column with a plain
      // `payment_method` TEXT column ('card' | 'cod' | 'wallet').
      if (order.payment_method !== 'card') {
        throw new BadRequestException({ code: 'WRONG_PAYMENT_METHOD' })
      }

      if (this.stateMachine.isAlreadyInState(order.payment_status, PaymentStatus.CHECKOUT_CREATED)) {
        throw new BadRequestException({ code: 'SESSION_ALREADY_ACTIVE', message: 'A checkout session is already active.' })
      }

      this.stateMachine.assertTransition(order.payment_status, PaymentStatus.CHECKOUT_CREATED, orderId)

      // BUG-2 FIX: Validate pricing at runtime — unsafe cast + NaN bypass removed.
      // pricing.total = undefined → Math.round(NaN) = NaN → NaN <= 0 is FALSE → guard passes.
      const pricing = order.pricing
      const rawTotal = Number(pricing?.total)
      if (!Number.isFinite(rawTotal) || rawTotal <= 0) {
        this.logger.error(
          `[checkout] corr=${correlationId} order=${orderId} invalid pricing: ${JSON.stringify(pricing)}`
        )
        throw new BadRequestException({ code: 'INVALID_ORDER_AMOUNT', message: `Order total is invalid: ${pricing?.total}` })
      }
      const amountCents = Math.round(rawTotal * 100)
      if (amountCents <= 0) throw new BadRequestException({ code: 'INVALID_ORDER_AMOUNT' })
      const currency = (String(pricing?.currency ?? 'usd')).toLowerCase()

      const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3001'
      const user = await client.query(
        'SELECT email, first_name FROM store.users WHERE id = $1', [userId],
      ).then(r => r.rows[0])

      const session = await this.provider.createCheckoutSession({
        orderId, userId, amountCents, currency,
        successUrl:     `${frontendUrl}/orders/${orderId}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl:      `${frontendUrl}/orders/${orderId}/cancel`,
        customerEmail:  user?.email,
        idempotencyKey: orderId,
        description:    `Pikly order ${orderId}`,
      })

      await client.query(
        `INSERT INTO store.payment_checkout_sessions
           (order_id, user_id, stripe_session_id, amount_cents, currency,
            checkout_url, success_url, cancel_url, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (stripe_session_id) DO UPDATE SET updated_at = NOW()`,
        [orderId, userId, session.sessionId, amountCents, currency, session.url,
         `${frontendUrl}/orders/${orderId}/success?session_id={CHECKOUT_SESSION_ID}`,
         `${frontendUrl}/orders/${orderId}/cancel`, session.expiresAt],
      )

      await this.applyOrderTransition(client, {
        orderId, expectedVersion: order.version,
        newPaymentStatus: PaymentStatus.CHECKOUT_CREATED,
        stripeSessionId: session.sessionId, stripePaymentIntent: null,
      })

      await this.ledger.append({
        orderId, userId, entryType: 'checkout_initiated',
        amountCents, currency,
        previousStatus: order.payment_status, newStatus: PaymentStatus.CHECKOUT_CREATED,
        stripeObjectId: session.sessionId, correlationId,
      }, client)

      this.logger.log(
        `[checkout_created] corr=${correlationId} order=${orderId} user=${userId} ` +
        `session=${session.sessionId} amount=${amountCents}${currency} provider=${this.provider.providerName}`,
      )

      return { sessionId: session.sessionId, url: session.url, expiresAt: session.expiresAt, amountCents, currency }
    })
  }

  // ── 2. Inbound Webhook Handler ─────────────────────────────────────────────

  async handleInboundWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const correlationId = randomUUID()

    let event: InboundWebhookEvent
    try {
      event = this.provider.constructWebhookEvent(rawBody, signature)
    } catch {
      this.logger.warn(`[webhook] corr=${correlationId} Verification failed`)
      throw new BadRequestException({ code: 'INVALID_WEBHOOK_SIGNATURE' })
    }

    this.logger.log(`[webhook_received] corr=${correlationId} event=${event.eventId} type=${event.eventType}`)

    const claimed = await this.claimEvent(event, correlationId)
    if (!claimed) return

    let processingStatus = 'processed'
    let errorMessage: string | null = null
    let resolvedOrderId: string | null = null

    try {
      switch (event.eventType) {
        case 'checkout.session.completed':
          resolvedOrderId = await this.onCheckoutCompleted(event, correlationId); break
        case 'checkout.session.expired':
          resolvedOrderId = await this.onCheckoutExpired(event, correlationId); break
        case 'payment_intent.succeeded':
          processingStatus = 'skipped'; break   // handled via checkout.session.completed
        case 'payment_intent.payment_failed':
          resolvedOrderId = await this.onPaymentIntentFailed(event, correlationId); break
        case 'charge.refunded':
          resolvedOrderId = await this.onChargeRefunded(event, correlationId); break
        case 'charge.dispute.created':
          await this.onDisputeCreated(event, correlationId); break
        default:
          processingStatus = 'skipped'
          this.logger.log(`[webhook] corr=${correlationId} Unhandled: ${event.eventType}`)
      }
    } catch (err: unknown) {
      processingStatus = 'failed'
      errorMessage = err instanceof Error ? err.message : String(err)
      this.logger.error(`[webhook_failed] corr=${correlationId} event=${event.eventId} error="${errorMessage}"`)
    }

    await this.db.execute(
      `UPDATE store.payment_events
       SET processing_status=$1, order_id=$2, processed_at=NOW(), error_message=$3
       WHERE stripe_event_id=$4`,
      [processingStatus, resolvedOrderId, errorMessage, event.eventId],
    ).catch(e => this.logger.error(`[webhook] corr=${correlationId} Status update failed: ${e.message}`))
  }

  // ── Private event handlers ─────────────────────────────────────────────────

  private async onCheckoutCompleted(event: InboundWebhookEvent, correlationId: string): Promise<string> {
    const { orderId, userId, sessionId, paymentIntent, amountTotal, currency } = event.data
    if (!orderId || !userId) throw new Error(`Missing metadata in event ${event.eventId}`)

    // Semantic idempotency via ledger — before row lock
    const alreadyProcessed = await this.ledger.hasEntryForEvent(event.eventId, 'payment_succeeded')
    if (alreadyProcessed) {
      this.logger.log(`[webhook] corr=${correlationId} Ledger confirms order ${orderId} already paid — skip`)
      return orderId
    }

    await this.db.transaction(async (client) => {
      const order = await client.query(
        'SELECT * FROM store.orders WHERE id = $1 FOR UPDATE', [orderId],
      ).then(r => r.rows[0])
      if (!order) throw new Error(`Order ${orderId} not found`)

      if (this.stateMachine.isAlreadyInState(order.payment_status, PaymentStatus.SUCCEEDED)) {
        this.logger.log(`[webhook] corr=${correlationId} Order ${orderId} already paid — row-level skip`)
        return
      }

      try {
        this.stateMachine.assertTransition(order.payment_status, PaymentStatus.SUCCEEDED, orderId)
      } catch (err) {
        if (err instanceof IllegalTransitionError) { this.logger.error(`[webhook] corr=${correlationId} ${err.message}`); return }
        throw err
      }

      const timeline = [
        ...(order.timeline ?? []),
        { status: 'confirmed', timestamp: new Date(), note: `Payment confirmed. Session: ${sessionId}. PI: ${paymentIntent ?? 'n/a'}` },
      ]

      await this.applyOrderTransition(client, {
        orderId, expectedVersion: order.version,
        newPaymentStatus: PaymentStatus.SUCCEEDED, newOrderStatus: 'confirmed',
        stripeSessionId: sessionId ?? null, stripePaymentIntent: paymentIntent ?? null, timeline,
      })

      await client.query(
        `UPDATE store.payment_checkout_sessions
         SET status=$1, stripe_payment_intent=$2, updated_at=NOW()
         WHERE stripe_session_id=$3`,
        [SessionStatus.COMPLETED, paymentIntent, sessionId],
      )

      await this.ledger.append({
        orderId, userId, entryType: 'payment_succeeded',
        amountCents: amountTotal ?? 0, currency: currency ?? 'usd',
        previousStatus: order.payment_status, newStatus: PaymentStatus.SUCCEEDED,
        stripeObjectId: sessionId ?? null, stripeEventId: event.eventId, correlationId,
        metadata: { paymentIntent, provider: this.provider.providerName },
      }, client)

      const user = await client.query(
        'SELECT email, first_name FROM store.users WHERE id = $1', [userId],
      ).then(r => r.rows[0])

      // Outbox: side effects guaranteed at-least-once delivery
      await this.outbox.enqueue({
        eventType: 'PaymentSucceeded', aggregateId: orderId, correlationId,
        payload: {
          orderId, userId, email: user?.email, firstName: user?.first_name,
          order: { ...order, status: 'confirmed', payment_status: PaymentStatus.SUCCEEDED },
          stripeSessionId: sessionId, stripePaymentIntent: paymentIntent, amountCents: amountTotal, currency,
        },
      }, client)

      // Fulfillment is decoupled — failure cannot corrupt payment state
      await this.outbox.enqueue({
        eventType: 'FulfillmentRequested', aggregateId: orderId, correlationId,
        payload: { orderId, userId, amountCents: amountTotal, currency },
      }, client)
    })

    this.logger.log(`[payment_succeeded] corr=${correlationId} order=${orderId} session=${sessionId} pi=${paymentIntent ?? 'none'}`)
    return orderId
  }

  private async onCheckoutExpired(event: InboundWebhookEvent, correlationId: string): Promise<string | null> {
    const { orderId, sessionId } = event.data
    if (!orderId || !sessionId) return null

    await this.db.transaction(async (client) => {
      const order = await client.query(
        'SELECT * FROM store.orders WHERE id = $1 FOR UPDATE', [orderId],
      ).then(r => r.rows[0])

      // Guard: only reset if THIS session is still active (prevents old expiry overwriting new session)
      if (order?.payment_status !== PaymentStatus.CHECKOUT_CREATED || order?.stripe_session_id !== sessionId) {
        this.logger.log(`[webhook] corr=${correlationId} Expiry skipped for ${orderId} — session mismatch`)
        return
      }

      await this.applyOrderTransition(client, {
        orderId, expectedVersion: order.version,
        newPaymentStatus: null, stripeSessionId: null, stripePaymentIntent: null,
      })
      await client.query(
        'UPDATE store.payment_checkout_sessions SET status=$1, updated_at=NOW() WHERE stripe_session_id=$2',
        [SessionStatus.EXPIRED, sessionId],
      )
      await this.ledger.append({
        orderId, userId: order.user_id, entryType: 'checkout_expired',
        amountCents: 0, currency: 'usd',
        previousStatus: PaymentStatus.CHECKOUT_CREATED, newStatus: 'none',
        stripeObjectId: sessionId, stripeEventId: event.eventId, correlationId,
      }, client)

      await this.outbox.enqueue({
        eventType: 'CheckoutExpired', aggregateId: orderId, correlationId,
        payload: { orderId, sessionId },
      }, client)
    })

    this.logger.log(`[checkout_expired] corr=${correlationId} order=${orderId} session=${sessionId}`)
    return orderId
  }

  private async onPaymentIntentFailed(event: InboundWebhookEvent, correlationId: string): Promise<string | null> {
    const { paymentIntent, failureReason } = event.data
    if (!paymentIntent) return null

    let order = await this.db.queryOne<any>(
      'SELECT * FROM store.orders WHERE stripe_payment_intent = $1', [paymentIntent],
    )
    if (!order) {
      // Fallback: lookup via checkout_sessions (PI may not be set on order yet)
      order = await this.db.queryOne<any>(
        `SELECT o.* FROM store.orders o
         JOIN store.payment_checkout_sessions pcs ON pcs.order_id = o.id
         WHERE pcs.stripe_payment_intent = $1`, [paymentIntent],
      )
    }
    if (!order) { this.logger.warn(`[webhook] corr=${correlationId} No order for PI ${paymentIntent}`); return null }
    if (order.payment_status === PaymentStatus.SUCCEEDED) return order.id

    await this.db.transaction(async (client) => {
      const locked = await client.query(
        'SELECT * FROM store.orders WHERE id = $1 FOR UPDATE', [order.id],
      ).then(r => r.rows[0])

      if (!this.stateMachine.canTransition(locked.payment_status, PaymentStatus.FAILED)) return

      await this.applyOrderTransition(client, {
        orderId: order.id, expectedVersion: locked.version,
        newPaymentStatus: PaymentStatus.FAILED,
        stripeSessionId: locked.stripe_session_id, stripePaymentIntent: paymentIntent,
        timeline: [...(locked.timeline ?? []), { status: 'payment_failed', timestamp: new Date(), note: failureReason ?? 'Payment failed' }],
      })
      await this.ledger.append({
        orderId: order.id, userId: order.user_id, entryType: 'payment_failed',
        amountCents: 0, currency: 'usd',
        previousStatus: locked.payment_status, newStatus: PaymentStatus.FAILED,
        stripeObjectId: paymentIntent, stripeEventId: event.eventId, correlationId,
        metadata: { failureReason },
      }, client)
      await this.outbox.enqueue({
        eventType: 'PaymentFailed', aggregateId: order.id, correlationId,
        payload: { orderId: order.id, reason: failureReason, paymentIntent },
      }, client)
    })

    this.logger.log(`[payment_failed] corr=${correlationId} order=${order.id} pi=${paymentIntent}`)
    return order.id
  }

  private async onChargeRefunded(event: InboundWebhookEvent, correlationId: string): Promise<string | null> {
    const { paymentIntent, refundAmount, refunded, currency } = event.data
    if (!paymentIntent) return null

    const order = await this.db.queryOne<any>(
      'SELECT * FROM store.orders WHERE stripe_payment_intent = $1', [paymentIntent],
    )
    if (!order) return null

    const newStatus = refunded ? PaymentStatus.REFUNDED : PaymentStatus.PENDING_REFUND

    await this.db.transaction(async (client) => {
      const locked = await client.query(
        'SELECT * FROM store.orders WHERE id = $1 FOR UPDATE', [order.id],
      ).then(r => r.rows[0])

      if (!this.stateMachine.canTransition(locked.payment_status, newStatus)) return

      await this.applyOrderTransition(client, {
        orderId: order.id, expectedVersion: locked.version, newPaymentStatus: newStatus,
        stripeSessionId: locked.stripe_session_id, stripePaymentIntent: paymentIntent,
      })
      await this.ledger.append({
        orderId: order.id, userId: order.user_id,
        entryType: refunded ? 'refund_issued' : 'refund_partial',
        amountCents: refundAmount ?? 0, currency: currency ?? 'usd',
        previousStatus: locked.payment_status, newStatus,
        stripeObjectId: paymentIntent, stripeEventId: event.eventId, correlationId,
      }, client)
      await this.outbox.enqueue({
        eventType: 'RefundIssued', aggregateId: order.id, correlationId,
        payload: { orderId: order.id, refundAmount, currency, refunded },
      }, client)
    })

    this.logger.log(`[charge_refunded] corr=${correlationId} order=${order.id} refunded=${refunded}`)
    return order.id
  }

  private async onDisputeCreated(event: InboundWebhookEvent, correlationId: string): Promise<void> {
    this.logger.warn(
      `[dispute_created] corr=${correlationId} pi=${event.data.paymentIntent} ` +
      `reason=${event.data.disputeReason} — REQUIRES MANUAL REVIEW`,
    )
    // Future: emit to PagerDuty/Slack via outbox
  }

  // ── Order state mutation — single authoritative method ────────────────────

  private async applyOrderTransition(
    client: PoolClient,
    params: {
      orderId:             string
      expectedVersion:     number
      newPaymentStatus:    PaymentStatus | null
      newOrderStatus?:     string
      stripeSessionId:     string | null
      stripePaymentIntent: string | null
      timeline?:           any[]
    },
  ): Promise<void> {
    const result = await client.query(
      `UPDATE store.orders
       SET payment_status        = $1,
           status                = COALESCE($2, status),
           stripe_session_id     = $3,
           stripe_payment_intent = $4,
           timeline              = COALESCE($5::jsonb, timeline),
           version               = version + 1,
           updated_at            = NOW()
       WHERE id = $6 AND version = $7
       RETURNING id, version`,
      [
        params.newPaymentStatus, params.newOrderStatus ?? null,
        params.stripeSessionId, params.stripePaymentIntent,
        params.timeline ? JSON.stringify(params.timeline) : null,
        params.orderId, params.expectedVersion,
      ],
    )

    if (result.rowCount === 0) {
      throw new Error(
        `Optimistic concurrency conflict on order ${params.orderId} ` +
        `(expected version ${params.expectedVersion}). Concurrent modification detected.`,
      )
    }
  }

  // ── Two-phase webhook event claim ─────────────────────────────────────────

  private async claimEvent(event: InboundWebhookEvent, correlationId: string): Promise<boolean> {
    const inserted = await this.db.queryOne<{ id: string }>(
      `INSERT INTO store.payment_events
         (stripe_event_id, event_type, object_id, raw_payload, processing_status, processing_claimed_at)
       VALUES ($1,$2,$3,$4,'processing',NOW())
       ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id`,
      [event.eventId, event.eventType, event.objectId, JSON.stringify(event.rawPayload)],
    )
    if (inserted) return true

    const existing = await this.db.queryOne<{ processing_status: string }>(
      'SELECT processing_status FROM store.payment_events WHERE stripe_event_id = $1',
      [event.eventId],
    )
    if (!existing) return false
    if (['processed', 'skipped'].includes(existing.processing_status)) {
      this.logger.log(`[webhook] corr=${correlationId} Duplicate ${event.eventId} (${existing.processing_status}) — skip`)
      return false
    }
    if (existing.processing_status === 'processing') {
      this.logger.log(`[webhook] corr=${correlationId} Event ${event.eventId} already processing — skip`)
      return false
    }
    // Re-claim failed event (allows retry on transient failures)
    const reclaimed = await this.db.queryOne<{ id: string }>(
      `UPDATE store.payment_events
       SET processing_status='processing', processing_claimed_at=NOW(),
           error_message=NULL, processed_at=NULL
       WHERE stripe_event_id=$1 AND processing_status='failed' RETURNING id`,
      [event.eventId],
    )
    if (reclaimed) { this.logger.log(`[webhook] corr=${correlationId} Re-claiming failed event ${event.eventId}`); return true }
    return false
  }

  // ── Reconciliation API ────────────────────────────────────────────────────

  async getStuckCheckoutOrders(thresholdMinutes = 35): Promise<any[]> {
    return this.db.query<any>(
      `SELECT o.id AS order_id, o.user_id, o.stripe_session_id, o.updated_at, o.version,
              pcs.amount_cents, pcs.currency
       FROM store.orders o
       JOIN store.payment_checkout_sessions pcs ON pcs.stripe_session_id = o.stripe_session_id
       WHERE o.payment_status = $1
         AND o.updated_at < NOW() - ($2 || ' minutes')::INTERVAL
         AND pcs.status = 'pending'`,
      [PaymentStatus.CHECKOUT_CREATED, String(thresholdMinutes)],
    )
  }

  async reconcileOrder(orderId: string, stripeSessionId: string, correlationId: string): Promise<void> {
    this.logger.log(`[reconcile] corr=${correlationId} order=${orderId} session=${stripeSessionId}`)
    const session = await this.provider.retrieveSession(stripeSessionId)

    if (session.paymentStatus === 'paid') {
      this.logger.log(`[reconcile] corr=${correlationId} order=${orderId} paid in Stripe — applying missed event`)
      await this.onCheckoutCompleted({
        eventId:   `reconcile_${orderId}_${Date.now()}`,
        eventType: 'checkout.session.completed',
        objectId:  session.sessionId,
        livemode:  true,
        data: {
          orderId, sessionId: session.sessionId,
          paymentIntent: session.paymentIntent,
          amountTotal:   session.amountTotal,
          currency:      session.currency,
          userId:        session.metadata?.user_id,
        },
        rawPayload: session,
      }, correlationId)
    } else if (session.status === 'expired') {
      await this.onCheckoutExpired({
        eventId: `reconcile_expire_${orderId}_${Date.now()}`,
        eventType: 'checkout.session.expired',
        objectId: session.sessionId, livemode: true,
        data: { orderId, sessionId: session.sessionId },
        rawPayload: session,
      }, correlationId)
    } else {
      this.logger.log(`[reconcile] corr=${correlationId} order=${orderId} status=${session.status} — no action`)
    }
  }
}
