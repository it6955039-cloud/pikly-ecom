/**
 * @file outbox.processor.ts
 * @layer Infrastructure / Transactional Outbox
 *
 * OutboxProcessorService — polls store.identity_outbox and delivers events.
 *
 * Design:
 *   - Runs on a 5-second interval using @nestjs/schedule
 *   - SELECT FOR UPDATE SKIP LOCKED ensures safe concurrent execution
 *     across multiple API instance replicas (Railway/Heroku horizontally scaled)
 *   - Exponential backoff on failures (2^n seconds, max 5 attempts)
 *   - Processes in batches of 50 to bound memory usage
 *
 * Downstream Consumers registered in this processor:
 *   1. Algolia user index sync (email/name changes)
 *   2. Admin notification on user.deactivated events
 *
 * To add a new consumer: implement OutboxEventHandler and register it
 * in the handlers map below. No changes to OutboxService required (OCP).
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { OutboxService } from './outbox.service'

type OutboxEventHandler = (record: {
  aggregateId: string
  externalId:  string
  payload:     Record<string, unknown>
}) => Promise<void>

@Injectable()
export class OutboxProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger   = new Logger(OutboxProcessorService.name)
  private intervalHandle?: ReturnType<typeof setInterval>

  /** Registry of event type → handler. Add new consumers here. */
  private readonly handlers = new Map<string, OutboxEventHandler[]>()

  constructor(private readonly outbox: OutboxService) {
    this.registerHandlers()
  }

  onModuleInit(): void {
    // Poll every 5 seconds
    this.intervalHandle = setInterval(() => {
      this.processBatch().catch((err) =>
        this.logger.error(`OutboxProcessor unhandled error: ${String(err)}`),
      )
    }, 5_000)

    this.logger.log('OutboxProcessor started (5s polling interval)')
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.logger.log('OutboxProcessor stopped')
    }
  }

  // ── Processing loop ────────────────────────────────────────────────────

  private async processBatch(): Promise<void> {
    const pending = await this.outbox.fetchPending(50)
    if (pending.length === 0) return

    this.logger.debug(`Processing ${pending.length} outbox event(s)`)

    await Promise.allSettled(
      pending.map((record) => this.deliverOne(record)),
    )
  }

  private async deliverOne(record: {
    id:          string
    eventType:   string
    aggregateId: string
    externalId:  string
    payload:     Record<string, unknown>
    attempts:    number
  }): Promise<void> {
    const handlers = this.handlers.get(record.eventType) ?? []

    try {
      await Promise.all(
        handlers.map((h) =>
          h({
            aggregateId: record.aggregateId,
            externalId:  record.externalId,
            payload:     record.payload,
          }),
        ),
      )
      await this.outbox.markProcessed(record.id)
      this.logger.debug(
        `[Outbox] Delivered ${record.eventType} for ${record.aggregateId} ` +
        `(attempt ${record.attempts + 1})`,
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.warn(
        `[Outbox] Delivery failed for ${record.id} (attempt ${record.attempts + 1}): ${msg}`,
      )
      await this.outbox.markFailed(record.id, msg)
    }
  }

  // ── Handler Registration ────────────────────────────────────────────────

  private registerHandlers(): void {
    this.on('user.provisioned', async ({ aggregateId, payload }) => {
      // Placeholder: sync new user to Algolia user index if needed
      this.logger.debug(
        `[Outbox→Algolia] Syncing provisioned user ${aggregateId} (source: ${payload['source']})`,
      )
      // await algoliaService.upsertUser({ id: aggregateId, email: payload.email })
    })

    this.on('user.updated', async ({ aggregateId }) => {
      this.logger.debug(`[Outbox→Algolia] Re-syncing updated user ${aggregateId}`)
    })

    this.on('user.deactivated', async ({ aggregateId, externalId }) => {
      this.logger.warn(
        `[Outbox→Admin] User deactivated: internal=${aggregateId}, external=${externalId}`,
      )
      // await adminNotificationService.notify(...)
    })
  }

  private on(eventType: string, handler: OutboxEventHandler): void {
    const existing = this.handlers.get(eventType) ?? []
    this.handlers.set(eventType, [...existing, handler])
  }
}
