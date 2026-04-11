// src/departments/departments.service.ts
//
// Provides department-level catalog data derived directly from the
// ProductsService in-memory cache — zero extra DB queries on the hot path.
//
// Architecture note:
//   We deliberately compute departments from store.products at request time
//   rather than from store.categories because:
//   1. taxonomy_dept on products is the ground truth (seeded from _taxonomy)
//   2. store.categories might not be seeded, or might be stale
//   3. This gives accurate product counts with no sync delay
//
// All operations are O(n) over ~4,141 products in RAM — negligible latency.

import { Injectable, NotFoundException } from '@nestjs/common'
import { ProductsService } from '../products/products.service'

export interface DepartmentCard {
  slug:         string
  name:         string
  productCount: number
  subcategories: SubcatCard[]
  topBrands:    string[]
  priceRange:   { min: number; max: number }
  avgRating:    number
  thumbnail:    string | null   // first product thumbnail as dept hero image
  flags: {
    bestSellerCount: number
    onSaleCount:     number
    primeCount:      number
    trendingCount:   number
  }
}

export interface SubcatCard {
  slug:         string
  name:         string
  productCount: number
  priceRange:   { min: number; max: number }
  avgRating:    number
}

function toSlug(text: string): string {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .replace(/-$/, '')
}

@Injectable()
export class DepartmentsService {
  constructor(private readonly products: ProductsService) {}

  async ensureLoaded(): Promise<void> {
    await this.products.ensureLoaded()
  }

  // ── findAll — returns all departments with aggregated stats ───────────────

  async findAll(): Promise<DepartmentCard[]> {
    await this.ensureLoaded()
    const deptMap = this.buildDeptMap()
    return [...deptMap.values()]
      .sort((a, b) => b.productCount - a.productCount)
  }

  // ── findOne — single department + full subcategory breakdown ─────────────

  async findOne(slugOrName: string): Promise<DepartmentCard & { products: any[] }> {
    await this.ensureLoaded()
    const deptMap = this.buildDeptMap()

    // Match by slug or by raw dept name
    let entry: DepartmentCard | undefined =
      deptMap.get(slugOrName) ??
      [...deptMap.values()].find(d => d.slug === slugOrName)

    if (!entry) {
      throw new NotFoundException({
        code:    'DEPARTMENT_NOT_FOUND',
        message: `Department "${slugOrName}" not found`,
      })
    }

    // Top 8 featured products for this department (best rated)
    const deptName = entry.name
    const deptProducts = this.products.products
      .filter(p => p.taxonomy_dept === deptName)
      .sort((a, b) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0))
      .slice(0, 8)
      .map(p => ({
        asin:          p.asin,
        slug:          p.slug,
        title:         p.title ?? '',
        brand:         (p.brand ?? '').replace(/^Visit the\s+|\s+Store\s*$/gi, '').trim(),
        thumbnail:     p.thumbnail ?? null,
        price:         Number(p.price ?? 0),
        originalPrice: p.original_price ? Number(p.original_price) : null,
        discountPct:   p.discount_pct ?? 0,
        avgRating:     Number(p.avg_rating ?? 0),
        reviewCount:   p.review_count ?? 0,
        isPrime:       p.is_prime ?? false,
        inStock:       p.in_stock ?? true,
        isOnSale:      p.is_on_sale ?? false,
        subcat:        p.taxonomy_subcat ?? '',
      }))

    return { ...entry, products: deptProducts }
  }

  // ── findSubcategory — products within a specific dept > subcat ────────────

  async findSubcategory(
    deptSlugOrName: string,
    subcatSlugOrName: string,
    opts: { page?: number; limit?: number } = {},
  ) {
    await this.ensureLoaded()
    const { page = 1, limit = 20 } = opts

    // Resolve dept
    const deptMap = this.buildDeptMap()
    const deptEntry = deptMap.get(deptSlugOrName) ??
      [...deptMap.values()].find(d => d.slug === deptSlugOrName)

    if (!deptEntry) throw new NotFoundException({ code: 'DEPARTMENT_NOT_FOUND' })

    // Resolve subcat (by slug or raw name)
    const subcat = deptEntry.subcategories.find(
      s => s.slug === subcatSlugOrName || s.name === subcatSlugOrName,
    )
    if (!subcat) throw new NotFoundException({ code: 'SUBCATEGORY_NOT_FOUND' })

    const products = this.products.products
      .filter(p => p.taxonomy_dept === deptEntry.name && p.taxonomy_subcat === subcat.name)
      .sort((a, b) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0))

    const total      = products.length
    const totalPages = Math.ceil(total / limit)
    const items      = products
      .slice((page - 1) * limit, page * limit)
      .map(p => ({
        asin:          p.asin,
        slug:          p.slug,
        title:         p.title ?? '',
        brand:         (p.brand ?? '').replace(/^Visit the\s+|\s+Store\s*$/gi, '').trim(),
        thumbnail:     p.thumbnail ?? null,
        price:         Number(p.price ?? 0),
        originalPrice: p.original_price ? Number(p.original_price) : null,
        discountPct:   p.discount_pct ?? 0,
        avgRating:     Number(p.avg_rating ?? 0),
        reviewCount:   p.review_count ?? 0,
        isPrime:       p.is_prime ?? false,
        inStock:       p.in_stock ?? true,
        isOnSale:      p.is_on_sale ?? false,
      }))

    return {
      department:   deptEntry.name,
      deptSlug:     deptEntry.slug,
      subcategory:  subcat.name,
      subcatSlug:   subcat.slug,
      priceRange:   subcat.priceRange,
      avgRating:    subcat.avgRating,
      products:     items,
      pagination: { total, page, limit, totalPages, hasNext: page < totalPages },
    }
  }

  // ── Private: build dept map from in-memory products ──────────────────────

  private buildDeptMap(): Map<string, DepartmentCard> {
    const map = new Map<string, DepartmentCard>()

    for (const p of this.products.products) {
      const dept   = (p.taxonomy_dept    ?? '').trim()
      const subcat = (p.taxonomy_subcat  ?? '').trim()
      const price  = Number(p.price ?? 0)
      const rating = Number(p.avg_rating ?? 0)

      if (!dept) continue

      // ── Department level ────────────────────────────────────────────────
      if (!map.has(dept)) {
        map.set(dept, {
          slug:         toSlug(dept),
          name:         dept,
          productCount: 0,
          subcategories: [],
          topBrands:    [],
          priceRange:   { min: Infinity, max: 0 },
          avgRating:    0,
          thumbnail:    null,
          flags:        { bestSellerCount: 0, onSaleCount: 0, primeCount: 0, trendingCount: 0 },
        })
      }
      const dEntry = map.get(dept)!
      dEntry.productCount++
      if (price > 0) {
        if (price < dEntry.priceRange.min) dEntry.priceRange.min = price
        if (price > dEntry.priceRange.max) dEntry.priceRange.max = price
      }
      dEntry.avgRating = ((dEntry.avgRating * (dEntry.productCount - 1)) + rating) / dEntry.productCount

      // Thumbnail: use first product with an image
      if (!dEntry.thumbnail && p.thumbnail) dEntry.thumbnail = p.thumbnail

      // Flag counters
      if (p.is_best_seller) dEntry.flags.bestSellerCount++
      if (p.is_on_sale)     dEntry.flags.onSaleCount++
      if (p.is_prime)       dEntry.flags.primeCount++
      if (p.is_trending)    dEntry.flags.trendingCount++

      // Top brands (unique, up to 10)
      const brand = (p.brand ?? '').replace(/^Visit the\s+|\s+Store\s*$/gi, '').trim()
      if (brand && dEntry.topBrands.length < 10 && !dEntry.topBrands.includes(brand)) {
        dEntry.topBrands.push(brand)
      }

      // ── Subcategory level ───────────────────────────────────────────────
      if (!subcat) continue

      let sub = dEntry.subcategories.find(s => s.name === subcat)
      if (!sub) {
        sub = { slug: toSlug(subcat), name: subcat, productCount: 0, priceRange: { min: Infinity, max: 0 }, avgRating: 0 }
        dEntry.subcategories.push(sub)
      }
      sub.productCount++
      if (price > 0) {
        if (price < sub.priceRange.min) sub.priceRange.min = price
        if (price > sub.priceRange.max) sub.priceRange.max = price
      }
      sub.avgRating = ((sub.avgRating * (sub.productCount - 1)) + rating) / sub.productCount
    }

    // Clean up Infinity values and sort subcategories
    for (const d of map.values()) {
      if (d.priceRange.min === Infinity) d.priceRange.min = 0
      d.priceRange.min = Math.round(d.priceRange.min * 100) / 100
      d.priceRange.max = Math.round(d.priceRange.max * 100) / 100
      d.avgRating      = Math.round(d.avgRating * 10) / 10

      for (const s of d.subcategories) {
        if (s.priceRange.min === Infinity) s.priceRange.min = 0
        s.priceRange.min = Math.round(s.priceRange.min * 100) / 100
        s.priceRange.max = Math.round(s.priceRange.max * 100) / 100
        s.avgRating      = Math.round(s.avgRating * 10) / 10
      }

      d.subcategories.sort((a, b) => b.productCount - a.productCount)
    }

    return map
  }
}
