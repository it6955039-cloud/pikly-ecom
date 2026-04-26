// src/homepage/homepage-personalization-v2.service.ts
//
// Personalization Engine v2
//
// Produces four authenticated personalization slots as ProductCardV2[].
// Injected into the storefront v2 base layout by HomepageStorefrontV2Service.
//
// ─────────────────────────────────────────────────────────────────────────────
// BUG FIXES vs first draft:
//
//   FIX-5  CRITICAL — fetchPurchasedAsins() queried store.order_items which
//          does not exist. The schema stores order line items in store.orders
//          as a JSONB column `items` with shape [{productId, ...}, ...].
//          Correct query (matching v1 personalization service):
//            SELECT DISTINCT li->>'productId' AS product_id
//            FROM store.orders, jsonb_array_elements(items) AS li
//            WHERE user_id=$1 AND status NOT IN ('cancelled','refunded')
//          The productId field may be an ASIN or a slug — we filter by both.
//
// ─────────────────────────────────────────────────────────────────────────────
// Design:
//   • All four slots computed in parallel (Promise.all) — same p99 as slowest
//   • Per-user Redis cache key versioned: p13n:v2:homepage:{userId}
//     so v1 (p13n:homepage:{userId}) and v2 caches never collide during rollout
//   • Graceful degradation: every slot has a global trending/bestseller fallback
//   • toCardV2() called via HomepageStorefrontV2Service — raw rows only
//   • Co-occurrence SQL matches v1 exactly — battle-tested query

import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { DatabaseService }             from '../database/database.service'
import { RedisService }                from '../redis/redis.service'
import { ProductsService }             from '../products/products.service'
import { HomepageStorefrontV2Service } from './homepage-storefront-v2.service'
import type { PersonalizationBundle, PersonalizedSlot } from './types/storefront-v2.types'

const P13N_TTL     = 5 * 60          // 5 min per-user Redis TTL
const SIGNAL_WIN   = 20              // how many recently-viewed rows to use
const CACHE_PREFIX = 'p13n:v2:homepage:'
const INVAL_CHAN   = 'p13n:user:viewed'

interface RecentRow { asin: string; viewed_at: Date }

@Injectable()
export class PersonalizationV2Service implements OnModuleInit {
  private readonly logger = new Logger(PersonalizationV2Service.name)

  constructor(
    private readonly db:         DatabaseService,
    private readonly redis:      RedisService,
    private readonly products:   ProductsService,
    private readonly storefront: HomepageStorefrontV2Service,
  ) {}

  async onModuleInit() {
    // Invalidate per-user cache when the user views a new product
    this.redis.subscribe(INVAL_CHAN, (msg: string) => {
      try {
        const { userId } = JSON.parse(msg) as { userId: string }
        if (userId) {
          this.redis.del(`${CACHE_PREFIX}${userId}`).catch((err: Error) =>
            this.logger.warn(`P13N v2 eviction failed for ${userId}: ${err.message}`),
          )
        }
      } catch {
        this.logger.warn(`Malformed P13N invalidation message: ${msg}`)
      }
    })
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async getPersonalized(userId: string): Promise<PersonalizationBundle> {
    const cacheKey = `${CACHE_PREFIX}${userId}`

    // L2 Redis cache check (no L1 — personalization is per-user, not shared)
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as PersonalizationBundle
        return { ...parsed, fromCache: true }
      } catch {
        // Corrupt entry — recompute
      }
    }

    await this.products.ensureLoaded()

    const recentRows  = await this.fetchRecentRows(userId, SIGNAL_WIN)
    const recentAsins = recentRows.map((r) => r.asin)
    const hasHistory  = recentAsins.length > 0
    const topDepts    = hasHistory ? this.deriveTopDepts(recentAsins, 3) : []

    // All four slots in parallel — same p99 as the slowest query
    const [continueShoppingFor, basedOnBrowsingHistory, alsoViewed, moreToConsider] =
      await Promise.all([
        this.computeContinueShopping(userId, recentRows),
        this.computeBasedOnHistory(topDepts),
        this.computeAlsoViewed(userId, recentAsins),
        this.computeMoreToConsider(topDepts),
      ])

    const result: PersonalizationBundle = {
      userId,
      hasHistory,
      topAffinityDepts: topDepts,
      continueShoppingFor,
      basedOnBrowsingHistory,
      alsoViewed,
      moreToConsider,
      computedAt: new Date().toISOString(),
      fromCache:  false,
    }

    // Write to Redis — fire and forget, never block the response
    this.redis
      .set(cacheKey, JSON.stringify(result), P13N_TTL)
      .catch((err: any) =>
        this.logger.warn(`P13N v2 cache write failed for ${userId}: ${err.message}`),
      )

    return result
  }

  // ── Slot computers ───────────────────────────────────────────────────────────

  /**
   * "Continue shopping for" — recently viewed, not yet purchased.
   *
   * FIX-5: store.orders uses items JSONB column (not a separate order_items table).
   * Each element has shape { productId, quantity, price, ... }.
   * productId may be an ASIN or a slug depending on when the order was placed.
   */
  private async computeContinueShopping(
    userId: string,
    recentRows: RecentRow[],
  ): Promise<PersonalizedSlot> {
    if (!recentRows.length) {
      return this.globalFallback('continue', 'Continue shopping for', 8)
    }

    // FIX-5: Correct query for items JSONB — no store.order_items table exists.
    const purchasedIds = await this.fetchPurchasedProductIds(userId)

    const products = recentRows
      // exclude items the user has already purchased (by ASIN or by slug)
      .filter((r) => {
        const p = this.products.findProductByAsin(r.asin)
        return !purchasedIds.has(r.asin) && !(p && purchasedIds.has(p.slug))
      })
      .slice(0, 12)
      .map((r) => {
        const p = this.products.findProductByAsin(r.asin)
        return p ? this.storefront.toCardV2(p, 'continue_shopping', 'continue') : null
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)

    if (products.length < 2) {
      return this.globalFallback('continue', 'Continue shopping for', 8)
    }

    return { label: 'Continue shopping for', strategy: 'continue', products, count: products.length }
  }

  /**
   * "Based on your browsing history" — top-rated products from affinity depts.
   */
  private async computeBasedOnHistory(topDepts: string[]): Promise<PersonalizedSlot> {
    if (!topDepts.length) {
      return this.globalFallback('history_based', 'Based on your browsing history', 12)
    }

    const products = this.products.products
      .filter((p: any) => {
        if (!p.is_active) return false
        const dept = (p.taxonomy_dept ?? '').toLowerCase()
        return topDepts.some((d) => d.toLowerCase() === dept)
      })
      .filter((p: any) => (p.avg_rating ?? 0) >= 4.0)
      .sort((a: any, b: any) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0))
      .slice(0, 16)
      .map((p: any) => this.storefront.toCardV2(p, 'browsing_history', 'history_based'))

    if (products.length < 2) {
      return this.globalFallback('history_based', 'Based on your browsing history', 12)
    }

    return { label: 'Based on your browsing history', strategy: 'history_based', products, count: products.length }
  }

  /**
   * "Customers also viewed" — item-item collaborative filter via SQL co-occurrence.
   * Matches v1 query exactly (battle-tested).
   */
  private async computeAlsoViewed(
    userId: string,
    recentAsins: string[],
  ): Promise<PersonalizedSlot> {
    if (!recentAsins.length) {
      return this.globalFallback('also_viewed', 'Customers also viewed', 18)
    }

    try {
      // Co-occurrence: which ASINs do other users view alongside the user's recent items?
      // Uses positional parameterization — recentAsins sliced to 5 to keep query fast.
      const params  = recentAsins.slice(0, 5)
      const pHolders = params.map((_, i) => `$${i + 2}`).join(', ')

      const coRows = await this.db.query<{ asin: string; score: string }>(
        `SELECT   rv2.asin,
                  COUNT(*) AS score
         FROM     store.recently_viewed rv1
         JOIN     store.recently_viewed rv2
                    ON  rv1.user_id = rv2.user_id
                    AND rv2.asin   != rv1.asin
         WHERE    rv1.asin   IN (${pHolders})
           AND    rv2.user_id != $1
         GROUP BY rv2.asin
         ORDER BY score DESC
         LIMIT    72`,
        [userId, ...params],
      )

      const seen     = new Set(recentAsins)
      const products = coRows
        .filter((r) => !seen.has(r.asin))
        .map((r) => this.products.findProductByAsin(r.asin))
        .filter((p): p is NonNullable<typeof p> => p !== null && p.is_active !== false)
        .slice(0, 18)
        .map((p: any) => this.storefront.toCardV2(p, 'also_viewed_grid', 'also_viewed'))

      if (products.length >= 4) {
        return { label: 'Customers also viewed', strategy: 'also_viewed', products, count: products.length }
      }
    } catch (err: any) {
      this.logger.warn(`Co-occurrence query failed: ${err.message}`)
    }

    // Fallback: pad with trending from affinity depts
    return this.globalFallback('also_viewed', 'Customers also viewed', 18)
  }

  /**
   * "More items to consider" — trending in the user's top-interest departments.
   */
  private async computeMoreToConsider(topDepts: string[]): Promise<PersonalizedSlot> {
    if (!topDepts.length) {
      return this.globalFallback('more_to_consider', 'More items to consider', 12)
    }

    const products = this.products.products
      .filter((p: any) => {
        if (!p.is_active) return false
        const dept = (p.taxonomy_dept ?? '').toLowerCase()
        return (p.is_trending || p.is_amazon_choice) &&
          topDepts.some((d) => d.toLowerCase() === dept)
      })
      .sort((a: any, b: any) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0))
      .slice(0, 16)
      .map((p: any) => this.storefront.toCardV2(p, 'carousel_more_to_consider', 'more_to_consider'))

    if (products.length < 2) {
      return this.globalFallback('more_to_consider', 'More items to consider', 12)
    }

    return { label: 'More items to consider', strategy: 'more_to_consider', products, count: products.length }
  }

  // ── DB helpers ───────────────────────────────────────────────────────────────

  private async fetchRecentRows(userId: string, limit: number): Promise<RecentRow[]> {
    try {
      return await this.db.query<RecentRow>(
        `SELECT asin, viewed_at
         FROM   store.recently_viewed
         WHERE  user_id = $1
         ORDER  BY viewed_at DESC
         LIMIT  $2`,
        [userId, limit],
      )
    } catch {
      return []
    }
  }

  /**
   * FIX-5: Fetch purchased product IDs from store.orders items JSONB.
   * store.orders.items is JSONB array of objects with shape:
   *   { productId: string, quantity: number, price: number, ... }
   * productId may be an ASIN or a slug — we add both to the exclusion set.
   */
  private async fetchPurchasedProductIds(userId: string): Promise<Set<string>> {
    try {
      const rows = await this.db.query<{ product_id: string }>(
        `SELECT DISTINCT li->>'productId' AS product_id
         FROM   store.orders,
                jsonb_array_elements(items) AS li
         WHERE  user_id = $1
           AND  status  NOT IN ('cancelled', 'refunded')`,
        [userId],
      )
      return new Set(rows.map((r) => r.product_id).filter(Boolean))
    } catch {
      return new Set()
    }
  }

  // ── Pure helpers ─────────────────────────────────────────────────────────────

  /**
   * Global fallback — used when the user has no history or sparse co-occurrence data.
   * Returns trending/bestsellers so the slot always has useful content.
   */
  private globalFallback(strategy: any, label: string, limit: number): PersonalizedSlot {
    const products = this.products.products
      .filter((p: any) => p.is_active !== false && (p.is_trending || p.is_best_seller))
      .sort((a: any, b: any) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0))
      .slice(0, limit)
      .map((p: any) => this.storefront.toCardV2(p, strategy, strategy))
    return { label, strategy, products, count: products.length }
  }

  private deriveTopDepts(asins: string[], topN: number): string[] {
    const map = new Map<string, number>()
    for (const asin of asins) {
      const p = this.products.findProductByAsin(asin)
      if (!p) continue
      const dept = (p.taxonomy_dept ?? '').trim()
      if (!dept) continue
      map.set(dept, (map.get(dept) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([d]) => d)
  }
}
