import { Injectable, OnModuleInit } from '@nestjs/common'
import { CategoriesService } from '../categories/categories.service'
import { CacheService, TTL } from '../common/cache.service'
import { DatabaseService } from '../database/database.service'
import { ProductsService } from '../products/products.service'
import { RedisService } from '../redis/redis.service'

@Injectable()
export class HomepageService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly cache: CacheService,
    private readonly redis: RedisService,
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
  ) {}

  async onModuleInit() {
    this.redis.subscribe('homepage:invalidate', () => {
      this.cache.del('homepage:main')
      this.cache.del('homepage:banners')
    })
  }

  async getHomepage() {
    const cached = this.cache.get<any>('homepage:main')
    if (cached) return { ...cached, cacheHit: true }

    // Ensure products AND categories are loaded before using them
    await Promise.all([
      this.products.ensureLoaded(),
      this.categories.ensureLoaded(),
    ])

    // Run all data fetches in parallel — all methods are async with internal ensureLoaded guards
    const [banners, featured, bestsellers, trending, newArrivals, onSale, topRated, deptRows] =
      await Promise.all([
        this.getBanners(),
        this.products.getFeatured(12),
        this.products.getBestSellers(12),
        this.products.getTrending(12),
        this.products.getNewArrivals(12),
        this.products.getOnSale(12),
        this.products.getTopRated(12),
        this.db.query<{ name: string; product_count: number }>(
          `SELECT name, product_count
           FROM store.categories
           WHERE parent_id IS NULL AND is_active = true
           ORDER BY product_count DESC NULLS LAST
           LIMIT 24`,
        ),
      ])

    const featuredCats = this.categories.findAll(true).slice(0, 12)

    // Build dept spotlights — getByDept is now async so await each in parallel
    const deptSpotlights = (
      await Promise.all(
        deptRows.map(async (row) => ({
          dept: row.name,
          products: await this.products.getByDept(row.name, 4),
        })),
      )
    ).filter((d) => d.products.length > 0)

    const data = {
      banners,
      featured,
      bestsellers,
      trending,
      newArrivals,
      onSale,
      topRated,
      featuredCategories: featuredCats,
      deptSpotlights,
    }
    this.cache.set('homepage:main', data, TTL.HOMEPAGE)
    return { ...data, cacheHit: false }
  }

  async getBanners(position?: string) {
    const cacheKey = `homepage:banners:${position ?? 'all'}`
    const cached = this.cache.get<any[]>(cacheKey)
    if (cached) return cached
    const rows = await this.db.query<any>(
      position
        ? 'SELECT * FROM store.banners WHERE is_active=true AND position=$1 ORDER BY sort_order ASC LIMIT 10'
        : 'SELECT * FROM store.banners WHERE is_active=true ORDER BY sort_order ASC LIMIT 10',
      position ? [position] : [],
    )
    this.cache.set(cacheKey, rows, TTL.PRODUCTS)
    return rows
  }

  async adminGetBanners() {
    return this.db.query<any>('SELECT * FROM store.banners ORDER BY sort_order ASC')
  }

  async adminCreateBanner(dto: any) {
    const row = await this.db.queryOne<any>(
      `INSERT INTO store.banners
         (id, title, subtitle, image, link, cta_text, position,
          is_active, sort_order, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        dto.id ?? `banner_${Date.now()}`,
        dto.title,
        dto.subtitle ?? null,
        dto.image ?? null,
        dto.ctaLink ?? dto.link ?? null,
        dto.ctaText ?? null,
        dto.position ?? 'hero',
        dto.isActive ?? true,
        dto.sortOrder ?? 99,
        dto.startDate ?? null,
        dto.endDate ?? null,
      ],
    )
    // BUG-25: invalidate both caches — homepage:main embeds banners
    this.cache.del('homepage:banners')
    this.cache.del('homepage:main')
    return row
  }

  async adminUpdateBanner(id: string, dto: any) {
    const sets = ['updated_at=NOW()']
    const vals: any[] = []
    let i = 1
    // Map every possible camelCase DTO key to its snake_case DB column name
    const keyMap: Record<string, string> = {
      title:     'title',
      subtitle:  'subtitle',
      image:     'image',
      ctaLink:   'link',
      ctaText:   'cta_text',
      link:      'link',
      badge:     'badge',
      color:     'color',
      isActive:  'is_active',
      is_active: 'is_active',
      sortOrder: 'sort_order',
      sort_order:'sort_order',
      position:  'position',
      startDate: 'start_date',
      start_date:'start_date',
      endDate:   'end_date',
      end_date:  'end_date',
    }
    for (const [dtoKey, dbCol] of Object.entries(keyMap)) {
      if (dtoKey in dto) {
        // Avoid adding the same DB column twice when both camel and snake aliases appear
        const placeholder = `${dbCol}=$${i}`
        if (!sets.includes(placeholder)) {
          sets.push(placeholder)
          vals.push((dto as any)[dtoKey])
          i++
        }
      }
    }
    vals.push(id)
    const row = await this.db.queryOne<any>(
      `UPDATE store.banners SET ${sets.join(',')} WHERE id=$${i} RETURNING *`,
      vals,
    )
    // BUG-25: invalidate both caches — homepage:main embeds banners
    this.cache.del('homepage:banners')
    this.cache.del('homepage:main')
    return row
  }

  async adminDeleteBanner(id: string) {
    await this.db.execute('DELETE FROM store.banners WHERE id=$1', [id])
    this.cache.del('homepage:banners')
    return { deleted: true }
  }
}
