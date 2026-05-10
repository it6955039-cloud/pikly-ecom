// src/payments/state-machine/payment.state-machine.ts
//
// Deterministic, centralized payment state machine.
//
// All payment status transitions MUST go through this engine.
// No direct string comparisons in business logic.
//
// Design:
//   * Explicit transition map — only listed transitions are legal
//   * Terminal states cannot transition to anything
//   * Every transition is validated atomically before DB write
//   * Engine is stateless — safe as a singleton provider

import { Injectable, Logger } from '@nestjs/common'

// ── Canonical payment status values ──────────────────────────────────────────

export const PaymentStatus = {
  CHECKOUT_CREATED: 'checkout_created',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  PENDING_REFUND: 'pending_refund',
  REFUNDED: 'refunded',
} as const
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus]

export type PaymentStatusOrNull = PaymentStatus | null

// ── Transition map ────────────────────────────────────────────────────────────
// Key:   from state (null = initial, no payment status yet)
// Value: set of legal target states
//
// Transitions are designed to be:
//   * Retry-safe:  same transition applied twice = no change on second application
//   * Replay-safe: processing same event twice does not corrupt state
//   * Explicit:    any transition not listed here is ILLEGAL

const TRANSITION_MAP: Map<PaymentStatusOrNull, Set<PaymentStatusOrNull>> = new Map<
  PaymentStatusOrNull,
  Set<PaymentStatusOrNull>
>([
  // Initial state: no payment attempted
  [
    null,
    new Set<PaymentStatusOrNull>([
      PaymentStatus.CHECKOUT_CREATED, // user initiates checkout
    ]),
  ],

  // Checkout session active: user redirected to payment page
  [
    PaymentStatus.CHECKOUT_CREATED,
    new Set<PaymentStatusOrNull>([
      PaymentStatus.SUCCEEDED, // webhook: checkout.session.completed
      PaymentStatus.FAILED, // webhook: payment_intent.payment_failed
      PaymentStatus.CANCELLED, // user cancelled
      null, // session expired → allow new session
    ]),
  ],

  // Payment succeeded: money received
  [
    PaymentStatus.SUCCEEDED,
    new Set<PaymentStatusOrNull>([
      PaymentStatus.PENDING_REFUND, // refund requested
      PaymentStatus.REFUNDED, // full refund immediately confirmed
    ]),
  ],

  // Payment failed: user can retry
  [
    PaymentStatus.FAILED,
    new Set<PaymentStatusOrNull>([
      PaymentStatus.CHECKOUT_CREATED, // user retries with new session
    ]),
  ],

  // Refund in-flight — multiple partial refunds are valid in Stripe
  [
    PaymentStatus.PENDING_REFUND,
    new Set<PaymentStatusOrNull>([
      PaymentStatus.PENDING_REFUND, // additional partial refund received
      PaymentStatus.REFUNDED, // full refund confirmed
    ]),
  ],

  // Terminal states — no further transitions
  [PaymentStatus.REFUNDED, new Set<PaymentStatusOrNull>([])],
  [PaymentStatus.CANCELLED, new Set<PaymentStatusOrNull>([])],
])

// ── Transition result ─────────────────────────────────────────────────────────

export type TransitionResult = { ok: true } | { ok: false; code: string; message: string }

// ── State Machine Engine ──────────────────────────────────────────────────────

@Injectable()
export class PaymentStateMachine {
  private readonly logger = new Logger(PaymentStateMachine.name)

  /**
   * Check whether a transition is legal without throwing.
   * Use for soft guards where you want to log-and-skip rather than throw.
   */
  canTransition(from: PaymentStatusOrNull, to: PaymentStatusOrNull): boolean {
    const allowed = TRANSITION_MAP.get(from)
    if (!allowed) return false
    return allowed.has(to)
  }

  /**
   * Assert a transition is legal. Throws with structured error if not.
   * Use before every DB state mutation — this is the hard guard.
   *
   * @param context - human-readable context string for error logs (e.g. order ID)
   */
  assertTransition(from: PaymentStatusOrNull, to: PaymentStatusOrNull, context: string): void {
    if (this.canTransition(from, to)) return

    const allowed = TRANSITION_MAP.get(from)
    const allowedStr = allowed
      ? [...allowed].map((s) => s ?? 'null').join(', ')
      : '(state not in machine)'

    const message =
      `Illegal payment transition [${context}]: ` +
      `"${from ?? 'null'}" → "${to ?? 'null'}". ` +
      `Allowed from "${from ?? 'null'}": [${allowedStr}]`

    this.logger.error(`[state_machine] ${message}`)

    throw new IllegalTransitionError(message, {
      from: from ?? null,
      to: to ?? null,
      allowed: allowed ? [...allowed] : [],
      context,
    })
  }

  /**
   * Idempotency check: is the target state already the current state?
   * If so, the event has already been applied — safe to skip (replay protection).
   */
  isAlreadyInState(current: PaymentStatusOrNull, target: PaymentStatusOrNull): boolean {
    return current === target
  }

  /**
   * Is the current state a terminal state?
   * Terminal states accept NO further transitions.
   */
  isTerminal(status: PaymentStatusOrNull): boolean {
    if (status === null) return false
    const allowed = TRANSITION_MAP.get(status)
    return allowed !== undefined && allowed.size === 0
  }

  /**
   * Get all legal transitions from a given state.
   * Used for admin tooling and diagnostic endpoints.
   */
  allowedTransitions(from: PaymentStatusOrNull): PaymentStatusOrNull[] {
    const allowed = TRANSITION_MAP.get(from)
    return allowed ? [...allowed] : []
  }
}

// ── Custom error for illegal transitions ─────────────────────────────────────

export class IllegalTransitionError extends Error {
  constructor(
    message: string,
    public readonly context: {
      from: PaymentStatusOrNull
      to: PaymentStatusOrNull
      allowed: PaymentStatusOrNull[]
      context: string
    },
  ) {
    super(message)
    this.name = 'IllegalTransitionError'
  }
}
