// src/payments/types/payment.types.ts
//
// Shared enums used across the payments module.
// PaymentStatus and the state machine live in state-machine/payment.state-machine.ts.
// This file holds supporting types that don't belong to the state machine engine.

export const SessionStatus = {
  PENDING:   'pending',
  COMPLETED: 'completed',
  EXPIRED:   'expired',
  CANCELLED: 'cancelled',
} as const

export type SessionStatus = typeof SessionStatus[keyof typeof SessionStatus]
