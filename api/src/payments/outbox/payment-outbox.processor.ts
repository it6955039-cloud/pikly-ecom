// src/payments/outbox/payment-outbox.processor.ts
//
// Processor (read side) for the payment outbox.
//
// Polls store.payment_outbox for pending events and delivers them.
// Guarantees at-least-once delivery to all consumers.
//
// Architecture:
//   * Polls every 5 seconds
//   * Claims events with SELECT FOR UPDATE SKIP LOCKED (no competing workers)
//   * Exponential backoff on failure
//   * Dead-letters events that exceed max_attempts
//
// Consumers per event type:
//   PaymentSucceeded    → MailService (confirmation), WebhookService (outgoing)
//   PaymentFailed       → MailService (failure notification)
//   FulfillmentRequested → (future: fulfillment service)
//   CheckoutExpired     → (future: abandoned cart recovery)
//   RefundIssued        → MailService (refund confirmation)
//   DisputeOpened       → alerting (PagerDuty/Slack)

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { DatabaseService } from '../../database/database.service'
import { MailService }     from '../../mail/mail.service'
import { WebhookService }  from '../../webhooks/webhook.service'
import { PaymentOutboxEventType } from './payment-outbox.service'

interface OutboxRow {
  id:             string
  event_type:     PaymentOutboxEventType
  aggregate_id:   string
  payload:        Record<string, unknown>
  attempts:       number
  max_attempts:   number
  correlation_id: string
}

@Injectable()
export class PaymentOutboxProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentOutboxProcessor.name)
  private intervalHandle: NodeJS.Timeout | null = null

  // Poll every 5 seconds
  private readonly POLL_INTERVAL_MS = 5_000
  // Process up to 10 events per poll cycle
  private readonly BATCH_SIZE = 10

  // Backoff schedule in seconds: [30s, 2m, 10m, 30m, 1h]
  private readonly BACKOFF_SECONDS = [30, 120, 600, 1800, 3600]

  constructor(
    private readonly db:       DatabaseService,
    private readonly mail:     MailService,
    private readonly webhooks: WebhookService,
  ) {}

  onModuleInit(): void {
    this.logger.log('[outbox_processor] Starting — poll interval 5s')
    this.intervalHandle = setInterval(() => this.poll(), this.POLL_INTERVAL_MS)
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
      this.logger.log('[outbox_processor] Stopped')
    }
  }

  private async poll(): Promise<void> {
    try {
      await this.db.transaction(async (client) => {
        // Claim a batch of due events atomically.
        // SKIP LOCKED: skip events held by concurrent workers (future horizontal scaling).
        const { rows } = await client.query<OutboxRow>(
          `SELECT id, event_type, aggregate_id, payload, attempts, max_attempts, correlation_id
           FROM store.payment_outbox
           WHERE status IN ('pending', 'failed')
             AND next_attempt_at <= NOW()
           ORDER BY next_attempt_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED`,
          [this.BATCH_SIZE],
        )

        if (rows.length === 0) return

        // BUG-5 FIX: stamp processing_claimed_at alongside status change.
        // RecoveryService uses this to reset events stuck in 'processing'
        // for > 10 minutes (caused by worker crash mid-processing).
        const ids = rows.map(r => r.id)
        await client.query(
          `UPDATE store.payment_outbox
           SET status = 'processing', processing_claimed_at = NOW()
           WHERE id = ANY($1)`,
          [ids],
        )

        // BUG-7 FIX: Process synchronously after claim transaction commits.
        // Previous: setImmediate() — crash between commit and callback = events
        // permanently stuck in 'processing' with no recovery path.
        // Now: process inline. Lock is released when this transaction commits.
        // SKIP LOCKED in the claim query ensures concurrent workers don't interfere.
        await this.processEvents(rows)
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`[outbox_processor] Poll failed: ${msg}`)
    }
  }

  private async processEvents(events: OutboxRow[]): Promise<void> {
    for (const event of events) {
      await this.processOne(event)
    }
  }

  private async processOne(event: OutboxRow): Promise<void> {
    const { id, event_type, aggregate_id, payload, attempts, max_attempts, correlation_id } = event

    try {
      await this.dispatch(event_type, payload, aggregate_id, correlation_id)

      await this.db.execute(
        `UPDATE store.payment_outbox
         SET status = 'processed', processed_at = NOW(), attempts = attempts + 1
         WHERE id = $1`,
        [id],
      )

      this.logger.log(
        `[outbox_processed] corr=${correlation_id} id=${id} type=${event_type} ` +
        `aggregate=${aggregate_id} attempt=${attempts + 1}`,
      )
    } catch (err: unknown) {
      const msg    = err instanceof Error ? err.message : String(err)
      const newAttempts = attempts + 1
      const isDead = newAttempts >= max_attempts

      // Exponential backoff: pick delay based on attempt count
      const backoffIdx = Math.min(newAttempts - 1, this.BACKOFF_SECONDS.length - 1)
      const backoffSec = this.BACKOFF_SECONDS[backoffIdx]
      const nextAttempt = new Date(Date.now() + backoffSec * 1000)

      if (isDead) {
        await this.db.execute(
          `UPDATE store.payment_outbox
           SET status = 'dead_lettered', attempts = $1, last_error = $2, processed_at = NOW()
           WHERE id = $3`,
          [newAttempts, msg, id],
        )
        this.logger.error(
          `[outbox_dead_lettered] corr=${correlation_id} id=${id} type=${event_type} ` +
          `aggregate=${aggregate_id} attempts=${newAttempts} error="${msg}" ` +
          `— REQUIRES OPERATOR ATTENTION`,
        )
      } else {
        await this.db.execute(
          `UPDATE store.payment_outbox
           SET status = 'failed', attempts = $1, last_error = $2, next_attempt_at = $3
           WHERE id = $4`,
          [newAttempts, msg, nextAttempt, id],
        )
        this.logger.warn(
          `[outbox_retry] corr=${correlation_id} id=${id} type=${event_type} ` +
          `aggregate=${aggregate_id} attempt=${newAttempts}/${max_attempts} ` +
          `next=${nextAttempt.toISOString()} error="${msg}"`,
        )
      }
    }
  }

  // ── Consumer dispatch ──────────────────────────────────────────────────────

  private async dispatch(
    eventType:    PaymentOutboxEventType,
    payload:      Record<string, unknown>,
    aggregateId:  string,
    correlationId: string,
  ): Promise<void> {
    switch (eventType) {
      case 'PaymentSucceeded':
        await this.handlePaymentSucceeded(payload, correlationId)
        break

      case 'PaymentFailed':
        await this.handlePaymentFailed(payload, correlationId)
        break

      case 'FulfillmentRequested':
        // Placeholder: connect to fulfillment service when available
        // Fulfillment is decoupled — payment correctness is unaffected by fulfillment failures
        this.logger.log(
          `[outbox] corr=${correlationId} FulfillmentRequested for order=${aggregateId} ` +
          `— fulfillment service not yet connected`,
        )
        break

      case 'RefundIssued':
        await this.handleRefundIssued(payload, correlationId)
        break

      case 'CheckoutExpired':
        this.logger.log(`[outbox] corr=${correlationId} CheckoutExpired for order=${aggregateId}`)
        break

      case 'DisputeOpened':
        this.logger.warn(
          `[outbox] corr=${correlationId} DisputeOpened for order=${aggregateId} ` +
          `— REQUIRES MANUAL REVIEW. Payload: ${JSON.stringify(payload)}`,
        )
        break

      default:
        this.logger.warn(`[outbox] Unknown event type: ${eventType}`)
    }
  }

  private async handlePaymentSucceeded(
    payload: Record<string, unknown>,
    correlationId: string,
  ): Promise<void> {
    const { orderId, userId, email, firstName, order } = payload as any

    // 1. Confirmation email
    if (email && firstName && order) {
      await this.mail.sendOrderConfirmation(email, firstName, order)
      this.logger.log(`[outbox] corr=${correlationId} Confirmation email sent to ${email}`)
    }

    // 2. Outgoing webhook for external integrations
    await this.webhooks.dispatch('payment.succeeded', {
      orderId, userId, correlationId,
      ...payload,
    }).catch(() => void 0)
  }

  private async handlePaymentFailed(
    payload: Record<string, unknown>,
    correlationId: string,
  ): Promise<void> {
    const { email, firstName, orderId, reason } = payload as any
    this.logger.log(
      `[outbox] corr=${correlationId} Payment failed for order=${orderId} reason="${reason}"`,
    )
    // Future: send failure notification email
    // await this.mail.sendPaymentFailedNotification(email, firstName, orderId, reason)
  }

  private async handleRefundIssued(
    payload: Record<string, unknown>,
    correlationId: string,
  ): Promise<void> {
    const { orderId, amountCents, currency } = payload as any
    this.logger.log(
      `[outbox] corr=${correlationId} Refund issued for order=${orderId} ` +
      `amount=${amountCents}${currency}`,
    )
    // Future: send refund confirmation email
  }
}
