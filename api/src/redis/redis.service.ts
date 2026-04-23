// src/redis/redis.service.ts
//
// Enterprise Redis wrapper for Upstash (TLS) and local Redis.
//
// Responsibilities:
//   1. JWT blacklist       (SEC-06)  — O(1) revocation check on every auth'd request
//   2. Login rate limiting (SEC-05)  — brute-force protection
//   3. Idempotency keys    (DES-03)  — duplicate order prevention
//   4. Pub/sub signalling  (PERF-01) — cross-process in-memory cache invalidation
//   5. L2 typed JSON cache (PERF-02) — homepage & product list persistence in Upstash
//                                      so NodeCache (L1) misses fall back to Redis
//                                      instead of always hitting DB/Algolia
//
// Two-tier caching strategy:
//   L1 NodeCache  (in-process, ~60s)  — zero-latency, no network hop
//   L2 Redis/Upstash (~5 min)         — survives process restarts, shared across
//                                       multiple Railway dynos, actual Upstash storage
//
// Upstash notes:
//   • Free tier uses port 6379 with TLS — URL scheme must be "rediss://" (double-s).
//   • ioredis auto-enables TLS when it sees "rediss://".
//   • enableOfflineQueue:false  → fail-fast during connection drop instead of
//     silently queuing commands indefinitely (better for Railway ephemeral env).
//   • connectTimeout / commandTimeout kept short so a Redis hiccup doesn't stall
//     the HTTP response — the caller always has the L1 / DB fallback.

import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common'
import Redis from 'ioredis'

// ── TTL constants (seconds) ───────────────────────────────────────────────────
export const REDIS_TTL = {
  HOMEPAGE_STOREFRONT: 5 * 60, // 5 min  — primary storefront payload
  HOMEPAGE_MAIN: 5 * 60, // 5 min  — legacy /homepage payload
  HOMEPAGE_BANNERS: 10 * 60, // 10 min — banners change infrequently
  PRODUCTS_SEARCH: 2 * 60, // 2 min  — search results
  P13N_USER: 5 * 60, // 5 min  — per-user personalisation
  JWT_BLACKLIST: 0, // dynamic — set to token remaining lifetime
} as const

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name)
  private readonly client: Redis
  private readonly subscribers: Redis[] = []

  constructor() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379'

    this.client = new Redis(url, {
      // Fail-fast: don't queue commands while disconnected.
      // Prevents a Redis outage from stalling HTTP responses.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 2,
      connectTimeout: 4_000, // ms — abort connect attempt after 4 s
      commandTimeout: 2_000, // ms — individual command timeout
      lazyConnect: false,
      // ioredis auto-enables TLS for "rediss://" scheme (Upstash free tier).
      // No extra tls:{} block needed — the URL scheme is sufficient.
    })

    this.client.on('connect', () => this.logger.log('Redis connected ✓'))
    this.client.on('ready', () => this.logger.log('Redis ready ✓'))
    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`))
    this.client.on('close', () => this.logger.warn('Redis connection closed'))
  }

  // ── Low-level string helpers ──────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key)
    } catch {
      return null
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.setex(key, ttlSeconds, value)
      } else {
        await this.client.set(key, value)
      }
    } catch (err: any) {
      this.logger.warn(`Redis set failed for "${key}": ${err.message}`)
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key)
    } catch {
      /* non-fatal */
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await this.client.exists(key)) === 1
    } catch {
      return false
    }
  }

  // ── L2 typed JSON cache (PERF-02) ─────────────────────────────────────────
  //
  // These are the methods that make Upstash actually store data.
  // Homepage and product payloads are serialised to JSON and written here
  // so that when the L1 NodeCache expires (process restart / TTL), the
  // next request hits Redis instead of re-running expensive DB + Algolia queries.

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key)
      if (!raw) return null
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  async setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.client.setex(key, ttlSeconds, JSON.stringify(value))
    } catch (err: any) {
      this.logger.warn(`Redis setJson failed for "${key}": ${err.message}`)
    }
  }

  async delPattern(pattern: string): Promise<void> {
    try {
      // SCAN instead of KEYS to avoid blocking Redis on large keyspaces
      let cursor = '0'
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
        cursor = next
        if (keys.length > 0) await this.client.del(...keys)
      } while (cursor !== '0')
    } catch (err: any) {
      this.logger.warn(`Redis delPattern failed for "${pattern}": ${err.message}`)
    }
  }

  // ── JWT blacklist (SEC-06) ────────────────────────────────────────────────

  async blacklistToken(jti: string, expiresAt: Date): Promise<void> {
    const ttl = Math.ceil((expiresAt.getTime() - Date.now()) / 1000)
    if (ttl > 0) {
      await this.set(`blacklist:${jti}`, '1', ttl)
    }
  }

  async isTokenBlacklisted(jti: string): Promise<boolean> {
    return this.exists(`blacklist:${jti}`)
  }

  // ── Failed login tracking (SEC-05) ───────────────────────────────────────

  async incrementLoginFailure(email: string): Promise<number> {
    const key = `login_fail:${email.toLowerCase()}`
    try {
      const count = await this.client.incr(key)
      await this.client.expire(key, 15 * 60)
      return count
    } catch {
      return 0
    }
  }

  async getLoginFailures(email: string): Promise<number> {
    const val = await this.get(`login_fail:${email.toLowerCase()}`)
    return val ? parseInt(val, 10) : 0
  }

  async clearLoginFailures(email: string): Promise<void> {
    await this.del(`login_fail:${email.toLowerCase()}`)
  }

  // ── Idempotency keys (DES-03) ─────────────────────────────────────────────

  async setIdempotencyKey(key: string, orderId: string): Promise<void> {
    await this.set(`idempotency:${key}`, orderId, 24 * 60 * 60)
  }

  async getIdempotencyKey(key: string): Promise<string | null> {
    return this.get(`idempotency:${key}`)
  }

  // ── Pub/sub for cross-process cache invalidation (PERF-01) ───────────────
  //
  // Subscribers use a *duplicate* client because ioredis requires a dedicated
  // connection for subscribe mode — the same client cannot be used for both
  // commands and pub/sub simultaneously.

  async publish(channel: string, message: string): Promise<void> {
    try {
      await this.client.publish(channel, message)
    } catch (err: any) {
      this.logger.warn(`Redis publish failed: ${err.message}`)
    }
  }

  subscribe(channel: string, handler: (msg: string) => void): void {
    try {
      // Subscriber clients MUST have enableOfflineQueue:true — they need to
      // queue the SUBSCRIBE command until the connection is established.
      // The main client uses enableOfflineQueue:false for fail-fast behaviour
      // on regular commands, but pub/sub is a persistent channel so queuing
      // is correct here.
      const sub = this.client.duplicate({ enableOfflineQueue: true })
      this.subscribers.push(sub)

      // Wait for 'ready' before subscribing so the stream is writable.
      // If already ready (duplicate connects fast), the event fires immediately.
      const doSubscribe = () => {
        sub
          .subscribe(channel)
          .catch((err: any) =>
            this.logger.warn(`Redis subscribe failed for "${channel}": ${err.message}`),
          )
      }

      if (sub.status === 'ready') {
        doSubscribe()
      } else {
        sub.once('ready', doSubscribe)
      }

      sub.on('message', (_chan, msg) => handler(msg))
      sub.on('error', (err) => this.logger.warn(`Subscriber error [${channel}]: ${err.message}`))
    } catch (err: any) {
      this.logger.warn(`Redis subscribe failed for "${channel}": ${err.message}`)
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleDestroy() {
    for (const sub of this.subscribers) {
      try {
        await sub.quit()
      } catch {
        /* ignore on teardown */
      }
    }
    try {
      await this.client.quit()
    } catch {
      /* ignore on teardown */
    }
  }
}
