// src/payments/ports/payment-provider.port.ts
//
// Provider abstraction layer.
//
// The PaymentsService NEVER imports 'stripe' directly.
// All Stripe types are translated into provider-agnostic interfaces here.
//
// Adding Adyen, PayPal, or Razorpay means:
//   1. Write a new adapter implementing IPaymentProvider
//   2. Register it in PaymentsModule with a provider token
//   3. Zero changes to PaymentsService, ledger, state machine, or outbox

// ── Canonical provider-agnostic types ────────────────────────────────────────

export interface CreateSessionParams {
  /** Internal order ID — stored in session metadata for webhook resolution */
  orderId:        string
  userId:         string
  amountCents:    number
  currency:       string
  successUrl:     string
  cancelUrl:      string
  customerEmail?: string
  /**
   * Idempotency key for the provider API call.
   * Using orderId ensures: same order → same session on retry.
   */
  idempotencyKey: string
  description?:   string
}

export interface CheckoutSessionResult {
  sessionId:  string
  url:        string
  expiresAt:  Date
}

export interface RetrievedSession {
  sessionId:      string
  status:         'open' | 'complete' | 'expired'
  paymentStatus:  'no_payment_required' | 'paid' | 'unpaid'
  paymentIntent?: string
  amountTotal?:   number
  currency?:      string
  metadata:       Record<string, string>
}

export interface InboundWebhookEvent {
  /** Provider-assigned unique event ID — used as idempotency key */
  eventId:    string
  eventType:  string
  objectId:   string | null
  livemode:   boolean
  /** Normalized payload — PaymentsService uses this, never raw provider types */
  data: {
    orderId?:       string
    userId?:        string
    sessionId?:     string
    paymentIntent?: string
    amountTotal?:   number
    currency?:      string
    failureReason?: string
    refundAmount?:  number
    refunded?:      boolean
    disputeReason?: string
  }
  /** Raw payload preserved for audit/replay — do not use for business logic */
  rawPayload: unknown
}

// ── Abstract payment provider interface ──────────────────────────────────────

export abstract class IPaymentProvider {
  /** Human-readable provider name for logging and ledger entries */
  abstract readonly providerName: string

  /**
   * Create a hosted checkout session.
   * Returns a URL to redirect the user to for payment.
   */
  abstract createCheckoutSession(params: CreateSessionParams): Promise<CheckoutSessionResult>

  /**
   * Retrieve a session by ID — used for reconciliation polling.
   */
  abstract retrieveSession(sessionId: string): Promise<RetrievedSession>

  /**
   * Verify and normalize an inbound webhook event.
   * Throws if signature verification fails.
   * Returns provider-agnostic InboundWebhookEvent.
   */
  abstract constructWebhookEvent(rawBody: Buffer, signature: string): InboundWebhookEvent
}
