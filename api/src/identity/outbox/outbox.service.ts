/**
 * @file outbox.service.ts
 * @layer Infrastructure / Transactional Outbox
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ALL BUGS FIXED IN THIS FILE:
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  BUG-ONCONFLICT (HIGH) — enqueue() ON CONFLICT missing partial index predicate
 *    Root cause: The schema defines a PARTIAL unique index on identity_outbox:
 *
 *      CREATE UNIQUE INDEX idx_outbox_idempotency
 *        ON store.identity_outbox (aggregate_id, event_type)
 *        WHERE processed_at IS NULL;
 *
 *    The original enqueue() used:
 *
 *      ON CONFLICT (aggregate_id, event_type)   ← no WHERE predicate
 *      DO UPDATE SET ...
 *      WHERE store.identity_outbox.processed_at IS NULL  ← update filter only
 *
 *    PostgreSQL's ON CONFLICT inference looks for a matching unique constraint
 *    or index. For a PARTIAL unique index, the index predicate MUST be included
 *    in the ON CONFLICT specification. Without it, PostgreSQL may fail to infer
 *    the correct index and throw:
 *      "there is no unique or exclusion constraint matching the ON CONFLICT specification"
 *    — or, in lenient versions, silently fall back to a full-table scan which
 *    misses the idempotency guarantee entirely.
 *
 *    Fix: Added WHERE processed_at IS NULL to the ON CONFLICT specification.
 *    The update filter WHERE clause after DO UPDATE SET is kept separately as a
 *    safety guard (only update if the conflicting row is still unprocessed).
 *
 *    Correct SQL:
 *      ON CONFLICT (aggregate_id, event_type) WHERE processed_at IS NULL
 *      DO UPDATE SET ...
 *      WHERE store.identity_outbox.processed_at IS NULL
 *
 *  BUG-6 (HIGH) — fetchPending() SELECT FOR UPDATE SKIP LOCKED auto-commit bug
 *    Root cause: db.query() uses pool.query() which runs in auto-commit mode.
 *    In PostgreSQL, FOR UPDATE row locks are only held for the duration of the
 *    enclosing transaction. Auto-commit means each statement is its own
 *    transaction → locks released immediately after SELECT returns → two
 *    OutboxProcessorService instances in multi-instance deployments (Railway)
 *    can pick up the same records despite SKIP LOCKED.
 *
 *    Fix: Replaced SELECT FOR UPDATE with an atomic CTE UPDATE pattern:
 *
 *      WITH claimed AS (
 *        SELECT id FROM store.identity_outbox WHERE ... FOR UPDATE SKIP LOCKED
 *      )
 *      UPDATE store.identity_outbox
 *      SET next_retry_at = NOW() + INTERVAL '5 minutes'
 *      FROM claimed WHERE o.id = claimed.id
 *      RETURNING *
 *
 *    The CTE + UPDATE is ONE SQL statement → one auto-commit transaction. The
 *    FOR UPDATE lock is acquired and immediately used by the UPDATE in the same
 *    statement. Two concurrent callers physically cannot claim the same rows:
 *    the first UPDATE modifies the row, changing next_retry_at to a future
 *    value; the second caller's CTE SELECT sees next_retry_at > NOW() and
 *    skips those rows via the WHERE filter.
 *
 *    The 5-minute next_retry_at acts as a "claimed / in-progress" marker:
 *    - markProcessed() sets processed_at → record excluded from future polls.
 *    - markFailed() overwrites next_retry_at with proper exponential backoff.
 *    - Crash recovery: if the processor crashes mid-batch, the 5-minute window
 *      expires and the records become eligible again (up to 5 attempts total).
 *    No schema changes required — next_retry_at already exists.
 */

import { Injectable, Logger } from '@nestjs/common'
import { DatabaseService } from '../../database/database.service'
import { OutboxEventTypeSchema } from '../schemas/identity.schemas'
import { z } from 'zod'

const EnqueueParamsSchema = z.object({
  eventType: OutboxEventTypeSchema,
  aggregateId: z.string().uuid(),
  externalId: z.string().min(1),
  payload: z.record(z.unknown()),
})

type EnqueueParams = z.infer<typeof EnqueueParamsSchema>

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name)

  constructor(private readonly db: DatabaseService) {}

  /**
   * Write an event to the outbox.
   *
   * MUST be called within a transaction that also writes the domain state for
   * full atomicity. If called outside a transaction it still works but loses
   * the dual-write safety guarantee.
   *
   * BUG-ONCONFLICT FIX: ON CONFLICT now includes WHERE processed_at IS NULL
   * to match the partial unique index definition on (aggregate_id, event_type).
   */
  async enqueue(params: EnqueueParams): Promise<void> {
    const validated = EnqueueParamsSchema.parse(params)

    await this.db.execute(
      `INSERT INTO store.identity_outbox
         (event_type, aggregate_id, external_id, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (aggregate_id, event_type) WHERE processed_at IS NULL
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
   * Atomically claim and return unprocessed outbox records.
   *
   * BUG-6 FIX: Uses an atomic CTE UPDATE pattern instead of the broken
   * SELECT FOR UPDATE SKIP LOCKED via db.query() (auto-commit).
   *
   * Two concurrent calls cannot claim the same records:
   *   1. First caller's CTE selects rows A, B, C and locks them.
   *   2. First caller's UPDATE sets next_retry_at = NOW() + 5min for A, B, C.
   *   3. Second caller's CTE runs: A, B, C now have next_retry_at > NOW(),
   *      so they're excluded by the WHERE filter. No collision.
   */
  async fetchPending(batchSize = 50): Promise<
    Array<{
      id: string
      eventType: string
      aggregateId: string
      externalId: string
      payload: Record<string, unknown>
      attempts: number
    }>
  > {
    // BUG-6 FIX: atomic CTE UPDATE — claim and mark in one statement
    const rows = await this.db.query<any>(
      `WITH claimed AS (
         SELECT id
         FROM store.identity_outbox
         WHERE processed_at IS NULL
           AND (next_retry_at IS NULL OR next_retry_at <= NOW())
           AND attempts < 5
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE store.identity_outbox o
       SET next_retry_at = NOW() + INTERVAL '5 minutes',
           updated_at    = NOW()
       FROM claimed
       WHERE o.id = claimed.id
       RETURNING o.id,
                 o.event_type,
                 o.aggregate_id,
                 o.external_id,
                 o.payload,
                 o.attempts`,
      [batchSize],
    )

    return rows.map((r: any) => ({
      id: r.id as string,
      eventType: r.event_type as string,
      aggregateId: r.aggregate_id as string,
      externalId: r.external_id as string,
      payload:
        typeof r.payload === 'string'
          ? (JSON.parse(r.payload) as Record<string, unknown>)
          : (r.payload as Record<string, unknown>),
      attempts: r.attempts as number,
    }))
  }

  /**
   * Mark a record as successfully processed.
   * Sets processed_at — the record will never be polled again by fetchPending().
   */
  async markProcessed(id: string): Promise<void> {
    await this.db.execute(
      `UPDATE store.identity_outbox
       SET processed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id],
    )
  }

  /**
   * Record a processing failure with exponential backoff.
   * next_retry_at = NOW() + 2^attempts seconds  (1s, 2s, 4s, 8s, 16s).
   *
   * This overwrites the "in-progress" next_retry_at set by fetchPending(),
   * scheduling the record for a proper backoff retry instead of the 5-minute
   * processing window. After 5 attempts the record is abandoned (fetchPending
   * filters attempts < 5).
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
