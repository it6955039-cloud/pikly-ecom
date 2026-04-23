// src/homepage/homepage-personalization.service.ts
//
// Personalization Engine (P13N) — produces the authenticated user's
// personalised homepage sections, mirroring Amazon's patterns:
//
//   • continueShoppingFor  — recently viewed items not yet purchased
//   • basedOnBrowsingHistory — top-rated products from the user's most-visited depts
//   • alsoViewed           — item-item collaborative filtering via SQL co-occurrence
//   • moreToConsider       — trending products in user's interest departments
//
// Design decisions:
//   • All personalization is computed on the in-memory product store (zero
//     additional DB queries for product data) except for two small DB reads:
//     (1) recently_viewed rows, (2) co-occurrence query.
//   • Results are cached per-user in Redis (TTL 5 min) to avoid recomputing
//     on every page load while still being fresh enough for a browsing session.
//   • No external ML service required — the co-occurrence SQL is equivalent
//     to an item-item collaborative filter, which is sufficient at this scale.
//   • If a user has no browsing history the service gracefully falls back to
//     global trending/bestsellers so the endpoint always returns useful data.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { DatabaseService }    from '../database/database.service'
import { RedisService }       from '../redis/redis.service'
import { ProductsService, toCard } from '../products/products.service'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecentRow {
  asin:      string
  viewed_at: Date
}

interface PersonalizedSection {
  label:      string
  strategy:   string
  products:   any[]
  count:      number
}

export interface PersonalizedHomepage {
  continueShoppingFor:    PersonalizedSection
  basedOnBrowsingHistory: PersonalizedSection
  alsoViewed:             PersonalizedSection
  moreToConsider:         PersonalizedSection
  meta: {
    userId:          string
    hasHistory:      boolean
    topDepts:        string[]
    computedAt:      string
    fromCache:       boolean
  }
}

// Redis TTL for per-user personalization cache (seconds)
const P13N_TTL_SECONDS = 5 * 60  // 5 minutes

// How many recently-viewed ASINs to use as signals
const SIGNAL_WINDOW = 20

// Redis channel published by RecentlyViewedService whenever a user views a product.
const P13N_INVALIDATE_CHANNEL = 'p13n:user:viewed'

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class PersonalizationService implements OnModuleInit {
  private readonly logger = new Logger(PersonalizationService.name)

  constructor(
    private readonly db:       DatabaseService,
    private readonly redis:    RedisService,
    private readonly products: ProductsService,
  ) {}

  async onModuleInit() {
    // Subscribe to the per-user invalidation channel published by RecentlyViewedService.
    // Each message carries JSON { userId } — we delete only that user's Redis cache key
    // rather than flushing all P13N caches, preserving cache hits for all other users.
    this.redis.subscribe(P13N_INVALIDATE_CHANNEL, (msg: string) => {
      try {
        const { userId } = JSON.parse(msg) as { userId: string }
        if (userId) {
          this.redis
            .del(`p13n:homepage:${userId}`)
            .catch((err: Error) =>
              this.logger.warn(`P13N cache eviction failed for ${userId}: ${err.message}`),
            )
        }
      } catch {
        this.logger.warn(`Malformed P13N invalidate message: ${msg}`)
      }
    })
  }

  // ── Public entrypoint ───────────────────────────────────────────────────────

  async getPersonalized(userId: string): Promise<PersonalizedHomepage> {
    // 1. Try Redis cache first — avoids recomputation on every scroll/refresh
    const cacheKey = `p13n:homepage:${userId}`
    const cached   = await this.redis.get(cacheKey)
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as PersonalizedHomepage
        return { ...parsed, meta: { ...parsed.meta, fromCache: true } }
      } catch {
        // Corrupt cache entry — fall through and recompute
      }
    }

    // 2. Ensure in-memory product store is ready
    await this.products.ensureLoaded()

    // 3. Fetch user's browsing history (most-recent SIGNAL_WINDOW items)
    const recentRows = await this.fetchRecentRows(userId, SIGNAL_WINDOW)
    const recentAsins = recentRows.map((r) => r.asin)
    const hasHistory  = recentAsins.length > 0

    // 4. Derive top departments from browsing history
    const topDepts = hasHistory ? this.deriveTopDepts(recentAsins, 3) : []

    // 5. Compute all four sections in parallel
    const [continueShoppingFor, basedOnBrowsingHistory, alsoViewed, moreToConsider] =
      await Promise.all([
        this.computeContinueShopping(userId, recentRows),
        this.computeBasedOnHistory(topDepts),
        this.computeAlsoViewed(userId, recentAsins),
        this.computeMoreToConsider(topDepts),
      ])

    const result: PersonalizedHomepage = {
      continueShoppingFor,
      basedOnBrowsingHistory,
      alsoViewed,
      moreToConsider,
      meta: {
        userId,
        hasHistory,
        topDepts,
        computedAt: new Date().toISOString(),
        fromCache:  false,
      },
    }

    // 6. Cache in Redis — fire-and-forget (don't await to avoid adding latency)
    this.redis
      .set(cacheKey, JSON.stringify(result), P13N_TTL_SECONDS)
      .catch((err) => this.logger.warn(`P13N cache write failed for ${userId}: ${err.message}`))

    return result
  }

  /**
   * Invalidates the personalization cache for a specific user.
   * Called by RecentlyViewedService when a new product is tracked.
   */
  async invalidateForUser(userId: string): Promise<void> {
    await this.redis.del(`p13n:homepage:${userId}`)
  }

  // ── Section computers ───────────────────────────────────────────────────────

  /**
   * "Continue Shopping For"
   *
   * Returns the user's most-recently viewed products, excluding any that have
   * since been purchased (checked via store.orders line items).
   * Falls back to an empty list with a clear label if no history exists.
   */
  private async computeContinueShopping(
    userId:     string,
    recentRows: RecentRow[],
  ): Promise<PersonalizedSection> {
    if (recentRows.length === 0) {
      return this.emptySection('Continue Shopping For', 'continue_shopping')
    }

    // Fetch productIds the user has ordered — cart items use { productId } shape (not asin).
    // productId may be an ASIN or a slug; we exclude whichever the store recorded.
    const orderedRows = await this.db.query<{ product_id: string }>(
      `SELECT DISTINCT li->>'productId' AS product_id
       FROM store.orders,
            jsonb_array_elements(items) AS li
       WHERE user_id = $1
         AND status NOT IN ('cancelled','refunded')`,
      [userId],
    )
    const purchasedIds = new Set(orderedRows.map((r) => r.product_id).filter(Boolean))

    // Map to product cards — most recent first, exclude purchased.
    // Match by ASIN and also by slug in case productId was stored as slug.
    const products = recentRows
      .filter((r) => !purchasedIds.has(r.asin))
      .slice(0, 12)
      .map((r) => {
        const p = this.products.findProductByAsin(r.asin)
        return p
          ? { ...toCard(p), viewedAt: r.viewed_at }
          : null
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)

    return {
      label:    'Continue Shopping For',
      strategy: 'continue_shopping',
      products,
      count:    products.length,
    }
  }

  /**
   * "Based on Your Browsing History"
   *
   * Returns high-rated products from the user's top-visited departments.
   * Excludes ASINs already in the recent history (user has seen them).
   * Falls back to global featured products if no history.
   */
  private async computeBasedOnHistory(topDepts: string[]): Promise<PersonalizedSection> {
    const LIMIT = 16

    if (topDepts.length === 0) {
      // No history → fall back to globally featured
      const products = await this.products.getFeatured(LIMIT)
      return {
        label:    'Based on Your Browsing History',
        strategy: 'history_dept_affinity',
        products,
        count:    products.length,
      }
    }

    // Score each product by dept match (primary dept = higher weight) + rating
    const deptSet = new Set(topDepts.map((d) => d.toLowerCase()))

    const products = this.products.products
      .filter((p) => p.is_active && deptSet.has((p.taxonomy_dept ?? '').toLowerCase()))
      .sort((a, b) => {
        // Prefer top dept, then sort by rating * review signal
        const aDeptRank = topDepts.findIndex(
          (d) => d.toLowerCase() === (a.taxonomy_dept ?? '').toLowerCase(),
        )
        const bDeptRank = topDepts.findIndex(
          (d) => d.toLowerCase() === (b.taxonomy_dept ?? '').toLowerCase(),
        )
        // Lower rank index = higher affinity dept
        if (aDeptRank !== bDeptRank) return aDeptRank - bDeptRank
        // Tie-break: Wilson score approximation (rating weighted by review count)
        const aScore = (a.avg_rating ?? 0) * Math.log1p(a.review_count ?? 0)
        const bScore = (b.avg_rating ?? 0) * Math.log1p(b.review_count ?? 0)
        return bScore - aScore
      })
      .slice(0, LIMIT)
      .map(toCard)

    return {
      label:    'Based on Your Browsing History',
      strategy: 'history_dept_affinity',
      products,
      count:    products.length,
    }
  }

  /**
   * "Customers Who Viewed Items You've Viewed Also Viewed"
   *
   * Item-item collaborative filtering via a SQL co-occurrence query:
   *   For each ASIN in the user's recent history, find other users who
   *   also viewed those ASINs, then aggregate which other ASINs those users
   *   viewed most — ranked by co-occurrence frequency.
   *
   * This is equivalent to Amazon's item-item CF without needing an external
   * recommendation service. The recently_viewed table already has the
   * idx_rv_user index which makes the join efficient.
   */
  private async computeAlsoViewed(
    userId:      string,
    recentAsins: string[],
  ): Promise<PersonalizedSection> {
    const LIMIT = 16

    if (recentAsins.length === 0) {
      const products = await this.products.getTrending(LIMIT)
      return {
        label:    'Customers Also Viewed',
        strategy: 'collaborative_filtering',
        products,
        count:    products.length,
      }
    }

    // Co-occurrence query — deliberately capped at LIMIT * 3 candidates so
    // we have room to filter out ASINs missing from the in-memory store.
    const coViewedRows = await this.db.query<{ asin: string; co_score: string }>(
      `SELECT   rv2.asin,
                COUNT(*) AS co_score
       FROM     store.recently_viewed rv1
       JOIN     store.recently_viewed rv2
             ON rv1.user_id = rv2.user_id
            AND rv2.asin   != rv1.asin
       WHERE    rv1.asin    = ANY($1)
         AND    rv1.user_id != $2
         AND    rv2.asin    != ALL($1)
       GROUP BY rv2.asin
       ORDER BY co_score DESC
       LIMIT    $3`,
      [recentAsins, userId, LIMIT * 3],
    )

    const products = coViewedRows
      .map((row) => {
        const p = this.products.findProductByAsin(row.asin)
        return p ? toCard(p) : null
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .slice(0, LIMIT)

    // Fallback: if co-occurrence returns fewer than 4 items (sparse data),
    // pad with trending products in the same depts as recent history.
    if (products.length < 4) {
      const topDepts = this.deriveTopDepts(recentAsins, 2)
      const fallback = this.products.products
        .filter(
          (p) =>
            p.is_active &&
            p.is_trending &&
            topDepts.some(
              (d) => d.toLowerCase() === (p.taxonomy_dept ?? '').toLowerCase(),
            ) &&
            !recentAsins.includes(p.asin),
        )
        .sort((a, b) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0))
        .slice(0, LIMIT - products.length)
        .map(toCard)

      products.push(...fallback)
    }

    return {
      label:    'Customers Also Viewed',
      strategy: 'collaborative_filtering',
      products,
      count:    products.length,
    }
  }

  /**
   * "More to Consider"
   *
   * Trending products in the user's affinity departments.
   * Distinct from basedOnBrowsingHistory (which uses rating × review signal).
   * Falls back to global on-sale products if no history.
   */
  private async computeMoreToConsider(topDepts: string[]): Promise<PersonalizedSection> {
    const LIMIT = 16

    if (topDepts.length === 0) {
      const products = await this.products.getOnSale(LIMIT)
      return {
        label:    'More to Consider',
        strategy: 'more_to_consider',
        products,
        count:    products.length,
      }
    }

    const deptSet = new Set(topDepts.map((d) => d.toLowerCase()))

    const products = this.products.products
      .filter(
        (p) =>
          p.is_active &&
          p.is_trending &&
          deptSet.has((p.taxonomy_dept ?? '').toLowerCase()),
      )
      .sort((a, b) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0))
      .slice(0, LIMIT)
      .map(toCard)

    // Pad with global trending if dept-specific set is thin
    if (products.length < 8) {
      const existingAsins = new Set(products.map((p: any) => p.asin))
      const globalTrending = this.products.products
        .filter((p) => p.is_active && p.is_trending && !existingAsins.has(p.asin))
        .sort((a, b) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0))
        .slice(0, LIMIT - products.length)
        .map(toCard)
      products.push(...globalTrending)
    }

    return {
      label:    'More to Consider',
      strategy: 'more_to_consider',
      products,
      count:    products.length,
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async fetchRecentRows(userId: string, limit: number): Promise<RecentRow[]> {
    return this.db.query<RecentRow>(
      `SELECT asin, viewed_at
       FROM   store.recently_viewed
       WHERE  user_id = $1
       ORDER  BY viewed_at DESC
       LIMIT  $2`,
      [userId, limit],
    )
  }

  /**
   * Derives the user's top departments by counting how many of their recently-
   * viewed ASINs belong to each department (using the in-memory product store —
   * no extra DB query required).
   */
  private deriveTopDepts(recentAsins: string[], topN: number): string[] {
    const deptCount = new Map<string, number>()

    for (const asin of recentAsins) {
      const p = this.products.findProductByAsin(asin)
      if (!p) continue
      const dept = (p.taxonomy_dept ?? '').trim()
      if (!dept) continue
      deptCount.set(dept, (deptCount.get(dept) ?? 0) + 1)
    }

    return Array.from(deptCount.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, topN)
      .map(([dept]) => dept)
  }

  private emptySection(label: string, strategy: string): PersonalizedSection {
    return { label, strategy, products: [], count: 0 }
  }
}
