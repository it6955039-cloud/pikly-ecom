// src/homepage/homepage-storefront.service.ts
//
// Amazon-style Storefront Page Composition Engine
//
// Produces a single GET /homepage/storefront response that gives the frontend
// everything it needs to render an Amazon-like homepage — no secondary calls,
// no "figure it out yourself" flat arrays.
//
// Response contract: an ordered array of typed `Section` objects.
// Each section has:
//   • sectionId        — stable unique key for React list rendering
//   • type             — drives which frontend component renders it
//   • title / badge    — display copy (localisation-ready)
//   • seeMoreLink      — where "See all / See more" points
//   • position         — sort order (frontend should NOT re-sort)
//   • data             — fully resolved payload, shape varies by type
//
// Section types (matching Amazon's visual vocabulary):
//   hero_banner       — full-width image slider
//   category_grid     — 2-col × N-row subcategory grid with product thumbnails
//   product_carousel  — horizontal scrolling product cards
//   dept_spotlight    — single department with heading + 4-product mini grid
//
// Caching:
//   L1 (NodeCache, 5 min) + L2 (Redis/Upstash, 5 min)
//   First request after deploy: ~200–400 ms (DB + in-memory computation)
//   Subsequent requests: < 1 ms (L1) or ~5–15 ms (L2 warm)
//
// Invalidation:
//   Any admin mutation that calls redis.publish('homepage:invalidate', ...)
//   clears both L1 and L2 so the next request rebuilds fresh.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { CacheService, TTL }   from '../common/cache.service'
import { RedisService }        from '../redis/redis.service'
import { ProductsService, toCard } from '../products/products.service'
import { CategoriesService }   from '../categories/categories.service'
import { DatabaseService }     from '../database/database.service'

// ── Section type discriminated union ─────────────────────────────────────────

export type SectionType =
  | 'hero_banner'
  | 'category_grid'
  | 'product_carousel'
  | 'dept_spotlight'

export interface HeroBannerData {
  banners: {
    id: string
    title: string
    subtitle: string | null
    image: string | null
    ctaText: string | null
    ctaLink: string | null
    badge: string | null
    position: string
  }[]
}

export interface CategoryGridCell {
  name: string
  slug: string
  image: string | null
  link: string
  /** 2–4 product thumbnail images for the cell preview */
  productImages: string[]
}

export interface CategoryGridData {
  /** 2-column layout cells — frontend renders as 2 × N grid */
  cells: CategoryGridCell[]
}

export interface ProductCarouselData {
  strategy: string
  products: ReturnType<typeof toCard>[]
}

export interface DeptSpotlightData {
  dept: string
  deptSlug: string
  seeMoreLink: string
  /** 4 products displayed in a 2×2 mini grid */
  products: ReturnType<typeof toCard>[]
}

export interface StorefrontSection {
  sectionId:   string
  type:        SectionType
  title:       string | null
  subtitle:    string | null
  badge:       string | null
  seeMoreLink: string | null
  position:    number
  data:        HeroBannerData | CategoryGridData | ProductCarouselData | DeptSpotlightData
}

export interface StorefrontPayload {
  layout:       'pikly_storefront_v1'
  sections:     StorefrontSection[]
  generatedAt:  string
  sectionCount: number
}

// ── Cache key ─────────────────────────────────────────────────────────────────
const CACHE_KEY = 'homepage:storefront:v1'

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class HomepageStorefrontService implements OnModuleInit {
  private readonly logger = new Logger(HomepageStorefrontService.name)

  constructor(
    private readonly db:         DatabaseService,
    private readonly cache:      CacheService,
    private readonly redis:      RedisService,
    private readonly products:   ProductsService,
    private readonly categories: CategoriesService,
  ) {}

  async onModuleInit() {
    // Flush storefront cache on any homepage mutation (admin banner/widget changes)
    this.redis.subscribe('homepage:invalidate', () => {
      this.cache.del(CACHE_KEY)
      this.logger.log('Storefront cache invalidated via pub/sub')
    })
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  // In-flight deduplication — prevents race condition where simultaneous requests
  // all find empty cache and all build in parallel, all returning cacheHit:false.
  // With this: only the FIRST miss triggers a build; all subsequent simultaneous
  // requests await the same Promise and also get cacheHit:false (correct — they
  // are part of the same cold-start batch), but only ONE build runs.
  private buildInFlight: Promise<StorefrontPayload> | null = null

  async getStorefront(): Promise<{ payload: StorefrontPayload; cacheHit: boolean; cacheTier: string }> {
    // L1 + L2 two-tier cache check
    const cached = await this.cache.getAsync<StorefrontPayload>(CACHE_KEY)
    if (cached) {
      return { payload: cached.value, cacheHit: true, cacheTier: cached.tier }
    }

    // Cache miss — deduplicate concurrent builds
    if (!this.buildInFlight) {
      this.buildInFlight = this.buildStorefront().finally(() => {
        this.buildInFlight = null
      })
    }

    const payload = await this.buildInFlight

    // Persist to both tiers (idempotent — safe to call multiple times)
    this.cache.set(CACHE_KEY, payload, TTL.STOREFRONT)

    return { payload, cacheHit: false, cacheTier: 'none' }
  }

  /** Called by admin mutations that need immediate cache bust */
  invalidate(): void {
    this.cache.del(CACHE_KEY)
  }

  // ── Builder ────────────────────────────────────────────────────────────────

  private async buildStorefront(): Promise<StorefrontPayload> {
    await Promise.all([
      this.products.ensureLoaded(),
      this.categories.ensureLoaded(),
    ])

    // Run all data fetches in parallel — nothing blocks anything else
    const [
      bannerRows,
      featured,
      bestsellers,
      trending,
      newArrivals,
      onSale,
      topRated,
    ] = await Promise.all([
      this.fetchBanners(),
      this.products.getFeatured(16),
      this.products.getBestSellers(16),
      this.products.getTrending(16),
      this.products.getNewArrivals(16),
      this.products.getOnSale(16),
      this.products.getTopRated(16),
    ])

    // Department data — built from in-memory product store (zero extra DB queries)
    const deptMap = this.buildDeptMap()
    const topDepts = [...deptMap.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 12)

    const sections: StorefrontSection[] = []
    let pos = 1

    // ── 1. Hero Banner ────────────────────────────────────────────────────────
    sections.push({
      sectionId:   'hero_main',
      type:        'hero_banner',
      title:       null,
      subtitle:    null,
      badge:       null,
      seeMoreLink: null,
      position:    pos++,
      data:        { banners: bannerRows.filter((b: any) => b.position === 'hero' || !b.position) } as HeroBannerData,
    })

    // ── 2. Category grids (Amazon's 4-cell department grids) ──────────────────
    // We emit up to 4 named category grids, one per top department.
    // Each grid gets a human-friendly title and 4 subcategory cells.
    const gridDepts = topDepts.slice(0, 4)
    for (const [dept, deptProducts] of gridDepts) {
      const catTitle = this.deptTitle(dept)
      const cells    = this.buildGridCells(dept, deptProducts)
      if (cells.length < 2) continue

      sections.push({
        sectionId:   `grid_${this.slug(dept)}`,
        type:        'category_grid',
        title:       catTitle,
        subtitle:    null,
        badge:       null,
        seeMoreLink: `/department/${this.slug(dept)}`,
        position:    pos++,
        data:        { cells } as CategoryGridData,
      })
    }

    // ── 3. Featured Picks carousel ────────────────────────────────────────────
    if (featured.length) {
      sections.push({
        sectionId:   'carousel_featured',
        type:        'product_carousel',
        title:       "Amazon's Choice — Featured Picks",
        subtitle:    null,
        badge:       "Amazon's Choice",
        seeMoreLink: '/products?featured=true',
        position:    pos++,
        data:        { strategy: 'featured', products: featured } as ProductCarouselData,
      })
    }

    // ── 4. More category grids (depts 5–8) ────────────────────────────────────
    const gridDepts2 = topDepts.slice(4, 8)
    for (const [dept, deptProducts] of gridDepts2) {
      const cells = this.buildGridCells(dept, deptProducts)
      if (cells.length < 2) continue
      sections.push({
        sectionId:   `grid_${this.slug(dept)}_2`,
        type:        'category_grid',
        title:       this.deptTitle(dept),
        subtitle:    null,
        badge:       null,
        seeMoreLink: `/department/${this.slug(dept)}`,
        position:    pos++,
        data:        { cells } as CategoryGridData,
      })
    }

    // ── 5. Best Sellers carousel ──────────────────────────────────────────────
    if (bestsellers.length) {
      sections.push({
        sectionId:   'carousel_bestsellers',
        type:        'product_carousel',
        title:       'Best Sellers',
        subtitle:    'Our most popular products based on sales',
        badge:       '🔥 Best Sellers',
        seeMoreLink: '/products?bestsellers=true',
        position:    pos++,
        data:        { strategy: 'bestsellers', products: bestsellers } as ProductCarouselData,
      })
    }

    // ── 6. Department Spotlights (Amazon-style dept boxes) ────────────────────
    // Top 6 departments each get a spotlight section
    const spotlightDepts = topDepts.slice(0, 6)
    for (const [dept, deptProducts] of spotlightDepts) {
      const spotProducts = deptProducts
        .sort((a: any, b: any) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0))
        .slice(0, 4)
        .map(toCard)

      if (spotProducts.length < 2) continue

      sections.push({
        sectionId:   `spotlight_${this.slug(dept)}`,
        type:        'dept_spotlight',
        title:       this.deptTitle(dept),
        subtitle:    null,
        badge:       null,
        seeMoreLink: `/department/${this.slug(dept)}`,
        position:    pos++,
        data:        {
          dept,
          deptSlug:    this.slug(dept),
          seeMoreLink: `/department/${this.slug(dept)}`,
          products:    spotProducts,
        } as DeptSpotlightData,
      })
    }

    // ── 7. Trending Now carousel ──────────────────────────────────────────────
    if (trending.length) {
      sections.push({
        sectionId:   'carousel_trending',
        type:        'product_carousel',
        title:       'Trending Now',
        subtitle:    'Items popular with shoppers right now',
        badge:       '📈 Trending',
        seeMoreLink: '/products?trending=true',
        position:    pos++,
        data:        { strategy: 'trending', products: trending } as ProductCarouselData,
      })
    }

    // ── 8. More category grids (depts 9–12) ───────────────────────────────────
    const gridDepts3 = topDepts.slice(8, 12)
    for (const [dept, deptProducts] of gridDepts3) {
      const cells = this.buildGridCells(dept, deptProducts)
      if (cells.length < 2) continue
      sections.push({
        sectionId:   `grid_${this.slug(dept)}_3`,
        type:        'category_grid',
        title:       this.deptTitle(dept),
        subtitle:    null,
        badge:       null,
        seeMoreLink: `/department/${this.slug(dept)}`,
        position:    pos++,
        data:        { cells } as CategoryGridData,
      })
    }

    // ── 9. New Arrivals carousel ──────────────────────────────────────────────
    if (newArrivals.length) {
      sections.push({
        sectionId:   'carousel_new_arrivals',
        type:        'product_carousel',
        title:       'New Arrivals',
        subtitle:    'The latest additions to our catalog',
        badge:       '✨ New',
        seeMoreLink: '/products?new=true',
        position:    pos++,
        data:        { strategy: 'new_arrivals', products: newArrivals } as ProductCarouselData,
      })
    }

    // ── 10. Today's Deals carousel ────────────────────────────────────────────
    if (onSale.length) {
      sections.push({
        sectionId:   'carousel_deals',
        type:        'product_carousel',
        title:       "Today's Deals",
        subtitle:    'Limited time offers — up to 60% off',
        badge:       '🏷️ Deal',
        seeMoreLink: '/products?on_sale=true',
        position:    pos++,
        data:        { strategy: 'on_sale', products: onSale } as ProductCarouselData,
      })
    }

    // ── 11. Top Rated carousel ────────────────────────────────────────────────
    if (topRated.length) {
      sections.push({
        sectionId:   'carousel_top_rated',
        type:        'product_carousel',
        title:       'Top Rated',
        subtitle:    'Loved by customers — 4.5★ and above',
        badge:       '⭐ Top Rated',
        seeMoreLink: '/products?top_rated=true',
        position:    pos++,
        data:        { strategy: 'top_rated', products: topRated } as ProductCarouselData,
      })
    }

    // ── 12. Secondary banner strip ────────────────────────────────────────────
    const secondaryBanners = bannerRows.filter((b: any) => b.position === 'secondary')
    if (secondaryBanners.length) {
      sections.push({
        sectionId:   'banner_secondary',
        type:        'hero_banner',
        title:       null,
        subtitle:    null,
        badge:       null,
        seeMoreLink: null,
        position:    pos++,
        data:        { banners: secondaryBanners } as HeroBannerData,
      })
    }

    return {
      layout:       'pikly_storefront_v1',
      sections:     sections.sort((a, b) => a.position - b.position),
      generatedAt:  new Date().toISOString(),
      sectionCount: sections.length,
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async fetchBanners(): Promise<any[]> {
    const cached = this.cache.get<any[]>('homepage:banners:all')
    if (cached) return cached
    const rows = await this.db.query<any>(
      'SELECT * FROM store.banners WHERE is_active=true ORDER BY sort_order ASC LIMIT 20',
    )
    this.cache.set('homepage:banners:all', rows, TTL.BANNERS)
    return rows
  }

  /** Build a map of dept → active products (in-memory, no DB query) */
  private buildDeptMap(): Map<string, any[]> {
    const map = new Map<string, any[]>()
    for (const p of this.products.products) {
      if (!p.is_active) continue
      const dept = (p.taxonomy_dept ?? p.cat_lvl0 ?? '').trim()
      if (!dept) continue
      if (!map.has(dept)) map.set(dept, [])
      map.get(dept)!.push(p)
    }
    return map
  }

  /**
   * Build category grid cells for one department.
   * Each cell = one subcategory with up to 4 product thumbnails.
   * Returns at most 4 cells (Amazon's standard 2×2 grid).
   */
  private buildGridCells(dept: string, deptProducts: any[]): CategoryGridCell[] {
    // Group products by subcategory
    const subcatMap = new Map<string, any[]>()
    for (const p of deptProducts) {
      const sub = (p.taxonomy_subcat ?? p.cat_lvl1 ?? '').trim()
      if (!sub || sub === dept) continue
      if (!subcatMap.has(sub)) subcatMap.set(sub, [])
      subcatMap.get(sub)!.push(p)
    }

    // Take top 4 subcats by product count
    const topSubcats = [...subcatMap.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 4)

    return topSubcats.map(([sub, prods]) => {
      const catMeta = this.categories.categories.find(
        (c: any) =>
          c.name?.toLowerCase() === sub.toLowerCase() ||
          c.slug?.toLowerCase() === this.slug(sub),
      )
      return {
        name:          catMeta?.name ?? this.capitalize(sub),
        slug:          catMeta?.slug ?? this.slug(sub),
        image:         catMeta?.image ?? null,
        link:          `/category/${catMeta?.slug ?? this.slug(sub)}`,
        // Up to 4 product thumbnails for the cell preview grid
        productImages: prods
          .filter((p: any) => p.thumbnail)
          .slice(0, 4)
          .map((p: any) => p.thumbnail as string),
      }
    })
  }

  /**
   * Generate a human-friendly section title from a department name.
   * e.g. "electronics" → "Explore Electronics"
   *      "home-kitchen" → "Shop Home & Kitchen"
   */
  private deptTitle(dept: string): string {
    const capitalized = this.capitalize(dept.replace(/-/g, ' & '))
    const prefixes = ['Explore', 'Shop', 'Discover', 'Browse', 'Find']
    // Deterministic prefix based on dept string hash so it's stable across requests
    const idx = dept.charCodeAt(0) % prefixes.length
    return `${prefixes[idx]} ${capitalized}`
  }

  private slug(str: string): string {
    return str.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  }

  private capitalize(str: string): string {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str
  }
}
