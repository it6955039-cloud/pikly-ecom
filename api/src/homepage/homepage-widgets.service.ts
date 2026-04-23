// src/homepage/homepage-widgets.service.ts
//
// Widget Slot Resolution Engine — the backend equivalent of Amazon's "Alexa"
// page-composition framework.
//
// Responsibilities:
//   • Reads ordered, active widget rows from store.homepage_widgets
//   • Resolves each widget into its full data payload (products, banners, etc.)
//   • Caches resolved payloads in-memory (TTL: HOMEPAGE = 5 min)
//   • Invalidates cache via Redis pub/sub on any admin mutation
//   • Provides full admin CRUD + atomic reorder
//
// Dependency graph (no circular deps):
//   HomepageWidgetsService
//     ← DatabaseService (global)
//     ← CacheService    (global via CacheModule)
//     ← RedisService    (global via RedisModule)
//     ← ProductsService (re-exported by ProductsModule, already in HomepageModule)
//     ← CategoriesService (re-exported by CategoriesModule, already in HomepageModule)
//
// All methods that mutate the DB also publish 'homepage:invalidate' so that
// HomepageService (which subscribes to that channel) also flushes its cache.

import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common'
import { DatabaseService } from '../database/database.service'
import { CacheService, TTL } from '../common/cache.service'
import { RedisService } from '../redis/redis.service'
import { ProductsService, toCard } from '../products/products.service'
import { CategoriesService } from '../categories/categories.service'
import { CreateWidgetDto, UpdateWidgetDto, ReorderWidgetsDto } from './dto/homepage-widget.dto'

// ── Internal types ────────────────────────────────────────────────────────────

interface RawWidget {
  id: string
  type: string
  title: string | null
  subtitle: string | null
  badge: string | null
  config: Record<string, any>
  position: number
  is_active: boolean
  target: string
  created_at: Date
  updated_at: Date
}

export interface ResolvedWidget {
  id: string
  type: string
  title: string | null
  subtitle: string | null
  badge: string | null
  position: number
  target: string
  data: Record<string, any>
}

// Product carousel strategies supported by ProductsService
const CAROUSEL_STRATEGIES = [
  'featured',
  'bestsellers',
  'trending',
  'new_arrivals',
  'on_sale',
  'top_rated',
  'by_dept',
] as const

type CarouselStrategy = (typeof CAROUSEL_STRATEGIES)[number]

const WIDGETS_CACHE_KEY = 'homepage:widgets'
const WIDGETS_RAW_CACHE = 'homepage:widgets:raw'

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class HomepageWidgetsService implements OnModuleInit {
  private readonly logger = new Logger(HomepageWidgetsService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly cache: CacheService,
    private readonly redis: RedisService,
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
  ) {}

  async onModuleInit() {
    // Subscribe to the shared invalidation channel so that any admin mutation
    // (banner, product, widget) flushes the resolved widget cache too.
    this.redis.subscribe('homepage:invalidate', () => {
      this.cache.del(WIDGETS_CACHE_KEY)
      this.cache.del(WIDGETS_RAW_CACHE)
      this.logger.debug('Widget cache invalidated via pub/sub')
    })
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Returns the fully-resolved, ordered list of active homepage widgets.
   *
   * @param isAuthenticated - pass true for JWT-authenticated requests so that
   *   widgets with target='authenticated' are included and target='anonymous'
   *   are excluded. Defaults to false (anonymous visitor view).
   */
  async getActiveWidgets(isAuthenticated = false): Promise<ResolvedWidget[]> {
    const cacheKey = `${WIDGETS_CACHE_KEY}:${isAuthenticated ? 'auth' : 'anon'}`
    const cached = this.cache.get<ResolvedWidget[]>(cacheKey)
    if (cached) return cached

    // Guard: ensure in-memory stores are ready before resolution
    await Promise.all([this.products.ensureLoaded(), this.categories.ensureLoaded()])

    const raw = await this.fetchActiveRaw()

    // Filter by target audience
    const filtered = raw.filter((w) => {
      if (w.target === 'all') return true
      if (w.target === 'authenticated') return isAuthenticated
      if (w.target === 'anonymous') return !isAuthenticated
      return true
    })

    // Resolve all widgets in parallel — each resolver is independent
    const resolved = (
      await Promise.all(
        filtered.map((w) =>
          this.resolveWidget(w).catch((err) => {
            // A single failing widget must not crash the entire homepage response.
            // Log and return null — callers must filter nulls.
            this.logger.error(`Widget ${w.id} resolution failed: ${err.message}`)
            return null
          }),
        ),
      )
    ).filter((w): w is ResolvedWidget => w !== null)

    this.cache.set(cacheKey, resolved, TTL.HOMEPAGE)
    return resolved
  }

  // ── Admin CRUD ──────────────────────────────────────────────────────────────

  async adminFindAll(): Promise<RawWidget[]> {
    return this.db.query<RawWidget>(
      'SELECT * FROM store.homepage_widgets ORDER BY position ASC, created_at ASC',
    )
  }

  async adminCreate(dto: CreateWidgetDto): Promise<RawWidget> {
    const id = `hw_${Date.now()}`
    const row = await this.db.queryOne<RawWidget>(
      `INSERT INTO store.homepage_widgets
         (id, type, title, subtitle, badge, config, position, is_active, target)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        id,
        dto.type,
        dto.title ?? null,
        dto.subtitle ?? null,
        dto.badge ?? null,
        JSON.stringify(dto.config ?? {}),
        dto.position ?? 99,
        dto.isActive ?? true,
        dto.target ?? 'all',
      ],
    )
    if (!row) throw new Error('Widget insert failed')
    await this.invalidate()
    return row
  }

  async adminUpdate(id: string, dto: UpdateWidgetDto): Promise<RawWidget> {
    // Build SET clause dynamically — only touch columns present in the DTO
    const sets: string[] = ['updated_at = NOW()']
    const vals: any[] = []
    let idx = 1

    const colMap: Array<[keyof UpdateWidgetDto, string]> = [
      ['type', 'type'],
      ['title', 'title'],
      ['subtitle', 'subtitle'],
      ['badge', 'badge'],
      ['position', 'position'],
      ['isActive', 'is_active'],
      ['target', 'target'],
    ]

    for (const [dtoKey, dbCol] of colMap) {
      if (dtoKey in dto && dto[dtoKey] !== undefined) {
        sets.push(`${dbCol} = $${idx++}`)
        vals.push((dto as any)[dtoKey])
      }
    }

    // config is JSONB — serialise separately to avoid double-stringify issues
    if ('config' in dto && dto.config !== undefined) {
      sets.push(`config = $${idx++}`)
      vals.push(JSON.stringify(dto.config))
    }

    vals.push(id)
    const row = await this.db.queryOne<RawWidget>(
      `UPDATE store.homepage_widgets SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      vals,
    )
    if (!row)
      throw new NotFoundException({ code: 'WIDGET_NOT_FOUND', message: `Widget "${id}" not found` })
    await this.invalidate()
    return row
  }

  async adminDelete(id: string): Promise<{ deleted: boolean }> {
    const n = await this.db.execute('DELETE FROM store.homepage_widgets WHERE id = $1', [id])
    if (n === 0)
      throw new NotFoundException({ code: 'WIDGET_NOT_FOUND', message: `Widget "${id}" not found` })
    await this.invalidate()
    return { deleted: true }
  }

  /**
   * Atomically reorders widgets by assigning position = array index.
   * IDs not in the provided list are left unchanged.
   */
  async adminReorder(dto: ReorderWidgetsDto): Promise<{ reordered: number }> {
    // Run all position updates in a single transaction
    await this.db.transaction(async (client) => {
      for (let i = 0; i < dto.ids.length; i++) {
        await client.query(
          'UPDATE store.homepage_widgets SET position = $1, updated_at = NOW() WHERE id = $2',
          [i, dto.ids[i]],
        )
      }
    })
    await this.invalidate()
    return { reordered: dto.ids.length }
  }

  async adminToggle(id: string): Promise<RawWidget> {
    const current = await this.db.queryOne<RawWidget>(
      'SELECT * FROM store.homepage_widgets WHERE id = $1',
      [id],
    )
    if (!current) throw new NotFoundException({ code: 'WIDGET_NOT_FOUND' })
    return this.adminUpdate(id, { isActive: !current.is_active })
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async fetchActiveRaw(): Promise<RawWidget[]> {
    const cached = this.cache.get<RawWidget[]>(WIDGETS_RAW_CACHE)
    if (cached) return cached

    const rows = await this.db.query<RawWidget>(
      `SELECT * FROM store.homepage_widgets
       WHERE is_active = true
       ORDER BY position ASC, created_at ASC`,
    )
    this.cache.set(WIDGETS_RAW_CACHE, rows, TTL.HOMEPAGE)
    return rows
  }

  private async resolveWidget(widget: RawWidget): Promise<ResolvedWidget> {
    let data: Record<string, any>

    switch (widget.type) {
      case 'hero_banner':
        data = await this.resolveHeroBanner(widget.config)
        break
      case 'product_carousel':
        data = await this.resolveProductCarousel(widget.config)
        break
      case 'category_grid':
        data = await this.resolveCategoryGrid(widget.config)
        break
      case 'dept_spotlight':
        data = await this.resolveDeptSpotlight(widget.config)
        break
      case 'campaign':
        data = await this.resolveCampaign(widget.config)
        break
      default:
        data = {}
    }

    return {
      id: widget.id,
      type: widget.type,
      title: widget.title,
      subtitle: widget.subtitle,
      badge: widget.badge,
      position: widget.position,
      target: widget.target,
      data,
    }
  }

  // ── Widget resolvers ────────────────────────────────────────────────────────

  /**
   * hero_banner — fetches rows from store.banners filtered by position.
   * Config: { bannerPosition: 'hero' | 'secondary' | 'sidebar' | 'all' }
   */
  private async resolveHeroBanner(config: Record<string, any>): Promise<Record<string, any>> {
    const position = config.bannerPosition as string | undefined
    const now = new Date().toISOString()

    const rows = await this.db.query<any>(
      position && position !== 'all'
        ? `SELECT * FROM store.banners
           WHERE is_active = true AND position = $1
             AND (start_date IS NULL OR start_date <= $2)
             AND (end_date   IS NULL OR end_date   >= $2)
           ORDER BY sort_order ASC LIMIT 10`
        : `SELECT * FROM store.banners
           WHERE is_active = true
             AND (start_date IS NULL OR start_date <= $1)
             AND (end_date   IS NULL OR end_date   >= $1)
           ORDER BY sort_order ASC LIMIT 10`,
      position && position !== 'all' ? [position, now] : [now],
    )
    return { banners: rows, bannerPosition: position ?? 'all' }
  }

  /**
   * product_carousel — delegates to ProductsService strategy methods.
   * Config: { strategy, dept?, limit? }
   */
  private async resolveProductCarousel(config: Record<string, any>): Promise<Record<string, any>> {
    const strategy = (config.strategy ?? 'featured') as CarouselStrategy
    const limit = Math.min(Number(config.limit ?? 12), 50)
    const dept = config.dept as string | undefined

    let products: any[] = []

    switch (strategy) {
      case 'featured':
        products = await this.products.getFeatured(limit)
        break
      case 'bestsellers':
        products = await this.products.getBestSellers(limit)
        break
      case 'trending':
        products = await this.products.getTrending(limit)
        break
      case 'new_arrivals':
        products = await this.products.getNewArrivals(limit)
        break
      case 'on_sale':
        products = await this.products.getOnSale(limit)
        break
      case 'top_rated':
        products = await this.products.getTopRated(limit)
        break
      case 'by_dept':
        if (!dept) {
          this.logger.warn(`product_carousel with strategy="by_dept" missing config.dept`)
          products = []
        } else {
          products = await this.products.getByDept(dept, limit)
        }
        break
      default:
        this.logger.warn(`Unknown carousel strategy: ${strategy}`)
    }

    return { products, strategy, count: products.length }
  }

  /**
   * category_grid — the Amazon "2×N subcategory image grid" pattern.
   * e.g. "New home arrivals under $50" showing Kitchen, Home Improvement, Décor, Bedding.
   *
   * Config: { dept?, subcats?, maxPrice?, limit?, productsPerCell? }
   */
  private async resolveCategoryGrid(config: Record<string, any>): Promise<Record<string, any>> {
    const dept = config.dept as string | undefined
    const subcatFilter = (config.subcats ?? []) as string[]
    const maxPrice = config.maxPrice as number | undefined
    const limit = Math.min(Number(config.limit ?? 4), 12)
    const productsPerCell = Math.min(Number(config.productsPerCell ?? 2), 6)

    // Build a subcategory → products map from the in-memory store
    const subcatMap = new Map<string, any[]>()

    for (const p of this.products.products) {
      if (!p.is_active) continue
      if (dept && p.taxonomy_dept?.toLowerCase() !== dept.toLowerCase()) continue
      if (maxPrice !== undefined && p.price > maxPrice) continue

      const subcat: string = p.taxonomy_subcat ?? p.cat_lvl1 ?? ''
      if (!subcat) continue
      if (
        subcatFilter.length > 0 &&
        !subcatFilter.some((s) => s.toLowerCase() === subcat.toLowerCase())
      )
        continue

      if (!subcatMap.has(subcat)) subcatMap.set(subcat, [])
      subcatMap.get(subcat)!.push(p)
    }

    // Sort cells by product count desc, then take the top N
    const cells = Array.from(subcatMap.entries())
      .sort(([, a], [, b]) => b.length - a.length)
      .slice(0, limit)
      .map(([subcat, prods]) => ({
        subcategory: subcat,
        productCount: prods.length,
        // Representative products for the visual grid (image + title only)
        products: prods
          .sort((a: any, b: any) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0))
          .slice(0, productsPerCell)
          .map((p: any) => ({
            asin: p.asin,
            slug: p.slug,
            title: p.title ?? '',
            thumbnail: p.thumbnail ?? '',
            price: p.price ?? 0,
          })),
      }))

    return {
      cells,
      filterDept: dept ?? null,
      filterMaxPrice: maxPrice ?? null,
      cellCount: cells.length,
    }
  }

  /**
   * dept_spotlight — single department with a preview product grid.
   * Config: { dept, limit? }
   */
  private async resolveDeptSpotlight(config: Record<string, any>): Promise<Record<string, any>> {
    const dept = config.dept as string
    const limit = Math.min(Number(config.limit ?? 4), 20)

    if (!dept) {
      this.logger.warn('dept_spotlight widget missing config.dept')
      return { dept: null, products: [] }
    }

    const products = await this.products.getByDept(dept, limit)
    return { dept, products, count: products.length }
  }

  /**
   * campaign — themed product group (e.g. "Mother's Day Gifts", "Back to School").
   * Uses a strategy + optional dept filter — same approach as product_carousel
   * but semantically represents a time-limited or themed promotion.
   *
   * Config: { strategy?, dept?, limit? }
   */
  private async resolveCampaign(config: Record<string, any>): Promise<Record<string, any>> {
    const strategy = (config.strategy ?? 'featured') as CarouselStrategy
    const dept = config.dept as string | undefined
    const limit = Math.min(Number(config.limit ?? 8), 50)

    // Reuse carousel resolution then optionally filter by dept
    let { products } = await this.resolveProductCarousel({ strategy, limit: limit * 2 })

    if (dept) {
      products = (products as any[])
        .filter((p: any) => p.dept?.toLowerCase() === dept.toLowerCase())
        .slice(0, limit)
    } else {
      products = (products as any[]).slice(0, limit)
    }

    return { products, strategy, filterDept: dept ?? null, count: products.length }
  }

  // ── Cache invalidation ──────────────────────────────────────────────────────

  private async invalidate(): Promise<void> {
    // Clear both auth and anon resolved caches + raw cache
    this.cache.del(`${WIDGETS_CACHE_KEY}:auth`)
    this.cache.del(`${WIDGETS_CACHE_KEY}:anon`)
    this.cache.del(WIDGETS_RAW_CACHE)
    // Also invalidate the main homepage cache (banners change, products change, etc.)
    this.cache.del('homepage:main')
    this.cache.del('homepage:banners')
    // Signal all other processes to do the same
    await this.redis.publish('homepage:invalidate', Date.now().toString())
  }
}
