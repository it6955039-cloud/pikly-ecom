// src/common/cache.service.ts
//
// Two-tier cache service.
//
// L1 — NodeCache (in-process, RAM)  — zero latency, lost on restart
// L2 — Redis / Upstash (network)    — survives restarts, shared across dynos
//
// useClones:false — storefront payload ~500KB, cloning doubles memory pressure.
// Safe because callers treat cached objects as immutable.

import { Injectable, Logger } from '@nestjs/common'
import NodeCache from 'node-cache'
import { RedisService, REDIS_TTL } from '../redis/redis.service'

export const TTL = {
  HOMEPAGE: 300,
  STOREFRONT: 300,
  PRODUCTS: 60,
  CATEGORIES: 600,
  BANNERS: 600,
  DEFAULT: 120,
} as const

const L2_TTL_MAP: Record<string, number> = {
  'homepage:storefront': REDIS_TTL.HOMEPAGE_STOREFRONT,
  'homepage:main': REDIS_TTL.HOMEPAGE_MAIN,
  'homepage:banners': REDIS_TTL.HOMEPAGE_BANNERS,
  'products:search': REDIS_TTL.PRODUCTS_SEARCH,
}

function l2Ttl(key: string): number {
  for (const [prefix, ttl] of Object.entries(L2_TTL_MAP)) {
    if (key.startsWith(prefix)) return ttl
  }
  return TTL.DEFAULT * 2
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name)

  private readonly l1 = new NodeCache({
    stdTTL: TTL.DEFAULT,
    checkperiod: 120,
    useClones: false,
  })

  constructor(private readonly redis: RedisService) {}

  set(key: string, value: any, ttl: number = TTL.DEFAULT): void {
    this.l1.set(key, value, ttl)
    this.redis
      .setJson(key, value, l2Ttl(key))
      .then(() => {
        // L2 write errors are logged inside redis.service.ts setJson
      })
      .catch((err: any) => this.logger.warn(`L2 write error for "${key}": ${err.message}`))
  }

  get<T>(key: string): T | null {
    const val = this.l1.get<T>(key)
    return val !== undefined ? val : null
  }

  async getAsync<T>(key: string): Promise<{ value: T; tier: 'l1' | 'l2' } | null> {
    const l1val = this.l1.get<T>(key)
    if (l1val !== undefined) return { value: l1val, tier: 'l1' }

    const l2val = await this.redis.getJson<T>(key)
    if (l2val !== null) {
      this.l1.set(key, l2val, this.resolveTtl(key))
      return { value: l2val, tier: 'l2' }
    }
    return null
  }

  del(key: string): void {
    this.l1.del(key)
    this.redis.del(key).catch(() => void 0)
  }

  flush(): void {
    this.l1.flushAll()
  }

  delByPrefix(prefix: string): void {
    this.l1
      .keys()
      .filter((k) => k.startsWith(prefix))
      .forEach((k) => this.l1.del(k))
    this.redis.delPattern(`${prefix}*`).catch(() => void 0)
  }

  keys(): string[] {
    return this.l1.keys()
  }
  stats() {
    return this.l1.getStats()
  }

  private resolveTtl(key: string): number {
    if (key.startsWith('homepage:storefront')) return TTL.STOREFRONT
    if (key.startsWith('homepage:banners')) return TTL.BANNERS
    if (key.startsWith('homepage:')) return TTL.HOMEPAGE
    if (key.startsWith('products:search')) return TTL.PRODUCTS
    return TTL.DEFAULT
  }
}
