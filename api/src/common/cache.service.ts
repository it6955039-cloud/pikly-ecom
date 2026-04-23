// src/common/cache.service.ts
//
// Two-tier cache service.
//
// L1 — NodeCache (in-process, RAM)
//   • Zero network latency — fastest possible reads
//   • Scoped to a single process/dyno
//   • TTL is short (60–300 s) because it is process-local and lost on restart
//
// L2 — Redis / Upstash (network, persistent)
//   • Survives process restarts and Railway redeploys
//   • Shared across multiple dynos (horizontal scale)
//   • This is why Upstash now shows actual storage usage
//   • TTL is 2× the L1 TTL so L2 is always "warmer" than L1
//
// Read path:  L1 hit → return (fastest)
//             L1 miss → L2 hit → populate L1 → return
//             L2 miss → caller fetches from DB/Algolia → populate both
//
// Write path: set both L1 and L2 atomically (fire-and-forget on L2)
//
// Invalidation: del() removes from both tiers.
//               The Redis pub/sub in HomepageService / ProductsService
//               triggers del() on all processes so L1 is also cleared.

import { Injectable }  from '@nestjs/common'
import NodeCache       from 'node-cache'
import { RedisService, REDIS_TTL } from '../redis/redis.service'

// ── TTL table ─────────────────────────────────────────────────────────────────
// L1 = in-process NodeCache TTL (seconds)
// L2 = Redis / Upstash TTL     (seconds) — always >= L1

export const TTL = {
  HOMEPAGE:    300,   // L1  (L2 = REDIS_TTL.HOMEPAGE_MAIN)
  STOREFRONT:  300,   // L1  (L2 = REDIS_TTL.HOMEPAGE_STOREFRONT)
  PRODUCTS:    60,    // L1  (L2 = REDIS_TTL.PRODUCTS_SEARCH)
  CATEGORIES:  600,
  BANNERS:     600,   // L1  (L2 = REDIS_TTL.HOMEPAGE_BANNERS)
  DEFAULT:     120,
} as const

// Map from L1 cache-key prefix → L2 TTL in seconds.
// Keys not matching any prefix fall back to DEFAULT * 2.
const L2_TTL_MAP: Record<string, number> = {
  'homepage:storefront': REDIS_TTL.HOMEPAGE_STOREFRONT,
  'homepage:main':       REDIS_TTL.HOMEPAGE_MAIN,
  'homepage:banners':    REDIS_TTL.HOMEPAGE_BANNERS,
  'products:search':     REDIS_TTL.PRODUCTS_SEARCH,
}

function l2Ttl(key: string): number {
  for (const [prefix, ttl] of Object.entries(L2_TTL_MAP)) {
    if (key.startsWith(prefix)) return ttl
  }
  return TTL.DEFAULT * 2
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class CacheService {
  private readonly l1 = new NodeCache({ stdTTL: TTL.DEFAULT, checkperiod: 120 })

  constructor(private readonly redis: RedisService) {}

  // ── L1 + L2 set ──────────────────────────────────────────────────────────

  set(key: string, value: any, ttl: number = TTL.DEFAULT): void {
    // L1: synchronous
    this.l1.set(key, value, ttl)
    // L2: fire-and-forget — never block the caller for a network write
    this.redis.setJson(key, value, l2Ttl(key)).catch(() => void 0)
  }

  // ── L1 get (synchronous fast path) ───────────────────────────────────────

  get<T>(key: string): T | null {
    const val = this.l1.get<T>(key)
    return val !== undefined ? val : null
  }

  // ── L2 async get (for async service methods) ──────────────────────────────
  // Use this in service methods that can await — gives you the full two-tier benefit.
  // Pattern:
  //   const cached = await this.cache.getAsync<MyType>('my:key')
  //   if (cached) return { ...cached, cacheHit: true }
  //   // ... compute ...
  //   this.cache.set('my:key', result, TTL.HOMEPAGE)
  //   return { ...result, cacheHit: false }

  async getAsync<T>(key: string): Promise<{ value: T; tier: 'l1' | 'l2' } | null> {
    // L1 first
    const l1val = this.l1.get<T>(key)
    if (l1val !== undefined) return { value: l1val, tier: 'l1' }

    // L2 fallback
    const l2val = await this.redis.getJson<T>(key)
    if (l2val !== null) {
      // Warm L1 so next request is instant
      this.l1.set(key, l2val, TTL.DEFAULT)
      return { value: l2val, tier: 'l2' }
    }

    return null
  }

  // ── Invalidation ──────────────────────────────────────────────────────────

  del(key: string): void {
    this.l1.del(key)
    this.redis.del(key).catch(() => void 0)
  }

  flush(): void {
    this.l1.flushAll()
    // Note: we do NOT flush all Redis keys — other processes and other features
    // (JWT blacklist, login failures) live there too.
    // Callers that need full homepage invalidation should use delByPrefix().
  }

  delByPrefix(prefix: string): void {
    // L1: iterate known keys
    this.l1.keys()
      .filter((k) => k.startsWith(prefix))
      .forEach((k) => this.l1.del(k))
    // L2: SCAN-based pattern delete (non-blocking)
    this.redis.delPattern(`${prefix}*`).catch(() => void 0)
  }

  keys(): string[] {
    return this.l1.keys()
  }

  stats() {
    return this.l1.getStats()
  }
}
