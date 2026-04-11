// src/webhooks/webhook.service.ts
//
// Enterprise webhook delivery with exponential backoff and DB failure tracking.
//
// DELIVERY GUARANTEES:
//   • Up to 4 attempts per event (immediate + 3 retries)
//   • Exponential backoff with full jitter: ~1s, ~10s, ~60s between retries
//   • Each attempt has a 10-second hard timeout via AbortController
//   • SSRF check re-executed at send time (DNS rebinding defence)
//   • Failures recorded to DB: consecutive_failures, last_failure_at, last_failure_reason
//   • Endpoint auto-disabled after MAX_CONSECUTIVE_FAILURES consecutive failures
//     (user must re-enable via the API after fixing their endpoint)
//   • Successful delivery resets the consecutive_failures counter
//
// SECURITY:
//   • SSRF guard (private IP + RFC-1918 ranges) at both registration and send time
//   • HMAC-SHA256 signature on every payload (X-Pikly-Signature header)
//   • Webhook secret is generated server-side and returned only once at registration

import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { DatabaseService } from '../database/database.service'
import * as crypto from 'crypto'
import { isIP } from 'net'
import { resolve4 } from 'dns/promises'

// ── SSRF Guard ───────────────────────────────────────────────────────────────

const PRIVATE_RANGES = [
  /^0\./,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
]

function isPrivateIp(ip: string): boolean {
  return PRIVATE_RANGES.some((p) => p.test(ip))
}

async function isSsrfTarget(url: string): Promise<boolean> {
  try {
    const { hostname } = new URL(url)
    if (isIP(hostname)) return isPrivateIp(hostname)
    const ips = await resolve4(hostname)
    return ips.some(isPrivateIp)
  } catch {
    return true   // DNS failure or malformed URL — treat as unsafe
  }
}

// ── Retry configuration ───────────────────────────────────────────────────────

// Maximum delivery attempts: 1 initial + MAX_RETRIES retries
const MAX_RETRIES              = 3
const REQUEST_TIMEOUT_MS       = 10_000
// Auto-disable endpoint after this many consecutive failures
const MAX_CONSECUTIVE_FAILURES = 10

// Exponential backoff with full jitter.
// Base delays (ms): 1s, 10s, 60s — multiplied by random factor in [0.5, 1.5].
// This spreads retry storms across the fleet and avoids thundering herd on
// recovering endpoints.
const BASE_DELAYS_MS = [1_000, 10_000, 60_000]

function jitteredDelay(attemptIndex: number): number {
  const base  = BASE_DELAYS_MS[Math.min(attemptIndex, BASE_DELAYS_MS.length - 1)]
  const jitter = 0.5 + Math.random()   // random factor in [0.5, 1.5]
  return Math.round(base * jitter)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name)

  constructor(private readonly db: DatabaseService) {}

  async register(userId: string, url: string, events: string[]) {
    // SSRF check at registration time
    if (await isSsrfTarget(url)) {
      throw new BadRequestException({
        code:    'SSRF_BLOCKED',
        message: 'Webhook URL resolves to a private or loopback address.',
      })
    }
    const secret = crypto.randomBytes(32).toString('hex')
    const row    = await this.db.queryOne<any>(
      `INSERT INTO store.webhooks (user_id, url, events, secret, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, user_id, url, events, is_active, created_at`,
      [userId, url, events, secret],
    )
    // Secret is returned only once — caller must store it securely
    return { ...row, secret }
  }

  async list(userId: string) {
    return this.db.query<any>(
      `SELECT id, user_id, url, events, is_active,
              last_triggered_at, consecutive_failures,
              last_failure_at, last_failure_reason, created_at
       FROM store.webhooks
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    )
  }

  async delete(id: string, userId: string) {
    const rows = await this.db.execute(
      'DELETE FROM store.webhooks WHERE id = $1 AND user_id = $2',
      [id, userId],
    )
    if (rows === 0) throw new BadRequestException({ code: 'WEBHOOK_NOT_FOUND' })
    return { deleted: true }
  }

  // ── Fire-and-forget dispatcher ────────────────────────────────────────────
  // Errors inside send() are caught and logged — they never propagate to the caller.

  async dispatch(event: string, payload: any): Promise<void> {
    const hooks = await this.db.query<any>(
      `SELECT id, url, secret, consecutive_failures
       FROM store.webhooks
       WHERE is_active = true AND $1 = ANY(events)`,
      [event],
    )
    for (const hook of hooks) {
      this.deliver(hook, event, payload).catch((err) =>
        this.logger.error(`Unhandled error in webhook delivery ${hook.id}: ${err.message}`),
      )
    }
  }

  // ── Delivery with exponential backoff ─────────────────────────────────────

  private async deliver(hook: any, event: string, payload: any): Promise<void> {
    // Re-check at send time to defend against DNS rebinding attacks
    if (await isSsrfTarget(hook.url)) {
      this.logger.warn(`SSRF blocked at send time for webhook ${hook.id} → ${hook.url}`)
      return
    }

    const body      = JSON.stringify({ event, payload, timestamp: new Date().toISOString() })
    const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex')
    const headers   = {
      'Content-Type':      'application/json',
      'X-Pikly-Signature': `sha256=${signature}`,
      'X-Pikly-Event':     event,
      'X-Pikly-Hook-Id':   hook.id,
    }

    let lastError: string | null = null
    let succeeded = false

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Wait before retries — no delay on the first attempt
      if (attempt > 0) {
        const delay = jitteredDelay(attempt - 1)
        this.logger.log(
          `Webhook ${hook.id} retry ${attempt}/${MAX_RETRIES} in ${delay}ms for event "${event}"`,
        )
        await sleep(delay)
      }

      try {
        const ctrl    = new AbortController()
        const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
        try {
          const res = await fetch(hook.url, { method: 'POST', headers, body, signal: ctrl.signal })
          if (res.ok) {
            succeeded = true
            break
          }
          // Non-2xx response — record and retry
          lastError = `HTTP ${res.status} ${res.statusText}`
          this.logger.warn(
            `Webhook ${hook.id} attempt ${attempt + 1} → ${lastError} for event "${event}"`,
          )
        } finally {
          clearTimeout(timeout)
        }
      } catch (err: any) {
        lastError = err?.name === 'AbortError'
          ? `Timeout after ${REQUEST_TIMEOUT_MS / 1000}s`
          : (err?.message ?? 'Unknown error')
        this.logger.warn(
          `Webhook ${hook.id} attempt ${attempt + 1} failed: ${lastError} for event "${event}"`,
        )
      }
    }

    // ── Persist delivery outcome to DB ────────────────────────────────────

    if (succeeded) {
      await this.db.execute(
        `UPDATE store.webhooks
         SET last_triggered_at    = NOW(),
             consecutive_failures = 0,
             last_failure_reason  = NULL,
             updated_at           = NOW()
         WHERE id = $1`,
        [hook.id],
      ).catch(() => void 0)

    } else {
      const newConsecutive = (hook.consecutive_failures ?? 0) + 1
      const shouldDisable  = newConsecutive >= MAX_CONSECUTIVE_FAILURES

      await this.db.execute(
        `UPDATE store.webhooks
         SET consecutive_failures = $1,
             last_failure_at      = NOW(),
             last_failure_reason  = $2,
             is_active            = CASE WHEN $3 THEN false ELSE is_active END,
             updated_at           = NOW()
         WHERE id = $4`,
        [newConsecutive, lastError, shouldDisable, hook.id],
      ).catch(() => void 0)

      if (shouldDisable) {
        this.logger.error(
          `Webhook ${hook.id} (${hook.url}) auto-disabled after ` +
          `${MAX_CONSECUTIVE_FAILURES} consecutive failures. Last error: ${lastError}`,
        )
      } else {
        this.logger.error(
          `Webhook ${hook.id} delivery failed after ${MAX_RETRIES + 1} attempts. ` +
          `Consecutive failures: ${newConsecutive}/${MAX_CONSECUTIVE_FAILURES}. ` +
          `Last error: ${lastError}`,
        )
      }
    }
  }
}
