// src/departments/departments.service.ts

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
  thumbnail:    string | null
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

export interface DeptSearchFacets {
  subcategories: { name: string; slug: string; count: number }[]
  brands:        { name: string; count: number }[]
  priceRanges:   { label: string; min: number; max: number; count: number }[]
  ratings:       { label: string; min: number; count: number }[]
  flags: {
    inStock:     number
    onSale:      number
    prime:       number
    bestSeller:  number
  }
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

  // ── findAll ───────────────────────────────────────────────────────────────

  async findAll(): Promise<DepartmentCard[]> {
    await this.ensureLoaded()
    const deptMap = this.buildDeptMap()
    return [...deptMap.values()]
      .sort((a, b) => b.productCount - a.productCount)
  }

  // ── findOne ───────────────────────────────────────────────────────────────

  async findOne(slugOrName: string): Promise<DepartmentCard & { products: any[] }> {
    await this.ensureLoaded()
    const deptMap = this.buildDeptMap()

    let entry: DepartmentCard | undefined =
      deptMap.get(slugOrName) ??
      [...deptMap.values()].find(d => d.slug === slugOrName)

    if (!entry) {
      throw new NotFoundException({
        code:    'DEPARTMENT_NOT_FOUND',
        message: `Department "${slugOrName}" not found`,
      })
    }

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

  // ── findSubcategory ───────────────────────────────────────────────────────

  async findSubcategory(
    deptSlugOrName: string,
    subcatSlugOrName: string,
    opts: { page?: number; limit?: number } = {},
  ) {
    await this.ensureLoaded()
    const { page = 1, limit = 20 } = opts

    const deptMap = this.buildDeptMap()
    const deptEntry = deptMap.get(deptSlugOrName) ??
      [...deptMap.values()].find(d => d.slug === deptSlugOrName)

    if (!deptEntry) throw new NotFoundException({ code: 'DEPARTMENT_NOT_FOUND' })

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
      department:  deptEntry.name,
      deptSlug:    deptEntry.slug,
      subcategory: subcat.name,
      subcatSlug:  subcat.slug,
      priceRange:  subcat.priceRange,
      avgRating:   subcat.avgRating,
      products:    items,
      pagination:  { total, page, limit, totalPages, hasNext: page < totalPages },
    }
  }

  // ── searchInDepartment ────────────────────────────────────────────────────

  async searchInDepartment(
    slugOrName: string,
    opts: {
      q?:           string
      brand?:       string
      subcategory?: string
      minPrice?:    number
      maxPrice?:    number
      inStock?:     boolean
      minRating?:   number
      onSale?:      boolean
      prime?:       boolean
      page?:        number
      limit?:       number
      sortBy?:      'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'reviews'
    } = {},
  ) {
    await this.ensureLoaded()

    const deptMap = this.buildDeptMap()
    const deptEntry =
      deptMap.get(slugOrName) ??
      [...deptMap.values()].find(d => d.slug === slugOrName)

    if (!deptEntry) {
      throw new NotFoundException({
        code:    'DEPARTMENT_NOT_FOUND',
        message: `Department "${slugOrName}" not found`,
      })
    }

    const {
      q = '', brand, subcategory, minPrice, maxPrice,
      inStock, minRating, onSale, prime,
      page = 1, limit = 20,
      sortBy = 'relevance',
    } = opts

    // ── 1. Filter to department ───────────────────────────────────────────
    let deptProducts = this.products.products.filter(
      p => p.taxonomy_dept === deptEntry.name,
    )

    // ── 2. Full-text search (title / brand / asin / slug) ─────────────────
    const qLower = q.trim().toLowerCase()
    if (qLower) {
      const terms = qLower.split(/\s+/).filter(Boolean)
      deptProducts = deptProducts.filter(p => {
        const haystack = [p.title ?? '', p.brand ?? '', p.asin ?? '', p.slug ?? '']
          .join(' ').toLowerCase()
        return terms.every(t => haystack.includes(t))
      })
    }

    // ── 3. Compute facets from query-matched set BEFORE filters ───────────
    const facets = this.computeFacets(deptProducts)

    // ── 4. Apply filters ──────────────────────────────────────────────────
    let filtered = deptProducts

    if (brand) {
      const b = brand.toLowerCase()
      filtered = filtered.filter(p => (p.brand ?? '').toLowerCase().includes(b))
    }
    if (subcategory) {
      filtered = filtered.filter(
        p => p.taxonomy_subcat === subcategory || toSlug(p.taxonomy_subcat ?? '') === subcategory,
      )
    }
    if (minPrice !== undefined) filtered = filtered.filter(p => Number(p.price ?? 0) >= minPrice)
    if (maxPrice !== undefined) filtered = filtered.filter(p => Number(p.price ?? 0) <= maxPrice)
    if (inStock  === true)      filtered = filtered.filter(p => p.in_stock !== false)
    if (minRating !== undefined) filtered = filtered.filter(p => Number(p.avg_rating ?? 0) >= minRating)
    if (onSale   === true)      filtered = filtered.filter(p => p.is_on_sale === true)
    if (prime    === true)      filtered = filtered.filter(p => p.is_prime === true)

    // ── 5. Sort ───────────────────────────────────────────────────────────
    switch (sortBy) {
      case 'price_asc':  filtered.sort((a, b) => Number(a.price ?? 0) - Number(b.price ?? 0)); break
      case 'price_desc': filtered.sort((a, b) => Number(b.price ?? 0) - Number(a.price ?? 0)); break
      case 'rating':     filtered.sort((a, b) => Number(b.avg_rating ?? 0) - Number(a.avg_rating ?? 0)); break
      case 'reviews':    filtered.sort((a, b) => Number(b.review_count ?? 0) - Number(a.review_count ?? 0)); break
      default:
        if (!qLower) filtered.sort((a, b) => Number(b.avg_rating ?? 0) - Number(a.avg_rating ?? 0))
    }

    // ── 6. Paginate ───────────────────────────────────────────────────────
    const total      = filtered.length
    const totalPages = Math.ceil(total / limit)
    const items      = filtered
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
        isBestSeller:  p.is_best_seller ?? false,
        subcategory:   p.taxonomy_subcat ?? '',
      }))

    return {
      department: deptEntry.name,
      deptSlug:   deptEntry.slug,
      query:      q || null,
      filters:    { brand, subcategory, minPrice, maxPrice, inStock, minRating, onSale, prime },
      sortBy,
      products:   items,
      facets,
      pagination: { total, page, limit, totalPages, hasNext: page < totalPages },
    }
  }

  // ── Private: facets ───────────────────────────────────────────────────────

  private computeFacets(products: any[]): DeptSearchFacets {
    const subcatMap = new Map<string, number>()
    const brandMap  = new Map<string, number>()
    const flags     = { inStock: 0, onSale: 0, prime: 0, bestSeller: 0 }

    const PRICE_BUCKETS = [
      { label: 'Under $25',   min: 0,   max: 24.99,   count: 0 },
      { label: '$25 – $50',   min: 25,  max: 49.99,   count: 0 },
      { label: '$50 – $100',  min: 50,  max: 99.99,   count: 0 },
      { label: '$100 – $200', min: 100, max: 199.99,  count: 0 },
      { label: 'Over $200',   min: 200, max: Infinity, count: 0 },
    ]

    const RATING_BUCKETS = [
      { label: '4★ & up', min: 4, count: 0 },
      { label: '3★ & up', min: 3, count: 0 },
      { label: '2★ & up', min: 2, count: 0 },
    ]

    for (const p of products) {
      const subcat = (p.taxonomy_subcat ?? '').trim()
      if (subcat) subcatMap.set(subcat, (subcatMap.get(subcat) ?? 0) + 1)

      const brand = (p.brand ?? '').replace(/^Visit the\s+|\s+Store\s*$/gi, '').trim()
      if (brand) brandMap.set(brand, (brandMap.get(brand) ?? 0) + 1)

      const price = Number(p.price ?? 0)
      for (const b of PRICE_BUCKETS) {
        if (price >= b.min && price <= b.max) { b.count++; break }
      }

      const rating = Number(p.avg_rating ?? 0)
      for (const b of RATING_BUCKETS) {
        if (rating >= b.min) b.count++
      }

      if (p.in_stock !== false)    flags.inStock++
      if (p.is_on_sale === true)   flags.onSale++
      if (p.is_prime === true)     flags.prime++
      if (p.is_best_seller === true) flags.bestSeller++
    }

    return {
      subcategories: [...subcatMap.entries()]
        .map(([name, count]) => ({ name, slug: toSlug(name), count }))
        .sort((a, b) => b.count - a.count),

      brands: [...brandMap.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 30),

      priceRanges: PRICE_BUCKETS
        .filter(b => b.count > 0)
        .map(({ label, min, max, count }) => ({
          label, min, count,
          max: max === Infinity ? -1 : max,
        })),

      ratings: RATING_BUCKETS.filter(b => b.count > 0),
      flags,
    }
  }

  // ── Private: build dept map ───────────────────────────────────────────────

  private buildDeptMap(): Map<string, DepartmentCard> {
    const map = new Map<string, DepartmentCard>()

    for (const p of this.products.products) {
      const dept   = (p.taxonomy_dept   ?? '').trim()
      const subcat = (p.taxonomy_subcat ?? '').trim()
      const price  = Number(p.price ?? 0)
      const rating = Number(p.avg_rating ?? 0)

      if (!dept) continue

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
      if (!dEntry.thumbnail && p.thumbnail) dEntry.thumbnail = p.thumbnail

      if (p.is_best_seller) dEntry.flags.bestSellerCount++
      if (p.is_on_sale)     dEntry.flags.onSaleCount++
      if (p.is_prime)       dEntry.flags.primeCount++
      if (p.is_trending)    dEntry.flags.trendingCount++

      const brand = (p.brand ?? '').replace(/^Visit the\s+|\s+Store\s*$/gi, '').trim()
      if (brand && dEntry.topBrands.length < 10 && !dEntry.topBrands.includes(brand)) {
        dEntry.topBrands.push(brand)
      }

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
