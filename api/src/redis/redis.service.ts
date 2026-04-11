import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common'
import Redis from 'ioredis'

// RedisService wraps ioredis with two responsibilities:
//   1. JWT blacklist caching (SEC-06) — avoids a MongoDB query on every
//      authenticated request by caching revoked JTIs in Redis with a TTL
//      matching the token's remaining lifetime.
//   2. In-process LRU cache invalidation signalling for PERF-01 — when an
//      admin mutates a product, a pub/sub message tells all other processes
//      to reload their in-memory store.
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name)
  private readonly client: Redis

  constructor() {
    // Upstash Redis URL format: rediss://:<password>@<host>:<port>
    // Falls back to a standard local Redis URL for local development.
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      // Upstash enforces TLS on port 6380; standard Redis uses 6379.
      // ioredis detects "rediss://" scheme and enables TLS automatically.
    })
    this.client.on('error', (err) => this.logger.error(`Redis connection error: ${err.message}`))
    this.client.on('connect', () => this.logger.log('Redis connected'))
  }

  // ── Generic helpers ──────────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    return this.client.get(key)
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value)
    } else {
      await this.client.set(key, value)
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key)
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1
  }

  // ── JWT blacklist helpers (SEC-06) ───────────────────────────────────────

  // Adds a JTI to the blacklist with a TTL equal to the token's remaining
  // lifetime so the entry self-cleans when the token would have expired anyway.
  async blacklistToken(jti: string, expiresAt: Date): Promise<void> {
    const ttl = Math.ceil((expiresAt.getTime() - Date.now()) / 1000)
    if (ttl > 0) {
      await this.client.setex(`blacklist:${jti}`, ttl, '1')
    }
  }

  // Returns true if the JTI is in the blacklist.
  // This is called on every authenticated request — Redis O(1) lookup is
  // orders of magnitude faster than a MongoDB findOne for this hot path.
  async isTokenBlacklisted(jti: string): Promise<boolean> {
    return this.exists(`blacklist:${jti}`)
  }

  // ── Failed login attempt tracking (SEC-05) ───────────────────────────────

  async incrementLoginFailure(email: string): Promise<number> {
    const key = `login_fail:${email.toLowerCase()}`
    const count = await this.client.incr(key)
    // Set/refresh TTL on every increment — the window resets if they stop
    // trying for 15 minutes.
    await this.client.expire(key, 15 * 60)
    return count
  }

  async getLoginFailures(email: string): Promise<number> {
    const val = await this.client.get(`login_fail:${email.toLowerCase()}`)
    return val ? parseInt(val, 10) : 0
  }

  async clearLoginFailures(email: string): Promise<void> {
    await this.client.del(`login_fail:${email.toLowerCase()}`)
  }

  // ── Idempotency key store (DES-03) ───────────────────────────────────────

  // Stores an idempotency key → orderId mapping for 24 hours.
  async setIdempotencyKey(key: string, orderId: string): Promise<void> {
    await this.client.setex(`idempotency:${key}`, 24 * 60 * 60, orderId)
  }

  async getIdempotencyKey(key: string): Promise<string | null> {
    return this.client.get(`idempotency:${key}`)
  }

  // ── Pub/sub for cross-process cache invalidation (PERF-01) ──────────────

  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message)
  }

  private readonly subscribers: any[] = []

  subscribe(channel: string, handler: (msg: string) => void): void {
    // ioredis requires a separate client for subscribe mode.
    // We keep a reference so the client can be closed in onModuleDestroy,
    // preventing a connection leak on hot-reload or test teardown.
    const sub = this.client.duplicate()
    this.subscribers.push(sub)
    sub.subscribe(channel)
    sub.on('message', (_chan, msg) => handler(msg))
  }

  async onModuleDestroy() {
    for (const sub of this.subscribers) {
      try {
        await sub.quit()
      } catch {
        /* ignore on teardown */
      }
    }
    await this.client.quit()
  }
}
