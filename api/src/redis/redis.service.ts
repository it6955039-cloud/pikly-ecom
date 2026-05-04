/**
 * @file redis/redis.service.ts  ← ADD methods if not already present
 *
 * RedisService — thin wrapper around ioredis used throughout the project.
 *
 * The LegacyShowcaseAdapter and ShowcaseAuthController call five methods:
 *   get                    — simple GET
 *   set                    — SET with TTL (seconds)
 *   incrementLoginFailure  — INCR + EXPIRE (atomic brute-force counter)
 *   getLoginFailures       — GET as integer
 *   clearLoginFailures     — DEL
 *
 * All keys passed by the showcase adapter are already namespaced:
 *   legacy:blacklist:{jti}
 *   legacy:login_failure:{email}
 *
 * So this service stays generic — no namespace logic lives here.
 *
 * If your existing RedisService already exposes equivalent methods,
 * keep it as-is and just verify the signatures match what the adapter calls.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name)
  private client!: Redis

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.get<string>('REDIS_URL', 'redis://localhost:6379')
    this.client = new Redis(url, {
      lazyConnect:      true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    })
    this.client.on('error', (err) =>
      this.logger.warn(`Redis error: ${err.message}`),
    )
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit()
  }

  // ── Core helpers ──────────────────────────────────────────────────────────

  /** GET — returns the value string, or null if key absent */
  async get(key: string): Promise<string | null> {
    return this.client.get(key)
  }

  /** SET with optional TTL in seconds */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds)
    } else {
      await this.client.set(key, value)
    }
  }

  /** DEL one or more keys */
  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys)
  }

  // ── Login-failure rate limiting helpers (used by legacy showcase auth) ───

  /**
   * Atomically increment the failure counter for a key and set a 1-hour TTL.
   * Key format: legacy:login_failure:{email}
   */
  async incrementLoginFailure(key: string): Promise<number> {
    const pipeline = this.client.pipeline()
    pipeline.incr(key)
    pipeline.expire(key, 3_600)   // 1-hour window
    const results = await pipeline.exec()
    return (results?.[0]?.[1] as number) ?? 1
  }

  /** Return current failure count for the key, or 0 if absent. */
  async getLoginFailures(key: string): Promise<number> {
    const val = await this.client.get(key)
    return val ? parseInt(val, 10) : 0
  }

  /** Reset the failure counter (called on successful login). */
  async clearLoginFailures(key: string): Promise<void> {
    await this.client.del(key)
  }
}
