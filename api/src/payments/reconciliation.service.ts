// src/payments/reconciliation.service.ts
// BUG-1 FIX: recover stuck 'processing' events from crashed workers
// BUG-3 FIX: pg_try_advisory_xact_lock prevents multi-pod duplicate reconciliation

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DatabaseService } from '../database/database.service'
import { PaymentsService } from './payments.service'

const RECONCILIATION_LOCK_KEY = 2_847_361_294  // stable prime — document in team wiki

@Injectable()
export class ReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationService.name)
  private intervalHandle: NodeJS.Timeout | null = null
  private recoveryHandle: NodeJS.Timeout | null = null

  private readonly RECONCILE_INTERVAL_MS    = 10 * 60 * 1000
  private readonly RECOVERY_INTERVAL_MS     =  5 * 60 * 1000
  private readonly THRESHOLD_MIN            = 35
  private readonly STUCK_PROCESSING_MINUTES = 10   // crash recovery window

  constructor(
    private readonly db:       DatabaseService,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit(): void {
    this.logger.log('[reconciliation] Starting — reconcile=10min recovery=5min stuck_threshold=10min')
    setTimeout(() => {
      this.reconcile()
      this.intervalHandle = setInterval(() => this.reconcile(), this.RECONCILE_INTERVAL_MS)
    }, 2 * 60 * 1000)

    // Recovery runs independently — catches stuck events before they become stale
    setTimeout(() => this.recoverStuckProcessing(), 30_000)
    this.recoveryHandle = setInterval(() => this.recoverStuckProcessing(), this.RECOVERY_INTERVAL_MS)
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) { clearInterval(this.intervalHandle); this.intervalHandle = null }
    if (this.recoveryHandle) { clearInterval(this.recoveryHandle); this.recoveryHandle = null }
  }

  // ── BUG-1 FIX: Crash recovery for stuck 'processing' rows ────────────────

  private async recoverStuckProcessing(): Promise<void> {
    const correlationId = randomUUID()
    try {
      // payment_events stuck in 'processing': crashed webhook worker
      const eventsRecovered = await this.db.execute(
        `UPDATE store.payment_events
         SET processing_status = 'failed',
             error_message     = 'Recovered: worker crash assumed (processing_claimed_at timeout)',
             processed_at      = NOW()
         WHERE processing_status = 'processing'
           AND processing_claimed_at < NOW() - ($1 || ' minutes')::INTERVAL`,
        [String(this.STUCK_PROCESSING_MINUTES)],
      )
      if (eventsRecovered > 0) {
        this.logger.warn(
          `[recovery] corr=${correlationId} Reset ${eventsRecovered} stuck payment_events → 'failed' ` +
          `— Stripe retry will re-trigger processing`,
        )
      }

      // payment_outbox stuck in 'processing': crashed outbox processor
      const outboxRecovered = await this.db.execute(
        `UPDATE store.payment_outbox
         SET status          = 'failed',
             last_error      = 'Recovered: worker crash assumed (processing_claimed_at timeout)',
             next_attempt_at = NOW()
         WHERE status = 'processing'
           AND processing_claimed_at < NOW() - ($1 || ' minutes')::INTERVAL`,
        [String(this.STUCK_PROCESSING_MINUTES)],
      )
      if (outboxRecovered > 0) {
        this.logger.warn(
          `[recovery] corr=${correlationId} Reset ${outboxRecovered} stuck payment_outbox → 'failed' ` +
          `— outbox processor will retry on next poll`,
        )
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`[recovery] corr=${correlationId} Recovery failed: ${msg}`)
    }
  }

  // ── BUG-3 FIX: Advisory lock prevents multi-pod duplicate reconciliation ──

  private async reconcile(): Promise<void> {
    const correlationId = randomUUID()
    try {
      // Phase 1: acquire advisory lock and get stuck order list atomically
      let stuckOrders: any[] = []

      await this.db.transaction(async (client) => {
        const { rows } = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock($1) AS locked',
          [RECONCILIATION_LOCK_KEY],
        )
        if (!rows[0]?.locked) {
          this.logger.debug(`[reconciliation] corr=${correlationId} Lock held by another pod — skip`)
          return
        }

        stuckOrders = await this.payments.getStuckCheckoutOrders(this.THRESHOLD_MIN)
        this.logger.log(
          `[reconciliation] corr=${correlationId} Lock acquired — found ${stuckOrders.length} stuck order(s)`,
        )
        // Lock releases when transaction commits here — before Stripe API calls
      })

      if (stuckOrders.length === 0) return

      // Phase 2: poll Stripe — outside the advisory lock transaction (network IO)
      for (const order of stuckOrders) {
        await this.payments
          .reconcileOrder(order.order_id, order.stripe_session_id, correlationId)
          .catch(err =>
            this.logger.error(
              `[reconciliation] corr=${correlationId} Failed order=${order.order_id}: ${err.message}`,
            ),
          )
        await new Promise(res => setTimeout(res, 250))  // rate-limit Stripe calls
      }

      this.logger.log(`[reconciliation] corr=${correlationId} Run complete`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`[reconciliation] corr=${correlationId} Run failed: ${msg}`)
    }
  }
}
