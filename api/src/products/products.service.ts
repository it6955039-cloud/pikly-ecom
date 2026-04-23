// src/products/products.service.ts — PostgreSQL + Algolia  (v5.0.0 — pikly dataset)
//
// Changes vs v4:
//  • parseHelpfulVotes() helper — handles "" and "N people found this helpful"
//    (pikly sends empty string; sort='helpful' now works correctly)
//  • findOne(): SELECT includes enrichment_source_data; response exposes it
//  • gThumbs() already handles p.thumbnails column (TEXT[]) — no change needed
//  • source default changed from 'oxylabs' to 'pikly' in response shape
//  • findAll(): two-tier cache (L1 NodeCache + L2 Redis/Upstash) — cacheHit now works
//
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common'
import Fuse from 'fuse.js'
import { AlgoliaService }      from '../algolia/algolia.service'
import { CategoriesService }   from '../categories/categories.service'
import { smartPaginate }       from '../common/api-utils'
import { CacheService, TTL }   from '../common/cache.service'
import { DatabaseService }     from '../database/database.service'
import { RedisService }        from '../redis/redis.service'
import { FilterProductsDto }   from './dto/filter-products.dto'
import { ReviewQueryDto }      from './dto/review-query.dto'
import { SubmitReviewDto }     from './dto/submit-review.dto'

// ── Field extractors ──────────────────────────────────────────────────────────
const gTitle   = (p: any): string => p.title ?? p.product_results?.title ?? ''
const gBrand   = (p: any): string =>
  (p.brand ?? p.product_results?.brand ?? '').replace(/^Visit the\s+|\s+Store\s*$/gi, '').trim()
const gPrice   = (p: any): number => p.price ?? p.product_results?.extracted_price ?? 0
const gOldPx   = (p: any): number | null =>
  p.original_price ?? p.product_results?.extracted_old_price ?? null
const gRating  = (p: any): number => p.avg_rating ?? p.product_results?.rating ?? 0
const gReviews = (p: any): number => p.review_count ?? p.product_results?.reviews ?? 0
const gDisc    = (p: any): number => p.discount_pct ?? 0
const gImage   = (p: any): string => p.thumbnail ?? p.product_results?.thumbnail ?? ''
const gThumbs  = (p: any): string[] => p.thumbnails ?? p.product_results?.thumbnails ?? []
const gInStock = (p: any): boolean => p.in_stock ?? p.flags?.inStock ?? true
const gPrime   = (p: any): boolean => p.is_prime ?? p.flags?.isPrime ?? false
const gOnSale  = (p: any): boolean => p.is_on_sale ?? p.flags?.isOnSale ?? false
const gDept    = (p: any): string => p.taxonomy_dept ?? ''
const gSubcat  = (p: any): string => p.taxonomy_subcat ?? ''

const gBadges = (p: any): string[] => {
  const b = new Set<string>(p.product_results?.badges ?? [])
  if (p.is_best_seller   || p.flags?.isBestSeller)    b.add('Best Seller')
  if (p.is_amazon_choice || p.flags?.isAmazonsChoice)  b.add("Amazon's Choice")
  if (p.is_trending      || p.flags?.isTrending)       b.add('Trending')
  if (p.is_free_ship     || p.flags?.isFreeShipping)   b.add('Free Shipping')
  if (p.is_deal          || p.flags?.isDeal)            b.add('Deal')
  if (p.is_new_release   || p.flags?.isNewRelease)     b.add('New Release')
  return [...b]
}

function buildFlags(p: any): Record<string, boolean> {
  const f = p.flags ?? {}
  return {
    isBestSeller:    f.isBestSeller    ?? p.is_best_seller    ?? false,
    isAmazonsChoice: f.isAmazonsChoice ?? p.is_amazon_choice  ?? false,
    isTrending:      f.isTrending      ?? p.is_trending       ?? false,
    isHighlyPopular: f.isHighlyPopular ?? false,
    isNewRelease:    f.isNewRelease    ?? p.is_new_release     ?? false,
    isFreeShipping:  f.isFreeShipping  ?? p.is_free_ship       ?? false,
    isPrime:         f.isPrime         ?? p.is_prime           ?? false,
    isOnSale:        f.isOnSale        ?? p.is_on_sale         ?? false,
    isDeal:          f.isDeal          ?? p.is_deal            ?? false,
    isTopRated:      f.isTopRated      ?? p.is_top_rated       ?? false,
    inStock:         f.inStock         ?? p.in_stock           ?? true,
  }
}

export function toCard(p: any) {
  return {
    asin:          p.asin,
    slug:          p.slug,
    title:         gTitle(p),
    brand:         gBrand(p),
    thumbnail:     gImage(p),
    thumbnails:    gThumbs(p),
    price:         gPrice(p),
    originalPrice: gOldPx(p),
    discountPct:   gDisc(p),
    avgRating:     gRating(p),
    reviewCount:   gReviews(p),
    isPrime:       gPrime(p),
    inStock:       gInStock(p),
    isOnSale:      gOnSale(p),
    badges:        gBadges(p).slice(0, 3),
    dept:          gDept(p),
    subcat:        gSubcat(p),
  }
}

// ── Helpful votes normaliser ──────────────────────────────────────────────────
//
// oxylabs: "84 people found this helpful"  → 84
// pikly:   ""                              → 0
// pikly:   "2 people found this helpful"   → 2
// either:  number                          → as-is
//
function parseHelpfulVotes(v: any): number {
  if (typeof v === 'number') return v
  const m = String(v ?? '').match(/\d+/)
  return m ? parseInt(m[0], 10) : 0
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class ProductsService implements OnModuleInit {
  private readonly logger = new Logger(ProductsService.name)
  products: any[] = []
  private loadingPromise: Promise<void> | null = null

  constructor(
    private readonly db:         DatabaseService,
    private readonly cache:      CacheService,
    private readonly redis:      RedisService,
    private readonly algolia:    AlgoliaService,
    private readonly categories: CategoriesService,
  ) {}

  async onModuleInit() {
    // Load products in the background so Nest can finish startup.
    // The in-memory store is still protected by ensureLoaded() for requests.
    this.loadingPromise = this.initializeAsync()
  }

  private async initializeAsync(): Promise<void> {
    this.logger.log('Products background initialization started')
    try {
      await this.db.waitUntilReady()
      await this.loadProducts()
      this.logger.log('Products initialized successfully')
      // Subscribe AFTER the initial load is confirmed good.
      // If loadProducts() throws, we never register the subscriber, which is
      // correct behaviour — the store would be in an unknown state.
      this.redis.subscribe('products:invalidate', () => {
        this.loadProducts().catch((err) =>
          this.logger.error(`products:invalidate reload failed: ${err.message}`),
        )
      })
    } catch (error) {
      this.logger.error(`Failed to initialize products: ${error}`)
    }
  }

  async ensureLoaded(): Promise<void> {
    if (this.loadingPromise) {
      await this.loadingPromise
    }
  }

  async loadProducts() {
    // IMPORTANT: only fetch lightweight scalar columns here.
    // Heavy JSONB columns are fetched ON-DEMAND in findOne().
    // thumbnails (TEXT[]) is lightweight enough to include here — it is used
    // in toCard() and does not transfer the bulk of heavy JSONB data.
    this.products = await this.db.query<any>(
      `SELECT asin, slug, source, is_active,
              taxonomy_dept, taxonomy_subcat,
              title, brand,
              price::float, original_price::float, discount_pct,
              avg_rating::float, review_count, bought_last_month, thumbnail,
              thumbnails,
              is_prime, is_free_ship, in_stock,
              is_best_seller, is_trending, is_top_rated, is_on_sale,
              is_amazon_choice, is_new_release, is_deal,
              cat_lvl0, cat_lvl1, cat_lvl2, cat_lvl3,
              colors, sizes, attr_values,
              flags, bestsellers_rank, created_at, updated_at
       FROM store.products WHERE is_active = true
       ORDER BY avg_rating DESC NULLS LAST`,
    )
    this.logger.log(`Products loaded: ${this.products.length}`)
  }

  async invalidate() {
    this.cache.delByPrefix('products:')
    this.cache.delByPrefix('homepage:')
    await this.loadProducts()
    await this.redis.publish('products:invalidate', Date.now().toString())
  }

  findActiveProducts() {
    return this.products
  }
  findProductByAsin(asin: string) {
    return this.products.find((p) => p.asin === asin)
  }
  findProductBySlug(slug: string) {
    return this.products.find((p) => p.slug === slug)
  }

  async getFeatured(limit = 20) {
    await this.ensureLoaded()
    return this.products
      .filter((p) => p.is_amazon_choice || p.is_best_seller)
      .sort((a, b) => gRating(b) - gRating(a))
      .slice(0, limit)
      .map(toCard)
  }
  async getBestSellers(limit = 20) {
    await this.ensureLoaded()
    return this.products
      .filter((p) => p.is_best_seller)
      .sort((a, b) => gRating(b) - gRating(a))
      .slice(0, limit)
      .map(toCard)
  }
  async getNewArrivals(limit = 20) {
    await this.ensureLoaded()
    return this.products
      .filter((p) => p.is_new_release)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit)
      .map(toCard)
  }
  async getTrending(limit = 20) {
    await this.ensureLoaded()
    return this.products
      .filter((p) => p.is_trending)
      .sort((a, b) => gRating(b) - gRating(a))
      .slice(0, limit)
      .map(toCard)
  }
  async getTopRated(limit = 20) {
    await this.ensureLoaded()
    return this.products
      .filter((p) => p.is_top_rated || (gRating(p) >= 4.5 && gReviews(p) >= 100))
      .sort((a, b) => gRating(b) - gRating(a))
      .slice(0, limit)
      .map(toCard)
  }
  async getOnSale(limit = 20) {
    await this.ensureLoaded()
    return this.products
      .filter((p) => gOnSale(p) || gDisc(p) >= 10)
      .sort((a, b) => gDisc(b) - gDisc(a))
      .slice(0, limit)
      .map(toCard)
  }
  async getByDept(dept: string, limit = 20) {
    await this.ensureLoaded()
    return this.products
      .filter((p) => gDept(p).toLowerCase() === dept.toLowerCase())
      .sort((a, b) => gRating(b) - gRating(a))
      .slice(0, limit)
      .map(toCard)
  }

  async getSuggestions(q: string, limit = 8) {
    await this.ensureLoaded()
    if (!q || q.trim().length < 2) return []
    const fuse = new Fuse(this.products, {
      keys: ['title', 'brand', 'taxonomy_dept'],
      threshold: 0.35,
      minMatchCharLength: 2,
    })
    return fuse.search(q.trim(), { limit }).map(({ item }: any) => ({
      asin:      item.asin,
      slug:      item.slug,
      title:     gTitle(item),
      brand:     gBrand(item),
      thumbnail: gImage(item),
      price:     gPrice(item),
      avgRating: gRating(item),
      dept:      gDept(item),
    }))
  }

  async findAll(query: FilterProductsDto) {
    // ── Two-tier cache check (L1 NodeCache + L2 Redis/Upstash) ───────────────
    // Stable key: sort query keys so {a:1,b:2} and {b:2,a:1} hit the same entry
    const sortedQuery = Object.keys(query as any)
      .sort()
      .reduce((acc: any, k) => { acc[k] = (query as any)[k]; return acc }, {})
    const cacheKey = `products:search:${JSON.stringify(sortedQuery)}`

    const cached = await this.cache.getAsync<any>(cacheKey)
    if (cached) {
      return { data: cached.value, cacheHit: true, cacheTier: cached.tier }
    }

    // ── Cache miss — run Algolia search ──────────────────────────────────────
    await this.ensureLoaded()
    await this.categories.ensureLoaded()
    const categories = this.categories.findAll()
    const result = await this.algolia.fullSearch(query as any, this.products, categories)

    // Persist to both L1 (NodeCache) and L2 (Redis/Upstash)
    this.cache.set(cacheKey, result.data, TTL.PRODUCTS)

    return { data: result.data, cacheHit: false, cacheTier: 'none' }
  }

  // ── findOne — canonical enterprise response shape ──────────────────────────
  async findOne(slugOrAsin: string) {
    await this.ensureLoaded()
    const p = this.findProductBySlug(slugOrAsin) ?? this.findProductByAsin(slugOrAsin)
    if (!p)
      throw new NotFoundException({
        code:    'PRODUCT_NOT_FOUND',
        message: `Product "${slugOrAsin}" not found`,
      })

    // Fetch heavy JSONB columns on-demand for this single product only.
    // enrichment_source_data added here (pikly v5) — contains asinVariationValues,
    // highResolutionImages, reviews with media, etc.
    const full =
      (await this.db.queryOne<any>(
        `SELECT product_results, purchase_options, protection_plan,
                item_specs, about_item, bought_together, related_products,
                product_details, accordion_content, reviews_info,
                category_breadcrumb, videos, shipping_fees,
                enrichment_source_data
         FROM store.products WHERE asin = $1`,
        [p.asin],
      )) ?? {}

    const related = this.products
      .filter((r) => gSubcat(r) === gSubcat(p) && r.asin !== p.asin)
      .sort((a, b) => Math.abs(gPrice(a) - gPrice(p)) - Math.abs(gPrice(b) - gPrice(p)))
      .slice(0, 8)
      .map(toCard)

    // bought_together comes from Discovery Engine output (stored in DB column)
    const rawBt: any[] = full.bought_together ?? []
    const frequentlyBoughtWith = rawBt.slice(0, 4).map((b: any) => ({
      asin:      b.asin ?? '',
      title:     (b.title ?? '').slice(0, 80),
      thumbnail: b.thumbnail ?? '',
      price:     b.price ?? b.extracted_price ?? 0,
      avgRating: b.rating ?? 0,
      reviews:   b.reviews ?? 0,
    }))

    const sf = full.shipping_fees ?? {}

    return {
      asin:   p.asin,
      slug:   p.slug,
      source: p.source ?? 'pikly',

      data: {
        product_results:     full.product_results     ?? {},
        purchase_options:    full.purchase_options    ?? {},
        protection_plan:     full.protection_plan     ?? [],
        item_specifications: full.item_specs          ?? {},
        about_item:          full.about_item          ?? [],
        bought_together:     rawBt,
        related_products:    full.related_products    ?? [],
        videos:              full.videos              ?? [],
        product_details:     full.product_details     ?? {},
        reviews_information: full.reviews_info        ?? {},
        category:            full.category_breadcrumb ?? [],
        accordionContent:    full.accordion_content   ?? [],
        shippingFees:        sf,
        bestsellers_rank:    p.bestsellers_rank       ?? [],
      },

      // enrichment_source_data: pikly-specific enrichment context.
      // Contains asinVariationValues, highResolutionImages, productInformation,
      // manufacturerProductImages, reviews (with media images), etc.
      enrichment_source_data: full.enrichment_source_data ?? {},

      _taxonomy: {
        department:  p.taxonomy_dept  ?? '',
        subcategory: p.taxonomy_subcat ?? '',
      },

      _flags: buildFlags(p),

      _computed: {
        title:         gTitle(p),
        brand:         gBrand(p),
        mainImage:     gImage(p),
        thumbnails:    gThumbs(p),
        price:         gPrice(p),
        originalPrice: gOldPx(p),
        discountPct:   gDisc(p),
        avgRating:     gRating(p),
        reviewCount:   gReviews(p),
        badges:        gBadges(p),
        inStock:       gInStock(p),
        isPrime:       gPrime(p),
        stockStatus:   gInStock(p) ? 'in_stock' : 'out_of_stock',
        deliveryEstimate: {
          options:    sf.deliveryOptions ?? full.product_results?.delivery ?? [],
          isFree:     sf.isFreeShipping  ?? gPrime(p),
          isPrime:    gPrime(p),
          soldBy:     sf.soldBy          ?? '',
          shipsFrom:  sf.shipsFrom       ?? '',
        },
        relatedProducts:      related,
        frequentlyBoughtWith,
      },
    }
  }

  async findReviews(slug: string, query: ReviewQueryDto) {
    await this.ensureLoaded()
    const p = this.findProductBySlug(slug) ?? this.findProductByAsin(slug)
    if (!p) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' })

    const row =
      (await this.db.queryOne<any>('SELECT reviews_info FROM store.products WHERE asin = $1', [
        p.asin,
      ])) ?? {}

    const ri = row.reviews_info ?? {}
    let reviews = [...(ri.authors_reviews ?? []), ...(ri.other_countries_reviews ?? [])]
    const { rating, verified, sort = 'newest', page = 1, limit = 10 } = query as any

    if (rating)
      reviews = reviews.filter((r: any) => Math.round(Number(r.rating ?? 0)) === Number(rating))
    if (verified) reviews = reviews.filter((r: any) => r.verified ?? r.is_verified)

    if (sort === 'newest')
      reviews.sort(
        (a: any, b: any) => new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime(),
      )
    else if (sort === 'helpful')
      // Fixed: parseHelpfulVotes handles both "" and "N people found this helpful"
      reviews.sort(
        (a: any, b: any) => parseHelpfulVotes(b.helpful_votes) - parseHelpfulVotes(a.helpful_votes),
      )
    else if (sort === 'rating_high')
      reviews.sort((a: any, b: any) => (b.rating ?? 0) - (a.rating ?? 0))
    else if (sort === 'rating_low')
      reviews.sort((a: any, b: any) => (a.rating ?? 0) - (b.rating ?? 0))

    return {
      reviews: smartPaginate(reviews, { page: Number(page), limit: Number(limit) }),
      summary: {
        average:      gRating(p),
        total:        gReviews(p),
        distribution: ri.summary?.customer_reviews ?? {},
      },
    }
  }

  async submitReview(slugOrAsin: string, userId: string, dto: SubmitReviewDto) {
    // Resolve the canonical product first — the controller passes a slug, but
    // product_reviews.asin must store the actual ASIN, not the slug.
    const p = this.findProductBySlug(slugOrAsin) ?? this.findProductByAsin(slugOrAsin)
    if (!p)
      throw new NotFoundException({
        code:    'PRODUCT_NOT_FOUND',
        message: `Product "${slugOrAsin}" not found`,
      })

    const exists = await this.db.queryOne(
      'SELECT id FROM store.product_reviews WHERE asin = $1 AND user_id = $2',
      [p.asin, userId],
    )
    if (exists)
      throw new BadRequestException({
        code:    'REVIEW_DUPLICATE',
        message: 'You already reviewed this product',
      })
    await this.db.execute(
      'INSERT INTO store.product_reviews (asin, user_id, title, body, rating) VALUES ($1,$2,$3,$4,$5)',
      [p.asin, userId, dto.title, dto.body, dto.rating],
    )
    await this.invalidate()
    return { message: 'Review submitted successfully' }
  }

  async adminFindAll(opts: { page?: number; limit?: number; search?: string; isActive?: boolean }) {
    const { page = 1, limit = 20, search, isActive } = opts
    const offset = (page - 1) * limit
    const conditions: string[] = []
    const params: any[] = []
    let idx = 1
    if (typeof isActive === 'boolean') {
      conditions.push(`is_active = $${idx++}`)
      params.push(isActive)
    }
    if (search) {
      conditions.push(`(title ILIKE $${idx} OR brand ILIKE $${idx} OR asin = $${idx})`)
      params.push(`%${search.replace(/[%_\\]/g, '\\$&')}%`)
      idx++
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const [rows, ct] = await Promise.all([
      this.db.query<any>(
        `SELECT asin,slug,title,brand,price,avg_rating,is_active,taxonomy_dept,thumbnail FROM store.products ${where} ORDER BY avg_rating DESC NULLS LAST LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      ),
      this.db.queryOne<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM store.products ${where}`,
        params,
      ),
    ])
    return {
      docs:       rows,
      total:      ct?.cnt ?? 0,
      page,
      limit,
      totalPages: Math.ceil((ct?.cnt ?? 0) / limit),
    }
  }

  async adminCreate(data: any) {
    const asin = data.asin ?? `PKL${Date.now()}`
    const slug = data.slug ?? asin.toLowerCase()
    const row = await this.db.queryOne<any>(
      `INSERT INTO store.products (asin,slug,title,brand,price,original_price,discount_pct,thumbnail,taxonomy_dept,taxonomy_subcat,is_active,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pikly') RETURNING asin,slug,title,brand,price,is_active`,
      [
        asin,
        slug,
        data.title         ?? '',
        data.brand         ?? '',
        data.price         ?? 0,
        data.originalPrice ?? null,
        data.discountPct   ?? 0,
        data.thumbnail     ?? null,
        data.taxonomyDept  ?? '',
        data.taxonomySubcat ?? '',
        data.isActive      ?? true,
      ],
    )
    await this.invalidate()
    return row
  }

  async adminUpdate(asin: string, data: any) {
    const allowed = [
      'title',
      'brand',
      'price',
      'original_price',
      'discount_pct',
      'is_active',
      'thumbnail',
      'taxonomy_dept',
      'taxonomy_subcat',
    ]
    const sets = ['updated_at = NOW()']
    const vals: any[] = []
    let i = 1
    for (const k of allowed) {
      const camel = k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())
      if (k in data) {
        sets.push(`${k} = $${i++}`)
        vals.push(data[k])
      } else if (camel in data) {
        sets.push(`${k} = $${i++}`)
        vals.push(data[camel])
      }
    }
    vals.push(asin)
    await this.db.execute(`UPDATE store.products SET ${sets.join(', ')} WHERE asin = $${i}`, vals)
    await this.invalidate()
    return { updated: true }
  }

  async adminDelete(asin: string) {
    await this.db.execute('UPDATE store.products SET is_active = false WHERE asin = $1', [asin])
    await this.invalidate()
    return { deleted: true }
  }
}
