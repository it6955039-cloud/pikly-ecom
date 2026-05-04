/**
 * @file outbox.service.ts
 * @layer Infrastructure / Transactional Outbox
 *
 * Transactional Outbox Pattern Implementation
 *
 * Problem (Dual-Write):
 *   When we provision a user, we must:
 *     (a) Write to store.users + store.identity_mapping (PostgreSQL)
 *     (b) Emit an event for downstream consumers (Algolia index, mail, analytics)
 *
 *   If we write to DB and then emit the event in the same service call, we have
 *   a dual-write problem: the DB can succeed while the event bus fails, leaving
 *   downstream systems permanently inconsistent with no retry mechanism.
 *
 * Solution — Outbox Pattern:
 *   The event is written to store.identity_outbox IN THE SAME DATABASE
 *   TRANSACTION as the user record. This makes the "publish" step atomic with
 *   the domain write. A separate OutboxProcessor polls the outbox table and
 *   delivers events asynchronously with retry semantics.
 *
 * Consistency guarantee:
 *   Either both the user record AND the outbox event exist, or neither does.
 *   No split-brain states. The processor retries failed events with exponential
 *   backoff, ensuring at-least-once delivery to all downstream consumers.
 *
 * Schema: store.identity_outbox (see migration 002_identity_migration.sql)
 */

import { Injectable, Logger } from '@nestjs/common'
import { DatabaseService } from '../../database/database.service'
import { OutboxEventTypeSchema } from '../schemas/identity.schemas'
import { z } from 'zod'

const EnqueueParamsSchema = z.object({
  eventType:   OutboxEventTypeSchema,
  aggregateId: z.string().uuid(),
  externalId:  z.string().min(1),
  payload:     z.record(z.unknown()),
})

type EnqueueParams = z.infer<typeof EnqueueParamsSchema>

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name)

  constructor(private readonly db: DatabaseService) {}

  /**
   * Write an event to the outbox.
   *
   * MUST be called within a transaction that also writes the domain state.
   * If called outside a transaction, it still works but loses atomicity.
   *
   * Idempotency: Uses (aggregate_id, event_type, external_id) composite
   * uniqueness so duplicate JIT calls don't create duplicate outbox entries.
   */
  async enqueue(params: EnqueueParams): Promise<void> {
    const validated = EnqueueParamsSchema.parse(params)

    await this.db.execute(
      `INSERT INTO store.identity_outbox
         (event_type, aggregate_id, external_id, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (aggregate_id, event_type)
         DO UPDATE SET
           payload    = EXCLUDED.payload,
           attempts   = 0,
           last_error = NULL,
           updated_at = NOW()
       WHERE store.identity_outbox.processed_at IS NULL`,
      [
        validated.eventType,
        validated.aggregateId,
        validated.externalId,
        JSON.stringify(validated.payload),
      ],
    )
  }

  /**
   * Fetch unprocessed outbox records — called by OutboxProcessorService.
   * Limits to batchSize records, ordered by creation time (FIFO).
   * Uses SELECT FOR UPDATE SKIP LOCKED for safe concurrent processor instances.
   */
  async fetchPending(batchSize = 50): Promise<Array<{
    id:          string
    eventType:   string
    aggregateId: string
    externalId:  string
    payload:     Record<string, unknown>
    attempts:    number
  }>> {
    const rows = await this.db.query<any>(
      `SELECT id, event_type, aggregate_id, external_id, payload, attempts
       FROM store.identity_outbox
       WHERE processed_at IS NULL
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
         AND attempts < 5
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize],
    )

    return rows.map((r) => ({
      id:          r.id,
      eventType:   r.event_type,
      aggregateId: r.aggregate_id,
      externalId:  r.external_id,
      payload:     typeof r.payload === 'string'
        ? JSON.parse(r.payload)
        : r.payload,
      attempts:    r.attempts,
    }))
  }

  /** Mark a record as successfully processed */
  async markProcessed(id: string): Promise<void> {
    await this.db.execute(
      `UPDATE store.identity_outbox
       SET processed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id],
    )
  }

  /**
   * Record a processing failure.
   * Implements exponential backoff: next_retry_at = NOW() + 2^attempts seconds.
   * After 5 attempts the record is abandoned (fetchPending filters attempts < 5).
   */
  async markFailed(id: string, error: string): Promise<void> {
    await this.db.execute(
      `UPDATE store.identity_outbox
       SET attempts      = attempts + 1,
           last_error    = $2,
           next_retry_at = NOW() + (INTERVAL '1 second' * POWER(2, attempts)),
           updated_at    = NOW()
       WHERE id = $1`,
      [id, error.slice(0, 1000)],
    )
  }
}
