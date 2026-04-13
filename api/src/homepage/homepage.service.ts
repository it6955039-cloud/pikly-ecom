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
      `INSERT INTO store.banners (id,title,subtitle,image,link,badge,color,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        dto.id ?? `banner_${Date.now()}`,
        dto.title,
        dto.subtitle ?? null,
        dto.image,
        dto.link ?? null,
        dto.badge ?? null,
        dto.color ?? null,
        dto.sortOrder ?? 0,
      ],
    )
    this.cache.del('homepage:banners')
    return row
  }

  async adminUpdateBanner(id: string, dto: any) {
    const sets = ['updated_at=NOW()']
    const vals: any[] = []
    let i = 1
    for (const k of [
      'title',
      'subtitle',
      'image',
      'link',
      'badge',
      'color',
      'is_active',
      'sort_order',
    ]) {
      if (k in dto) {
        sets.push(`${k}=$${i++}`)
        vals.push(dto[k])
      }
    }
    vals.push(id)
    const row = await this.db.queryOne<any>(
      `UPDATE store.banners SET ${sets.join(',')} WHERE id=$${i} RETURNING *`,
      vals,
    )
    this.cache.del('homepage:banners')
    return row
  }

  async adminDeleteBanner(id: string) {
    await this.db.execute('DELETE FROM store.banners WHERE id=$1', [id])
    this.cache.del('homepage:banners')
    return { deleted: true }
  }
}
