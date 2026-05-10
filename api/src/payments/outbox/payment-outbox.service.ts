// src/payments/outbox/payment-outbox.service.ts
//
// Write side of the transactional payment outbox.
//
// MUST be called within the same DB transaction as the order state mutation.
// Guarantees: either the order mutation AND the outbox event both commit, or neither does.
// Side effects (email, fulfillment, analytics) are delivered at-least-once by the processor.

import { Injectable, Logger } from '@nestjs/common'
import { PoolClient }         from 'pg'
import { DatabaseService }    from '../../database/database.service'

export type PaymentOutboxEventType =
  | 'PaymentSucceeded'
  | 'PaymentFailed'
  | 'FulfillmentRequested'
  | 'CheckoutExpired'
  | 'RefundIssued'
  | 'DisputeOpened'

export interface EnqueueOutboxEventParams {
  eventType:     PaymentOutboxEventType
  aggregateId:   string   // order_id
  payload:       Record<string, unknown>
  correlationId: string
  /** Max retry attempts before dead-lettering (default: 5) */
  maxAttempts?:  number
  /** Delay before first attempt in seconds (default: 0) */
  delaySeconds?: number
}

@Injectable()
export class PaymentOutboxService {
  private readonly logger = new Logger(PaymentOutboxService.name)

  constructor(private readonly db: DatabaseService) {}

  /**
   * Write an outbox event.
   * Pass the transaction client to guarantee atomicity with the order state mutation.
   */
  async enqueue(params: EnqueueOutboxEventParams, client: PoolClient): Promise<void> {
    const nextAttemptAt = params.delaySeconds
      ? new Date(Date.now() + params.delaySeconds * 1000)
      : new Date()

    await client.query(
      `INSERT INTO store.payment_outbox
         (event_type, aggregate_id, payload, correlation_id, max_attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        params.eventType,
        params.aggregateId,
        JSON.stringify(params.payload),
        params.correlationId,
        params.maxAttempts ?? 5,
        nextAttemptAt,
      ],
    )

    this.logger.log(
      `[outbox_enqueued] corr=${params.correlationId} type=${params.eventType} ` +
      `aggregate=${params.aggregateId}`,
    )
  }
}
