import { Injectable } from '@nestjs/common'
import NodeCache from 'node-cache'

export const TTL = {
  HOMEPAGE: 300,
  PRODUCTS: 60,
  CATEGORIES: 600,
  BANNERS: 600,
  DEFAULT: 120,
}

@Injectable()
export class CacheService {
  private cache = new NodeCache({ stdTTL: TTL.DEFAULT, checkperiod: 120 })

  set(key: string, value: any, ttl: number = TTL.DEFAULT): void {
    this.cache.set(key, value, ttl)
  }

  get<T>(key: string): T | null {
    const val = this.cache.get<T>(key)
    return val !== undefined ? val : null
  }

  del(key: string): void {
    this.cache.del(key)
  }

  flush(): void {
    this.cache.flushAll()
  }

  keys(): string[] {
    return this.cache.keys()
  }

  stats() {
    return this.cache.getStats()
  }
}
