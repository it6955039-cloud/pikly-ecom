// src/payments/ledger/payment.ledger.service.ts
//
// Immutable payment ledger.
//
// Every payment state transition writes an append-only ledger entry
// IN THE SAME DB TRANSACTION as the order state mutation.
//
// Records are NEVER updated or deleted.
// This is the source of truth for:
//   * financial audits
//   * reconciliation
//   * dispute resolution
//   * incident forensics
//
// Analogy: double-entry bookkeeping. Every financial event is recorded
// regardless of what the mutable order row says.

import { Injectable, Logger } from '@nestjs/common'
import { PoolClient }         from 'pg'
import { DatabaseService }    from '../../database/database.service'

export type LedgerEntryType =
  | 'checkout_initiated'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'payment_cancelled'
  | 'refund_issued'
  | 'refund_partial'
  | 'dispute_opened'
  | 'checkout_expired'
  | 'reconciliation_correction'

export interface WriteLedgerParams {
  orderId:         string
  userId:          string
  entryType:       LedgerEntryType
  amountCents:     number
  currency:        string
  previousStatus:  string | null
  newStatus:       string
  stripeObjectId?: string
  stripeEventId?:  string
  correlationId:   string
  metadata?:       Record<string, unknown>
}

@Injectable()
export class PaymentLedgerService {
  private readonly logger = new Logger(PaymentLedgerService.name)

  constructor(private readonly db: DatabaseService) {}

  /**
   * Append a ledger entry.
   *
   * MUST be called within the same DB transaction that mutates order state.
   * Pass the transaction client (PoolClient) to guarantee atomicity.
   *
   * If no client is provided, writes in its own connection (use only for
   * reconciliation corrections that have no associated order mutation).
   */
  async append(params: WriteLedgerParams, client?: PoolClient): Promise<void> {
    const sql = `
      INSERT INTO store.payment_ledger
        (order_id, user_id, entry_type, amount_cents, currency,
         previous_status, new_status, stripe_object_id, stripe_event_id,
         correlation_id, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `

    const values = [
      params.orderId,
      params.userId,
      params.entryType,
      params.amountCents,
      params.currency,
      params.previousStatus,
      params.newStatus,
      params.stripeObjectId ?? null,
      params.stripeEventId  ?? null,
      params.correlationId,
      JSON.stringify(params.metadata ?? {}),
    ]

    if (client) {
      await client.query(sql, values)
    } else {
      await this.db.execute(sql, values)
    }

    this.logger.log(
      `[ledger] corr=${params.correlationId} order=${params.orderId} ` +
      `type=${params.entryType} ${params.previousStatus ?? 'null'} → ${params.newStatus} ` +
      `amount=${params.amountCents}${params.currency}`,
    )
  }

  /**
   * Read all ledger entries for an order.
   * Used for audit, debugging, and dispute resolution.
   */
  async getOrderHistory(orderId: string): Promise<any[]> {
    return this.db.query<any>(
      'SELECT * FROM store.payment_ledger WHERE order_id = $1 ORDER BY created_at ASC',
      [orderId],
    )
  }

  /**
   * Detect duplicate ledger entries for the same stripe_event_id.
   * If a ledger entry already exists for this event, the payment was already processed.
   * Used as an additional semantic idempotency check beyond event-level dedup.
   */
  async hasEntryForEvent(stripeEventId: string, entryType: LedgerEntryType): Promise<boolean> {
    const row = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM store.payment_ledger WHERE stripe_event_id = $1 AND entry_type = $2 LIMIT 1',
      [stripeEventId, entryType],
    )
    return row !== null
  }
}
