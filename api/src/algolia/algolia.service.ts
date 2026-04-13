/**
 * algolia.service.ts  —  Enterprise Search & Faceting
 *
 * ARCHITECTURE:
 *  • ALL facet counts come from Algolia — zero allProducts.filter() anywhere
 *  • Disjunctive faceting via multi-query batch (one query per active
 *    disjunctive dimension) — same pattern Amazon/eBay use
 *  • Algolia facet stats give price min/max scoped to result set
 *  • Graceful fallback to in-memory search if Algolia is down
 *  • Filter injection protection — all string values sanitised before
 *    being interpolated into Algolia filter strings
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { algoliasearch } from 'algoliasearch'
import type { Algoliasearch } from 'algoliasearch'
// Static import replaces the CommonJS require('fuse.js') call that was buried
// inside fusesuggestions().  Dynamic require() inside a class method:
//   • breaks tree-shaking / bundler analysis
//   • hides the dependency from TypeScript's module resolver
//   • can silently fail in ESM-strict environments
// The default export is the Fuse class; named import works across CJS/ESM.
import Fuse from 'fuse.js'
import {
  FACET_DIMENSIONS,
  DISJUNCTIVE_DIMENSIONS,
  ALGOLIA_FACET_SETTINGS,
  ALGOLIA_NUMERIC_ATTRS,
  SORT_INDEX_MAP,
} from './facet-config'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchQuery {
  q?: string
  category?: string
  subcategory?: string
  brand?: string
  minPrice?: number
  maxPrice?: number
  rating?: number
  discount?: number
  color?: string
  size?: string
  condition?: string
  warehouse?: string
  inStock?: boolean
  isPrime?: boolean
  freeShipping?: boolean
  expressAvailable?: boolean
  onSale?: boolean
  bestSeller?: boolean
  featured?: boolean
  newArrival?: boolean
  topRated?: boolean
  trending?: boolean
  newArrivalDays?: number
  attrs?: string
  sort?: string
  page?: number
  limit?: number
  cursor?: string
  includeFacets?: boolean
}

interface FacetValue {
  value: string
  label: string
  count: number
  selected: boolean
  hex?: string        // for color swatches
}

// ─── Sanitise helper — prevents filter injection ──────────────────────────────
// Strips characters that have meaning in Algolia filter syntax.
// A crafted value like:  Nike" OR brand:"Adidas
// becomes:               Nike OR brandAdidas  (harmless)

function sanitise(value: string): string {
  return value.replace(/["\\]/g, '').trim()
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class AlgoliaService implements OnModuleInit {
  private readonly logger = new Logger(AlgoliaService.name)

  // writeClient — initialised with the Admin API key.
  // ONLY used for index configuration and product indexing (write operations).
  // NEVER used for end-user search queries.
  private writeClient:  Algoliasearch | null = null

  // searchClient — initialised with the Search-Only API key (read-only).
  // Used for ALL end-user search and suggestions requests.
  // Falls back to writeClient when ALGOLIA_SEARCH_KEY is not configured
  // (development convenience only — always set both keys in production).
  private searchClient: Algoliasearch | null = null

  readonly INDEX_NAME = process.env.ALGOLIA_INDEX ?? 'products'

  // ── Init ──────────────────────────────────────────────────────────────────

  async onModuleInit() {
    const appId     = process.env.ALGOLIA_APP_ID
    const writeKey  = process.env.ALGOLIA_WRITE_KEY
    const searchKey = process.env.ALGOLIA_SEARCH_KEY   // Search-Only API key (read-only)

    if (!appId || !writeKey) {
      this.logger.warn('Algolia credentials missing — search will use in-memory fallback')
      return
    }
    try {
      // Admin client — write operations only
      this.writeClient  = algoliasearch(appId, writeKey)

      // Search client — all end-user queries use the restricted Search-Only key.
      // Falls back to writeClient if ALGOLIA_SEARCH_KEY is absent so that local
      // dev with only an admin key still works.  Production MUST have both keys.
      this.searchClient = searchKey
        ? algoliasearch(appId, searchKey)
        : this.writeClient

      if (!searchKey) {
        this.logger.warn(
          'ALGOLIA_SEARCH_KEY not set — falling back to admin key for search. ' +
          'Set a Search-Only API key in production to reduce blast radius.',
        )
      }

      this.logger.log(`Algolia clients initialised — index: "${this.INDEX_NAME}"`)
      // Run index configuration in the background — never block app startup.
      // configureIndex() makes 7+ API calls; on free-tier these can take minutes.
      // searchClient is already set so isReady() returns true immediately.
      this.configureIndex()
        .then(() => this.logger.log('Algolia index configuration complete'))
        .catch((err: any) => this.logger.error(`Algolia index configuration failed: ${err.message}`))
    } catch (err: any) {
      this.logger.error(`Algolia init failed: ${err.message}`)
      this.writeClient  = null
      this.searchClient = null
    }
  }

  isReady(): boolean { return this.searchClient !== null }

  // ── Index configuration ───────────────────────────────────────────────────

  private async configureIndex() {
    if (!this.writeClient) return

    const indexName = this.INDEX_NAME

    // ── Main index — full enterprise configuration ─────────────────────────────
    await this.writeClient.setSettings({
      indexName,
      indexSettings: {

        // ── Searchable attributes — ordered by relevance weight ────────────────
        // Position matters: title matches rank higher than description matches.
        // unordered() = any word position in field counts equally.
        searchableAttributes: [
          'title',                        // Exact title match = highest weight
          'brand',                        // Brand match = second priority
          'unordered(tags)',              // Tags can match in any order
          'unordered(asin)',              // Direct ASIN lookup
          'unordered(category)',          // Category name
          'unordered(subcategory)',       // Subcategory name
          'unordered(categoryPath)',      // Full path e.g. "Electronics > Laptops"
          'unordered(featureBullets)',    // Key features
          'unordered(description)',       // Description — lowest weight
        ],

        // ── Faceting — all filterable + facet-countable attributes ────────────
        attributesForFaceting: ALGOLIA_FACET_SETTINGS,

        // ── Numeric filtering — for range sliders ─────────────────────────────
        numericAttributesForFiltering: ALGOLIA_NUMERIC_ATTRS,

        // ── What to return in hits — return everything ────────────────────────
        attributesToRetrieve: ['*'],

        // ── Highlighting — snippet shown in search results ────────────────────
        // These fields get <em> tags around matched words
        attributesToHighlight: ['title', 'brand', 'description'],
        attributesToSnippet:   ['description:20', 'featureBullets:15'],
        highlightPreTag:       '<mark>',
        highlightPostTag:      '</mark>',

        // ── Custom ranking — tie-breaker after text relevance ─────────────────
        // Field names must match the Algolia record fields in toRecord() and
        // sync-algolia-pg.ts.  isBestSeller is canonical; bestSeller is old alias.
        customRanking: [
          'desc(isBestSeller)',   // Best sellers first (canonical)
          'desc(avgRating)',      // Higher rated next
          'desc(reviewCount)',    // More reviews = more trustworthy signal
          'desc(isPrime)',        // Prime products next
          'asc(discountPercent)', // Deprioritise heavily discounted items
        ],

        // ── Sort replicas — one index per sort option ─────────────────────────
        replicas: Object.values(SORT_INDEX_MAP).map((suffix) => `${indexName}${suffix}`),

        // ── Typo tolerance — forgive user spelling mistakes ───────────────────
        typoTolerance: true,
        minWordSizefor1Typo:  4,   // "lapto" → "laptop" ✅
        minWordSizefor2Typos: 8,   // "headphnes" → "headphones" ✅

        // ── Language processing ───────────────────────────────────────────────
        ignorePlurals:    true,    // "laptops" matches "laptop" ✅
        removeStopWords:  true,    // ignore "the", "a", "in" ✅

        // ── Distinct — deduplicate variants of same product ───────────────────
        // If a product has multiple attrValues entries, only show it once
        distinct:       false,     // Keep false — we already handle variants

        // ── Query rules — exact matches get boosted ───────────────────────────
        advancedSyntax: true,      // Support "exact phrase" and -exclude syntax

        // ── Pagination ────────────────────────────────────────────────────────
        hitsPerPage:    20,        // Default page size
        paginationLimitedTo: 1000, // Max results browsable (Algolia limit)

        // ── Performance ───────────────────────────────────────────────────────
        // Attributes NOT needed in search results — speeds up response
        unretrievableAttributes: [],

        // ── Ranking formula ───────────────────────────────────────────────────
        // Standard Algolia ranking: typo → geo → words → filters →
        //   proximity → attribute → exact → custom
        // We keep default + our custom ranking appended
        ranking: [
          'typo',       // Fewer typos = better match
          'geo',        // Geographic relevance
          'words',      // More query words matched = better
          'filters',    // Filtered results rank higher
          'proximity',  // Query words closer together = better
          'attribute',  // Earlier searchable attribute = better
          'exact',      // Exact word match = better
          'custom',     // Our custom ranking: bestSeller, avgRating, soldCount
        ],
      },
    })

    // ── Sort replica indexes — one per sort option ────────────────────────────
    // Each replica is a separate Algolia index with different ranking.
    // The frontend switches index based on the sort dropdown selection.
    const replicaConfigs: Array<{ name: string; field: string; dir: string; label: string }> = [
      { name: `${indexName}_price_asc`,     field: 'price',           dir: 'asc',  label: 'Price: Low to High'  },
      { name: `${indexName}_price_desc`,    field: 'price',           dir: 'desc', label: 'Price: High to Low'  },
      { name: `${indexName}_rating_desc`,   field: 'avgRating',       dir: 'desc', label: 'Top Rated'           },
      { name: `${indexName}_newest`,        field: 'createdAtMs',     dir: 'desc', label: 'Newest Arrivals'     },
      { name: `${indexName}_bestselling`,   field: 'soldCount',       dir: 'desc', label: 'Best Selling'        },
      { name: `${indexName}_discount_desc`, field: 'discountPercent', dir: 'desc', label: 'Biggest Discount'    },
    ]

    await Promise.allSettled(
      replicaConfigs.map(({ name, field, dir }) =>
        this.writeClient!.setSettings({
          indexName: name,
          indexSettings: {
            // Each replica only overrides ranking — inherits all other settings
            ranking: [
              `${dir}(${field})`,
              'typo', 'geo', 'words', 'filters',
              'proximity', 'attribute', 'exact', 'custom',
            ],
            // Replicas inherit all other settings; only override ranking + customRanking.
            // Use same canonical field names as main index.
            customRanking: [
              'desc(isBestSeller)',
              'desc(avgRating)',
              'desc(reviewCount)',
              'desc(isPrime)',
            ],
          },
        }),
      ),
    )

    this.logger.log(`Algolia index fully configured: "${indexName}" + ${replicaConfigs.length} replicas`)
  }

  // ── Record conversion ─────────────────────────────────────────────────────
  // Maps a PostgreSQL product row (from store.products) to an Algolia record.
  // Every field that faceting, filtering, or sorting depends on must be here.
  //
  // IMPORTANT: The new product schema stores flat Algolia helper fields
  // directly on the document (price, avgRating, attrValues, etc.) so we
  // prefer those and fall back to nested paths for backward compatibility.

  toRecord(product: any): Record<string, any> {
    // ── New schema field resolvers (scraped product structure) ────────────────
    // New: productResults.title/brand/rating/reviews/thumbnail/prime/etc.
    // Old: product.title/brand/avgRating/ratings/media/etc.
    // Both are supported transparently.
    const pr        = product.productResults ?? {}
    const flags     = product.flags         ?? {}
    const taxonomy  = product.taxonomy      ?? {}

    const resolvedTitle    = pr.title    ?? product.title    ?? ''
    const resolvedBrand    = pr.brand?.replace(/^Visit the\s+|\s+Store$/gi, '').trim()
                          ?? product.brand ?? ''
    const resolvedPrice    = product.price ?? pr.extracted_price ?? product.pricing?.current ?? 0
    const resolvedOldPrice = pr.extracted_old_price ?? product.pricing?.original ?? resolvedPrice
    const resolvedRating   = product.avgRating ?? pr.rating ?? product.ratings?.average ?? 0
    const resolvedReviews  = product.reviewCount ?? pr.reviews ?? product.ratings?.total ?? 0
    const resolvedDiscount = product.discountPercent ?? product.pricing?.discountPercent ?? 0
    const resolvedThumb    = pr.thumbnail ?? product.media?.mainImage ?? product.media?.images?.[0]?.url ?? ''
    const resolvedPrime    = product.isPrime   ?? flags.isPrime   ?? pr.prime   ?? false
    const resolvedFreeShip = product.isFreeShip ?? flags.isFreeShipping ?? false
    const resolvedInStock  = product.inStock   ?? flags.inStock   ?? true
    const resolvedTrending = product.isTrending ?? flags.isTrending ?? product.trending ?? false
    const resolvedBestSell = product.isBestSeller ?? flags.isBestSeller ?? product.bestSeller ?? false
    const resolvedChoice   = product.isAmazonChoice ?? flags.isAmazonsChoice ?? product.badges?.isAmazonsChoice ?? false
    const resolvedOnSale   = product.isOnSale ?? flags.isOnSale ?? product.onSale ?? false
    const resolvedDept     = taxonomy.department ?? product.category ?? ''
    const resolvedSubcat   = taxonomy.subcategory ?? product.subcategory ?? ''

    // ── attrValues ────────────────────────────────────────────────────────────
    // Prefer the pre-built attrValues array on the document.
    // Fall back to building from product.attributes for old records.
    let attrValues: string[] = product.attrValues ?? []
    if (attrValues.length === 0 && product.attributes && typeof product.attributes === 'object') {
      for (const [k, v] of Object.entries(product.attributes)) {
        if (v && v !== 'N/A' && v !== '' && !Array.isArray(v)) {
          attrValues.push(`${k}:${String(v)}`)
        }
      }
    }

    // ── Color hex map — built from variants for color swatch UI ───────────────
    const colorHexMap: Record<string, string> = {}
    for (const variant of product.variants ?? []) {
      if (variant.color && variant.colorHex) {
        colorHexMap[variant.color] = variant.colorHex
      }
    }

    // ── Sizes — deduplicated ───────────────────────────────────────────────────
    const sizes = [...new Set((product.sizes ?? []).map(String))]

    // ── Fields used directly in return (not covered by resolved* vars above) ────
    const soldCount = product.soldCount ?? product.inventory?.sold  ?? 0
    const stock     = product.availability?.stockLevel ?? product.inventory?.stock ?? 0
    const warehouse = product.warehouse ?? product.inventory?.warehouse ?? ''

    // ── createdAtMs — prefer stored value, fall back to createdAt date ─────────
    const createdAtMs     = product.createdAtMs      ?? new Date(product.createdAt ?? Date.now()).getTime()

    return {
      objectID:         product.asin ?? product.id,

      // ── Identity ────────────────────────────────────────────────────────────
      id:               product.id ?? product.asin,
      slug:             product.slug ?? product.asin,
      asin:             product.asin ?? '',
      title:            resolvedTitle,
      brand:            resolvedBrand,
      manufacturer:     product.manufacturer ?? resolvedBrand,

      // ── Category — supports both old (category slug) and new (taxonomy) ──────
      category:         product.catLvl0 ?? product.category ?? resolvedDept,
      subcategory:      product.catLvl1 ?? product.subcategory ?? resolvedSubcat,
      taxonomyDept:     resolvedDept,
      taxonomySubcat:   resolvedSubcat,
      // Algolia hierarchical faceting (lvl0-lvl6) for new schema
      'categories.lvl0': product.catLvl0 ?? resolvedDept,
      'categories.lvl1': product.catLvl1 ?? '',
      'categories.lvl2': product.catLvl2 ?? '',
      'categories.lvl3': product.catLvl3 ?? '',
      subSubcategory:   product.subSubcategory ?? '',
      categoryId:       product.categoryInfo?.id ?? '',
      categoryNodeId:   product.categoryInfo?.nodeId ?? '',
      categoryPath:     product.categoryInfo?.path ?? '',
      categoryName:     product.categoryInfo?.name ?? '',

      // ── Content ─────────────────────────────────────────────────────────────
      description:      product.description ?? '',
      tags:             product.tags ?? [],
      featureBullets:   product.featureBullets ?? [],

      // ── Pricing — numeric for range filters + sorting ────────────────────────
      price:            resolvedPrice,
      originalPrice:    resolvedOldPrice,
      discountPercent:  resolvedDiscount,
      discountAmount:   product.pricing?.discountAmount ?? 0,
      currency:         product.pricing?.currency ?? 'USD',
      hasCoupon:        product.pricing?.coupon?.hasCoupon ?? false,

      // ── Ratings — numeric for range filters ───────────────────────────────────
      avgRating:        resolvedRating,
      ratingCount:      resolvedReviews,

      // ── Inventory & availability ──────────────────────────────────────────────
      stock,
      soldCount,
      warehouse,
      inStock:          resolvedInStock,
      availabilityStatus: product.availability?.status ?? (resolvedInStock ? 'in_stock' : 'out_of_stock'),

      // ── Delivery & shipping ───────────────────────────────────────────────────
      // Field names MUST match sync-algolia-pg.ts toAlgoliaRecord() exactly.
      // Mismatches silently create two copies of the same logical field in the
      // index — only one is in attributesForFaceting so filters/counts break.
      isPrime:           resolvedPrime,
      isFreeShip:        resolvedFreeShip,      // was: freeShipping (wrong — sync uses isFreeShip)
      expressAvailable:  resolvedPrime,
      fulfilledByAmazon: product.delivery?.isFulfilledByAmazon ?? false,
      soldByAmazon:      product.delivery?.isSoldByAmazon ?? false,

      // ── Badge booleans — all query-aware via Algolia facets ───────────────────
      // Field names MUST match sync-algolia-pg.ts toAlgoliaRecord() exactly.
      featured:         resolvedChoice || resolvedBestSell,
      isBestSeller:     resolvedBestSell,       // was: bestSeller
      isNewRelease:     product.isNewRelease ?? flags.isNewRelease ?? product.newArrival ?? false, // was: newArrival
      isTrending:       resolvedTrending,       // was: trending
      // topRated threshold matches sync-algolia-pg.ts exactly (4.5★ + 100 reviews)
      topRated:         resolvedRating >= 4.5 && resolvedReviews >= 100,
      isOnSale:         resolvedOnSale,         // canonical
      isAmazonsChoice:  resolvedChoice,
      isDeal:           product.isDeal ?? flags.isDeal ?? product.pricing?.isDeal ?? false,
      recentSales:      product.badges?.recentSales ?? null,

      // ── String distribution buckets — MUST mirror sync-algolia-pg.ts exactly ───
      // These power "Price Range", "Customer Review", and "Discount" facet panels.
      // Both sync paths must produce identical bucket strings so Algolia can count
      // products from either path into the same bucket.
      priceRange: (() => {
        const p = resolvedPrice
        if (p <= 0)     return 'Price not available'
        if (p < 10)     return 'Under $10'
        if (p < 25)     return '$10 to $25'
        if (p < 50)     return '$25 to $50'
        if (p < 100)    return '$50 to $100'
        if (p < 200)    return '$100 to $200'
        if (p < 500)    return '$200 to $500'
        if (p < 1000)   return '$500 to $1,000'
        return 'Over $1,000'
      })(),
      ratingBucket: (() => {
        const r = resolvedRating
        if (r >= 4.5) return '4.5 Stars & Up'
        if (r >= 4.0) return '4 Stars & Up'
        if (r >= 3.5) return '3.5 Stars & Up'
        if (r >= 3.0) return '3 Stars & Up'
        return 'Under 3 Stars'
      })(),
      discountRange: (() => {
        const d = resolvedDiscount
        if (d <= 0)  return null    // null omitted by Algolia — no bucket for 0% discount
        if (d < 10)  return 'Up to 10% off'
        if (d < 25)  return '10% - 25% off'
        if (d < 50)  return '25% - 50% off'
        return 'Over 50% off'
      })(),

      // ── Condition ────────────────────────────────────────────────────────────
      condition:        product.condition ?? product.shipping?.condition ?? 'New',
      isActive:         product.isActive ?? true,

      // ── Variant-derived facets ────────────────────────────────────────────────
      colors:           product.colors ?? [],
      sizes,
      colorHexMap,

      // ── Dynamic attribute facets — POWERS ALL CATEGORY-SPECIFIC FILTERS ───────
      // attrValues = ["ram:16GB", "storage:512GB", "os:Windows 11", ...]
      // The frontend uses the category's facets config to know which attrKeys
      // to display (e.g. for Laptops: ram, storage, processor, gpu, screenSize)
      attrValues,
      attributes:       product.attributes ?? {},

      // ── Images ───────────────────────────────────────────────────────────────
      mainImage:        resolvedThumb,
      imageUrl:         resolvedThumb,
      thumb:            resolvedThumb,

      // ── Sort & filter numeric helpers ────────────────────────────────────────
      createdAtMs,
      createdAt:        product.createdAt,

      // ── Metadata ─────────────────────────────────────────────────────────────
      amazonUrl:        product.metadata?.amazonUrl ?? '',
      dateFirstAvailable: product.metadata?.dateFirstAvailable ?? '',
    }
  }

  // ── Sync operations ───────────────────────────────────────────────────────

  async syncAll(products: any[]): Promise<void> {
    if (!this.writeClient) return
    const objects = products.map((p) => this.toRecord(p))
    const CHUNK = 1000
    for (let i = 0; i < objects.length; i += CHUNK) {
      await this.writeClient.saveObjects({
        indexName: this.INDEX_NAME,
        objects: objects.slice(i, i + CHUNK),
      })
    }
    this.logger.log(`Algolia synced: ${objects.length} products`)
  }

  async syncOne(product: any): Promise<void> {
    if (!this.writeClient) return
    await this.writeClient.saveObjects({
      indexName: this.INDEX_NAME,
      objects: [this.toRecord(product)],
    })
  }

  async deleteOne(productId: string): Promise<void> {
    if (!this.writeClient) return
    await this.writeClient.deleteObject({ indexName: this.INDEX_NAME, objectID: productId })
  }

  // ── Filter string builder ─────────────────────────────────────────────────
  // Builds an Algolia filter string from query params.
  // excludeDim: when building a disjunctive query, exclude that dimension
  //             so its facet counts remain "open" for multi-select UI.

  buildFilters(query: SearchQuery, excludeDim?: string): string {
    const parts: string[] = []

    // NOTE: isActive not added here — it is not in Algolia attributesForFaceting
    // so filtering on it returns 0 results. Algolia index only contains active
    // products (syncAll pushes only isActive:true products).

    // Category & subcategory — conjunctive
    if (excludeDim !== 'category' && query.category) {
      parts.push(`category:"${sanitise(query.category)}"`)
    }
    if (excludeDim !== 'subcategory' && query.subcategory) {
      parts.push(`subcategory:"${sanitise(query.subcategory)}"`)
    }

    // Brand — disjunctive multi-select (comma-separated)
    if (excludeDim !== 'brand' && query.brand) {
      const brands = query.brand
        .split(',')
        .map((b) => `brand:"${sanitise(b)}"`)
        .filter(Boolean)
      if (brands.length > 0) parts.push(`(${brands.join(' OR ')})`)
    }

    // Price range — numeric filters
    if (excludeDim !== 'price') {
      if (query.minPrice != null && isFinite(query.minPrice)) {
        parts.push(`price >= ${Number(query.minPrice)}`)
      }
      if (query.maxPrice != null && isFinite(query.maxPrice)) {
        parts.push(`price <= ${Number(query.maxPrice)}`)
      }
    }

    // Rating — numeric minimum
    if (excludeDim !== 'rating' && query.rating != null) {
      parts.push(`avgRating >= ${Number(query.rating)}`)
    }

    // Discount — numeric minimum
    if (excludeDim !== 'discount' && query.discount != null) {
      parts.push(`discountPercent >= ${Number(query.discount)}`)
    }

    // Color — disjunctive multi-select
    if (excludeDim !== 'color' && query.color) {
      const colors = query.color
        .split(',')
        .map((c) => `colors:"${sanitise(c)}"`)
        .filter(Boolean)
      if (colors.length > 0) parts.push(`(${colors.join(' OR ')})`)
    }

    // Size — disjunctive multi-select
    if (excludeDim !== 'size' && query.size) {
      const sizes = query.size
        .split(',')
        .map((s) => `sizes:"${sanitise(s)}"`)
        .filter(Boolean)
      if (sizes.length > 0) parts.push(`(${sizes.join(' OR ')})`)
    }

    // Condition — conjunctive
    if (excludeDim !== 'condition' && query.condition) {
      parts.push(`condition:"${sanitise(query.condition)}"`)
    }

    // Warehouse — disjunctive
    if (excludeDim !== 'warehouse' && query.warehouse) {
      const warehouses = query.warehouse
        .split(',')
        .map((w) => `warehouse:"${sanitise(w)}"`)
        .filter(Boolean)
      if (warehouses.length > 0) parts.push(`(${warehouses.join(' OR ')})`)
    }

    // Dynamic attribute filters: attrs=ram:16GB,storage:512GB
    if (excludeDim !== 'attrs' && query.attrs) {
      for (const pair of query.attrs.split(',').map((a) => a.trim())) {
        const ci = pair.indexOf(':')
        if (ci !== -1) {
          const k = sanitise(pair.slice(0, ci).trim())
          const v = sanitise(pair.slice(ci + 1).trim())
          if (k && v) parts.push(`attrValues:"${k}:${v}"`)
        }
      }
    }

    // Boolean filters — query-aware counts via Algolia facets
    // [queryKey, algoliaField] — algoliaField MUST match toAlgoliaRecord() and sync-algolia-pg.ts.
    // excludeDim check is applied to ALL entries here so disjunctive sub-queries stay correct.
    const boolFilters: Array<[keyof SearchQuery, string]> = [
      ['inStock',          'inStock'],           // sync: inStock
      ['isPrime',          'isPrime'],           // sync: isPrime  ← was handled with (query as any), now unified
      ['freeShipping',     'isFreeShip'],        // sync: isFreeShip
      ['expressAvailable', 'expressAvailable'],  // sync: expressAvailable
      ['onSale',           'isOnSale'],          // sync: isOnSale
      ['bestSeller',       'isBestSeller'],      // sync: isBestSeller
      ['featured',         'featured'],          // sync: featured
      ['newArrival',       'isNewRelease'],      // sync: isNewRelease
      ['topRated',         'topRated'],          // sync: topRated
      ['trending',         'isTrending'],        // sync: isTrending
    ]
    for (const [qKey, algoliaKey] of boolFilters) {
      const val = query[qKey]
      if (excludeDim !== qKey && (val === true || val === 'true' || val === '1')) {
        parts.push(`${algoliaKey}:true`)
      }
    }

    // New arrivals by days — numeric timestamp filter
    if (excludeDim !== 'newArrivalDays' && query.newArrivalDays != null) {
      const days = Math.min(365, Math.max(1, Number(query.newArrivalDays)))
      parts.push(`createdAtMs >= ${Date.now() - days * 86_400_000}`)
    }

    return parts.join(' AND ')
  }

  // ── Get sort index name ───────────────────────────────────────────────────

  private getSortIndex(sort?: string): string {
    const suffix = SORT_INDEX_MAP[sort ?? '']
    return suffix ? `${this.INDEX_NAME}${suffix}` : this.INDEX_NAME
  }

  // ── Build facets response — ALL counts from Algolia ───────────────────────
  // mainFacets:  Algolia facet counts from the primary query (all filters applied)
  // disjFacets:  Algolia facet counts from per-dimension queries (dimension excluded)
  // facetStats:  Algolia numeric stats (min/max) scoped to result set
  // query:       original query for marking selected state

  private buildFacetsResponse(
    mainFacets:    Record<string, Record<string, number>>,
    disjFacets:    Record<string, Record<string, number>>,
    facetStats:    Record<string, { min: number; max: number }>,
    colorHexMap:   Record<string, string>,
    query:         SearchQuery,
    categoryLookup: Record<string, string> = {},  // slug → proper name
  ) {
    // For a disjunctive dimension, use the disjunctive query's counts
    // so multi-selected values still show correct totals
    const counts = (algoliaAttr: string) =>
      disjFacets[algoliaAttr] ?? mainFacets[algoliaAttr] ?? {}

    // Helper: slug → proper display name
    // "clothing-shoes-jewelry" → "Clothing, Shoes & Jewelry"
    const catName = (slug: string) =>
      categoryLookup[slug] ??
      slug.replace(/-/g, ' ').replace(/\w/g, (l) => l.toUpperCase())

    // ── Brands ───────────────────────────────────────────────────────────────
    const activeBrands = query.brand
      ? query.brand.split(',').map((b) => b.trim().toLowerCase())
      : []
    const brands: FacetValue[] = Object.entries(counts('brand'))
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        label: value,
        count,
        selected: activeBrands.includes(value.toLowerCase()),
      }))

    // ── Categories — use proper name from categories collection ─────────────
    const categories: FacetValue[] = Object.entries(counts('category'))
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        label:    catName(value),   // "Clothing, Shoes & Jewelry" not "Clothing Shoes Jewelry"
        count,
        selected: query.category === value,
      }))

    // ── Subcategories ─────────────────────────────────────────────────────────
    const subcategories: FacetValue[] = Object.entries(counts('subcategory'))
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        label:    catName(value),
        count,
        selected: query.subcategory === value,
      }))

    // ── Colors ────────────────────────────────────────────────────────────────
    const activeColors = query.color
      ? query.color.split(',').map((c) => c.trim().toLowerCase())
      : []
    const colors: FacetValue[] = Object.entries(counts('colors'))
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        label: value,
        count,
        hex: colorHexMap[value] ?? '#cccccc',
        selected: activeColors.includes(value.toLowerCase()),
      }))

    // ── Sizes ─────────────────────────────────────────────────────────────────
    const activeSizes = query.size
      ? query.size.split(',').map((s) => s.trim().toLowerCase())
      : []
    const sizes: FacetValue[] = Object.entries(counts('sizes'))
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        label: value,
        count,
        selected: activeSizes.includes(value.toLowerCase()),
      }))

    // ── Conditions ────────────────────────────────────────────────────────────
    const conditions: FacetValue[] = Object.entries(counts('condition'))
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        label: value,
        count,
        selected: query.condition === value,
      }))

    // ── Warehouses ────────────────────────────────────────────────────────────
    const activeWarehouses = query.warehouse
      ? query.warehouse.split(',').map((w) => w.trim().toLowerCase())
      : []
    const warehouses: FacetValue[] = Object.entries(counts('warehouse'))
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        label: value,
        count,
        selected: activeWarehouses.includes(value.toLowerCase()),
      }))

    // ── Dynamic attributes ────────────────────────────────────────────────────
    // attrValues contains "ram:16GB", "storage:512GB" etc.
    // We group by attribute key for the UI sidebar
    const activeAttrs: Record<string, string> = {}
    if (query.attrs) {
      for (const pair of query.attrs.split(',')) {
        const ci = pair.indexOf(':')
        if (ci !== -1) {
          activeAttrs[pair.slice(0, ci).trim()] = pair.slice(ci + 1).trim().toLowerCase()
        }
      }
    }
    const attrMap: Record<string, { value: string; count: number; selected: boolean }[]> = {}
    for (const [kv, count] of Object.entries(counts('attrValues'))) {
      const ci = kv.indexOf(':')
      if (ci === -1) continue
      const key   = kv.slice(0, ci)
      const value = kv.slice(ci + 1)
      if (!attrMap[key]) attrMap[key] = []
      attrMap[key].push({
        value,
        count,
        selected: activeAttrs[key] === value.toLowerCase(),
      })
    }
    for (const key of Object.keys(attrMap)) {
      attrMap[key].sort((a, b) => b.count - a.count)
    }

    // ── Price range — from Algolia facet stats (scoped to result set) ─────────
    // facetStats.price.min/max reflect only the products matching the query,
    // NOT the global catalog. This is what makes the price slider sensible.
    const priceStats = facetStats['price']
    const priceMin = priceStats ? Math.floor(priceStats.min) : 0
    const priceMax = priceStats ? Math.ceil(priceStats.max) : 9999

    // ── Price range buckets — from priceRange string facet ────────────────────
    // Counts come from Algolia (not computed here). Order matches sync-algolia-pg.ts.
    const priceRawCounts = mainFacets['priceRange'] ?? {}
    const PRICE_BUCKET_ORDER = [
      'Under $10', '$10 to $25', '$25 to $50', '$50 to $100',
      '$100 to $200', '$200 to $500', '$500 to $1,000', 'Over $1,000',
    ]
    const priceRangeBuckets = PRICE_BUCKET_ORDER.map((bucket) => ({
      value:    bucket,
      label:    bucket,
      count:    priceRawCounts[bucket] ?? 0,
      selected: false,   // price is a range slider, not a bucket selector
    })).filter((b) => b.count > 0)

    // ── Rating distribution — per star tier from ratingBucket facet ──────────
    // ratingBucket values come from Algolia counts (not computed here).
    // Using ratingBucket instead of facet stats gives accurate per-tier counts.
    const ratingBucketCounts = mainFacets['ratingBucket'] ?? {}
    const ratingStats = facetStats['avgRating']
    const ratings = [
      { value: 4.5, label: '4.5★ & above', bucket: '4.5 Stars & Up' },
      { value: 4.0, label: '4★ & above',   bucket: '4 Stars & Up'   },
      { value: 3.5, label: '3.5★ & above', bucket: '3.5 Stars & Up' },
      { value: 3.0, label: '3★ & above',   bucket: '3 Stars & Up'   },
    ].map(({ value, label, bucket }) => ({
      value,
      label,
      count:    ratingBucketCounts[bucket] ?? 0,
      selected: Number(query.rating) === value,
      min:      ratingStats?.min ?? 0,
      max:      ratingStats?.max ?? 5,
    }))

    // ── Discount ranges — per bucket from discountRange facet ─────────────────
    // Counts come from Algolia (not computed here). Numeric `value` is the
    // threshold passed to buildFilters() as discountPercent >= value.
    const discountBucketCounts = mainFacets['discountRange'] ?? {}
    const discountStats = facetStats['discountPercent']
    const discountRanges = [
      { value: 50, label: 'Over 50% off',   bucket: 'Over 50% off'   },
      { value: 25, label: '25% - 50% off',  bucket: '25% - 50% off'  },
      { value: 10, label: '10% - 25% off',  bucket: '10% - 25% off'  },
      { value: 5,  label: 'Up to 10% off',  bucket: 'Up to 10% off'  },
    ].map(({ value, label, bucket }) => ({
      value,
      label,
      count:    discountBucketCounts[bucket] ?? 0,
      selected: Number(query.discount) === value,
      max:      discountStats?.max ?? 100,
    }))

    // ── Boolean facets — counts from Algolia (query-aware) ────────────────────
    // mainFacets['inStock'] = { 'true': 1890, 'false': 450 }
    // Counts reflect ONLY the products matching the current query.
    // IMPORTANT: attribute names must match ALGOLIA_FACET_SETTINGS exactly.
    const getBoolCount = (attr: string) =>
      (mainFacets[attr]?.['true'] ?? 0)

    const availability = {
      inStock:         { count: getBoolCount('inStock'),          selected: query.inStock === true },
      isPrime:         { count: getBoolCount('isPrime'),          selected: query.isPrime === true },
      freeShipping:    { count: getBoolCount('isFreeShip'),       selected: query.freeShipping === true },
      expressDelivery: { count: getBoolCount('expressAvailable'), selected: query.expressAvailable === true },
    }

    const badges = {
      onSale:     { count: getBoolCount('isOnSale'),     selected: query.onSale === true },
      bestSeller: { count: getBoolCount('isBestSeller'), selected: query.bestSeller === true },
      featured:   { count: getBoolCount('featured'),     selected: query.featured === true },
      newArrival: { count: getBoolCount('isNewRelease'), selected: query.newArrival === true },
      topRated:   { count: getBoolCount('topRated'),     selected: query.topRated === true },
      trending:   { count: getBoolCount('isTrending'),   selected: query.trending === true },
    }

    // ── New arrivals ──────────────────────────────────────────────────────────
    const now = Date.now()
    const newArrivals = {
      last30Days: {
        timestampFilter: now - 30 * 86_400_000,
        selected: Number(query.newArrivalDays) === 30,
      },
      last90Days: {
        timestampFilter: now - 90 * 86_400_000,
        selected: Number(query.newArrivalDays) === 90,
      },
    }

    return {
      brands,
      categories,
      subcategories,
      colors,
      sizes,
      conditions,
      warehouses,
      attributes:  attrMap,
      priceRange: {
        min:     priceMin,
        max:     priceMax,
        current: {
          min: query.minPrice != null ? Number(query.minPrice) : priceMin,
          max: query.maxPrice != null ? Number(query.maxPrice) : priceMax,
        },
        buckets: priceRangeBuckets,
      },
      ratings,
      discountRanges,
      availability,
      badges,
      newArrivals,
    }
  }

  // ── Build applied filters list for UI "active chips" ─────────────────────
  // Every active filter is listed here so the frontend can show
  // "Brand: Dell ×  Color: Black ×  In Stock ×" chips.

  private buildAppliedFilters(query: SearchQuery): any[] {
    const applied: any[] = []

    if (query.q)           applied.push({ key: 'q',           value: query.q,           label: `Search: ${query.q}` })
    if (query.category)    applied.push({ key: 'category',    value: query.category,    label: `Category: ${query.category.replace(/-/g, ' ')}` })
    if (query.subcategory) applied.push({ key: 'subcategory', value: query.subcategory, label: `Subcategory: ${query.subcategory.replace(/-/g, ' ')}` })

    if (query.brand) {
      query.brand.split(',').forEach((b) =>
        applied.push({ key: 'brand', value: b.trim(), label: `Brand: ${b.trim()}` })
      )
    }
    if (query.minPrice != null) applied.push({ key: 'minPrice', value: query.minPrice, label: `Min: $${query.minPrice}` })
    if (query.maxPrice != null) applied.push({ key: 'maxPrice', value: query.maxPrice, label: `Max: $${query.maxPrice}` })
    if (query.rating)           applied.push({ key: 'rating',   value: query.rating,   label: `${query.rating}★ & above` })
    if (query.discount)         applied.push({ key: 'discount', value: query.discount,  label: `${query.discount}% off or more` })

    if (query.color) {
      query.color.split(',').forEach((c) =>
        applied.push({ key: 'color', value: c.trim(), label: `Color: ${c.trim()}` })
      )
    }
    if (query.size) {
      query.size.split(',').forEach((s) =>
        applied.push({ key: 'size', value: s.trim(), label: `Size: ${s.trim()}` })
      )
    }
    if (query.condition)        applied.push({ key: 'condition',        value: query.condition,        label: `Condition: ${query.condition}` })
    if (query.warehouse)        applied.push({ key: 'warehouse',        value: query.warehouse,        label: `Ships from: ${query.warehouse}` })
    if (query.inStock)          applied.push({ key: 'inStock',          value: true,                   label: 'In Stock' })
    if (query.freeShipping)     applied.push({ key: 'freeShipping',     value: true,                   label: 'Free Shipping' })
    if (query.expressAvailable) applied.push({ key: 'expressAvailable', value: true,                   label: 'Express Delivery' })
    if (query.onSale)           applied.push({ key: 'onSale',           value: true,                   label: 'On Sale' })
    if (query.bestSeller)       applied.push({ key: 'bestSeller',       value: true,                   label: 'Best Seller' })
    if (query.featured)         applied.push({ key: 'featured',         value: true,                   label: 'Featured' })
    if (query.newArrival)       applied.push({ key: 'newArrival',       value: true,                   label: 'New Arrival' })
    if (query.topRated)         applied.push({ key: 'topRated',         value: true,                   label: 'Top Rated' })
    if (query.trending)         applied.push({ key: 'trending',         value: true,                   label: 'Trending' })
    if (query.newArrivalDays)   applied.push({ key: 'newArrivalDays',   value: query.newArrivalDays,   label: `New in last ${query.newArrivalDays} days` })

    if (query.attrs) {
      query.attrs.split(',').forEach((pair) => {
        const ci = pair.indexOf(':')
        if (ci !== -1) {
          const k = pair.slice(0, ci).trim()
          const v = pair.slice(ci + 1).trim()
          if (k && v) applied.push({ key: `attrs:${k}`, value: v, label: `${k}: ${v}` })
        }
      })
    }

    return applied
  }

  // ── Search suggestions — Algolia-powered autocomplete ────────────────────
  // Returns 3 types of suggestions in one fast Algolia call:
  //   - products:   top 4 matching products (title, image, price, brand)
  //   - brands:     matching brands (from facet counts)
  //   - categories: matching categories (from facet counts)
  //   - queries:    helper search variations (under $X, brand filter)
  //
  // Uses hitsPerPage=4 + restrictSearchableAttributes for speed.
  // Falls back to in-memory Fuse.js if Algolia is unavailable.

  async getSuggestions(
    q: string,
    liveCategories: any[] = [],
    allProducts: any[] = [],
  ): Promise<{ suggestions: any[] }> {
    if (!q || q.trim().length < 2) return { suggestions: [] }

    const searchText = q.trim().slice(0, 100)

    // ── Algolia path ────────────────────────────────────────────────────────
    if (this.searchClient) {
      try {
        const response = await this.searchClient.search({
          requests: [
            // Request 0: top product hits
            {
              indexName:  this.INDEX_NAME,
              query:      searchText,
              hitsPerPage: 5,
              attributesToRetrieve: [
                'id', 'slug', 'asin', 'title', 'brand',
                'price', 'pricing', 'avgRating', 'ratings',
                'media', 'category', 'subcategory',
                'isPrime', 'onSale', 'badges',
              ],
              attributesToHighlight: ['title', 'brand'],
              highlightPreTag:  '<mark>',
              highlightPostTag: '</mark>',
              queryType:  'prefixLast',
              typoTolerance: true,
            },
            // Request 1: brand + category facet counts (0 hits, just counts)
            {
              indexName:  this.INDEX_NAME,
              query:      searchText,
              hitsPerPage: 0,
              facets:    ['brand', 'category', 'subcategory'],
              queryType: 'prefixLast',
            },
          ],
        })

        const hitsResult   = response.results[0] as any
        const facetsResult = response.results[1] as any
        const suggestions: any[] = []

        // ── Product suggestions ─────────────────────────────────────────────
        for (const hit of hitsResult.hits ?? []) {
          const { objectID, _highlightResult, _rankingInfo, _distinctSeqID, ...rest } = hit as any
          suggestions.push({
            type:      'product',
            title:     rest.title,
            titleHighlight: _highlightResult?.title?.value ?? rest.title,
            slug:      rest.slug,
            asin:      rest.asin ?? null,
            image:     rest.media?.mainImage ?? rest.media?.images?.[0]?.url ?? '',
            price:     rest.price ?? rest.pricing?.current ?? null,
            original:  rest.pricing?.original ?? null,
            discount:  rest.pricing?.discountPercent ?? 0,
            rating:    rest.avgRating ?? rest.ratings?.average ?? null,
            brand:     rest.brand ?? null,
            category:  rest.category ?? null,
            isPrime:   rest.isPrime ?? false,
            onSale:    rest.onSale ?? false,
            badge:     rest.badges?.isAmazonsChoice ? "Amazon's Choice"
                     : rest.badges?.isBestSeller   ? 'Best Seller'
                     : null,
          })
        }

        // ── Brand suggestions — from facet counts ───────────────────────────
        const brandFacets = facetsResult?.facets?.brand ?? {}
        const topBrands = Object.entries(brandFacets)
          .sort((a: any, b: any) => b[1] - a[1])
          .slice(0, 2)
          .filter(([name]) => name.toLowerCase().includes(searchText.toLowerCase()) || suggestions.some(s => s.brand === name))

        for (const [brand, count] of topBrands) {
          suggestions.push({
            type:    'brand',
            title:   brand,
            label:   `${brand} (${count} products)`,
            query:   `?brand=${encodeURIComponent(brand)}`,
            count:   count as number,
          })
        }

        // ── Category suggestions — from facet counts ────────────────────────
        const catFacets = facetsResult?.facets?.category ?? {}
        const topCats = Object.entries(catFacets)
          .sort((a: any, b: any) => b[1] - a[1])
          .slice(0, 2)

        for (const [catSlug, count] of topCats) {
          const catObj = liveCategories.find((c: any) => c.slug === catSlug)
          suggestions.push({
            type:    'category',
            title:   catObj?.name ?? catSlug.replace(/-/g, ' ').replace(/\w/g, (l: string) => l.toUpperCase()),
            slug:    catSlug,
            image:   catObj?.image ?? null,
            count:   count as number,
          })
        }

        // ── Query helper suggestions ────────────────────────────────────────
        const totalHits = hitsResult.nbHits ?? 0
        if (totalHits > 0) {
          suggestions.push({
            type:  'query',
            title: `${searchText} under $500`,
            query: `?q=${encodeURIComponent(searchText)}&maxPrice=500`,
          })
          if (totalHits > 10) {
            suggestions.push({
              type:  'query',
              title: `Top rated ${searchText}`,
              query: `?q=${encodeURIComponent(searchText)}&sort=rating_desc`,
            })
          }
        }

        return { suggestions: suggestions.slice(0, 10) }

      } catch (err: any) {
        this.logger.error(`Algolia suggestions failed: ${err.message}`)
        // Fall through to Fuse.js fallback below
      }
    }

    // ── Fuse.js fallback (Algolia down) ─────────────────────────────────────
    return this.fusesuggestions(searchText, liveCategories, allProducts)
  }

  // ── Fuse.js fallback suggestions ─────────────────────────────────────────
  private fusesuggestions(q: string, liveCategories: any[], allProducts: any[]) {
    // Fuse is now a static top-level import — no runtime require() needed.
    const suggestions: any[] = []

    new Fuse(allProducts, {
      keys: ['title', 'brand', 'tags'],
      threshold: 0.3,
      includeScore: true,
    })
      .search(q)
      .slice(0, 4)
      .forEach(({ item }: any) => {
        const p = item as any
        suggestions.push({
          type:      'product',
          title:     p.title,
          slug:      p.slug,
          asin:      p.asin ?? null,
          image:     p.media?.mainImage ?? p.media?.images?.[0]?.url ?? '',
          price:     p.price ?? p.pricing?.current ?? null,
          rating:    p.avgRating ?? p.ratings?.average ?? null,
          brand:     p.brand ?? null,
          category:  p.category ?? null,
        })
      })

    liveCategories
      .filter((c: any) => c.name?.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 2)
      .forEach((c: any) => suggestions.push({
        type:  'category',
        title: c.name,
        slug:  c.slug,
        image: c.image ?? null,
      }))

    suggestions.push({
      type:  'query',
      title: `${q} under $500`,
      query: `?q=${encodeURIComponent(q)}&maxPrice=500`,
    })

    return { suggestions: suggestions.slice(0, 8) }
  }

  // ── Main search ───────────────────────────────────────────────────────────
  // This is the only public method products.service.ts calls.
  // Returns products + fully query-aware facets in one response.

  async fullSearch(
    query: SearchQuery,
    allProducts: any[],
    liveCategories: any[] = [],
  ): Promise<{ data: any; cacheHit: false }> {
    if (!this.searchClient) {
      return this.fallbackSearch(query, allProducts)
    }

    try {
      return await this.algoliaSearch(query, allProducts, liveCategories)
    } catch (err: any) {
      this.logger.error(`Algolia search failed: ${err.message} — falling back to in-memory`)
      return this.fallbackSearch(query, allProducts)
    }
  }

  // ── Algolia search (primary path) ─────────────────────────────────────────

  private async algoliaSearch(
    query: SearchQuery,
    allProducts: any[],
    liveCategories: any[] = [],
  ): Promise<{ data: any; cacheHit: false }> {
    const indexName   = this.getSortIndex(query.sort)
    const baseFilters = this.buildFilters(query)
    const searchText  = String(query.q ?? '').slice(0, 512)
    const hitsPerPage = Math.min(Math.max(1, Number(query.limit ?? 20)), 100)

    // ── Pagination mode detection ─────────────────────────────────────────────
    // cursor provided  → cursor mode (Algolia searchAfter)
    // page provided    → offset mode
    // neither          → first page (offset mode, page=1)
    const isCursorMode = !!query.cursor
    const page         = isCursorMode ? 0 : Math.max(0, Number(query.page ?? 1) - 1)

    // ── Decode cursor ─────────────────────────────────────────────────────────
    // Two cursor formats:
    //   { algoliaCursor: "..." } → Algolia native cursor (preferred)
    //   { page: N, fallback: true } → offset fallback cursor
    let searchAfter: string | undefined  // Algolia native cursor string
    let cursorPage = 0                   // fallback offset page

    if (isCursorMode && query.cursor) {
      try {
        const decoded = Buffer.from(query.cursor, 'base64').toString('utf-8')
        const parsed  = JSON.parse(decoded)
        if (parsed.algoliaCursor) {
          searchAfter = parsed.algoliaCursor   // native Algolia cursor
        } else if (parsed.fallback && parsed.page) {
          cursorPage = Math.max(0, Number(parsed.page) - 1)  // offset fallback
        }
      } catch {
        searchAfter = undefined
        cursorPage  = 0
      }
    }

    // ── Build multi-query batch ───────────────────────────────────────────────
    // Request 0: main search query — returns hits + facet counts for all dims
    // Requests 1..N: one per active disjunctive dimension — returns facet
    //               counts with that dimension excluded so multi-select works

    const mainRequest: any = {
      indexName,
      query:      searchText,
      filters:    baseFilters,
      hitsPerPage,

      // facets: ['*'] → return ALL configured facets, same as Algolia dashboard
      // This is the key fix: instead of listing specific facets, we use wildcard
      // so whatever is configured on the index is returned — dashboard exact match
      facets: ['*'],

      // maxValuesPerFacet controls how many values are returned per facet attribute.
      // We set 500 to accommodate attrValues (specs) which can have hundreds of
      // unique key:value pairs per category. All other facets are capped by
      // per-dimension maxValues in buildFacetsResponse post-processing.
      maxValuesPerFacet: 500,

      // Return all fields
      attributesToRetrieve:  ['*'],

      // Highlighting — matched words in <mark> tags
      attributesToHighlight: ['title', 'brand'],
      highlightPreTag:       '<mark>',
      highlightPostTag:      '</mark>',

      // Analytics
      analytics:      true,
      clickAnalytics: true,
    }

    // ── Apply pagination to main request ────────────────────────────────────────
    if (isCursorMode && searchAfter) {
      // Native Algolia cursor — most efficient
      mainRequest.cursor = searchAfter
    } else if (isCursorMode && cursorPage > 0) {
      // Fallback offset cursor
      mainRequest.page = cursorPage
    } else {
      // Regular offset pagination
      mainRequest.page = page
    }

    const requests: any[] = [mainRequest]

    // Add one disjunctive query per active dimension
    const activeDimensions: string[] = []
    for (const dim of DISJUNCTIVE_DIMENSIONS) {
      const qKey = dim.queryKey
      const val  = (query as any)[qKey]
      if (!val) continue

      activeDimensions.push(qKey)
      requests.push({
        indexName,
        query:           searchText,
        filters:         this.buildFilters(query, qKey), // exclude this dim
        facets:          [dim.algoliaAttr],
        // Use the per-dimension maxValues so attrValues gets 500 while others get 100
        maxValuesPerFacet: dim.maxValues > 0 ? dim.maxValues : 100,
        page:            0,
        hitsPerPage:     0,   // no hits needed, just counts
        analytics:       false, // don't track disjunctive helper queries
      })
    }

    // ── Execute all queries in one Algolia API call ───────────────────────────
    const response    = await this.searchClient!.search({ requests })
    const mainResult  = response.results[0] as any
    const disjResults = response.results.slice(1) as any[]

    // ── Collect disjunctive facet counts ─────────────────────────────────────
    const disjFacets: Record<string, Record<string, number>> = {}
    for (let i = 0; i < activeDimensions.length; i++) {
      const dim       = DISJUNCTIVE_DIMENSIONS.find((d) => d.queryKey === activeDimensions[i])!
      const algoliaAttr = dim.algoliaAttr
      if (disjResults[i]?.facets?.[algoliaAttr]) {
        disjFacets[algoliaAttr] = disjResults[i].facets[algoliaAttr]
      }
    }

    // ── Extract facet stats (min/max per result set) ───────────────────────────
    const facetStats: Record<string, { min: number; max: number }> =
      (mainResult as any).facets_stats ?? {}

    // ── Build color hex map from in-memory products (lightweight lookup) ──────
    const colorHexMap: Record<string, string> = {}
    for (const p of allProducts) {
      for (const v of p.variants ?? []) {
        if (v.color && v.colorHex) colorHexMap[v.color] = v.colorHex
      }
    }

    // ── Strip Algolia-internal fields from hits ───────────────────────────────
    // Keep _highlightResult + _snippetResult — frontend uses them to show
    // matched word highlights in search results (Amazon-style bold keywords)
    const products = (mainResult.hits ?? []).map((hit: any) => {
      const { objectID, _rankingInfo, _distinctSeqID, ...rest } = hit
      return rest
    })

    const totalHits   = mainResult.nbHits  ?? 0
    const totalPages  = mainResult.nbPages ?? 1
    const currentPage = (mainResult.page   ?? 0) + 1

    // ── Cursor generation — ALWAYS generate nextCursor ──────────────────────────
    // nextCursor is generated for EVERY response (not just cursor-mode requests)
    // so frontend can switch to infinite scroll from any offset page, or start
    // fresh cursor-based pagination from the first page.
    const hits = mainResult.hits ?? []
    let nextCursor: string | null = null

    if (hits.length > 0 && hits.length === hitsPerPage) {
      // Strategy 1: use Algolia native cursor if available (v5 searchAfter)
      if (mainResult.cursor) {
        nextCursor = Buffer.from(JSON.stringify({ algoliaCursor: mainResult.cursor })).toString('base64')
      } else {
        // Strategy 2: offset-based cursor — encode next page number
        const nextPageNum = currentPage + 1
        nextCursor = Buffer.from(JSON.stringify({ page: nextPageNum, fallback: true })).toString('base64')
      }
    }

    const hasNextPage = hits.length === hitsPerPage && totalHits > currentPage * hitsPerPage
    const hasPrevPage = isCursorMode ? !!query.cursor : currentPage > 1

    // ── Pagination object — always includes both offset AND cursor fields ──────
    const pagination = isCursorMode
      ? {
          total:       totalHits,
          limit:       hitsPerPage,
          hasNextPage,
          hasPrevPage,
          nextCursor,
          prevCursor:  null,
          mode:        'cursor' as const,
        }
      : {
          total:       totalHits,
          limit:       hitsPerPage,
          page:        currentPage,
          totalPages,
          hasNextPage:  currentPage < totalPages,
          hasPrevPage:  currentPage > 1,
          nextCursor,   // ← always included so frontend can do infinite scroll
          mode:         'offset' as const,
        }

    // ── Facets — structured response via buildFacetsResponse ─────────────────
    // Replaces the old raw passthrough. buildFacetsResponse corrects attr names,
    // merges disjunctive counts, builds per-bucket counts for ratings/discounts/
    // prices, and marks selected state so the UI does zero post-processing.
    let facets: any = null
    if (query.includeFacets) {
      const mainFacets: Record<string, Record<string, number>> =
        (mainResult.facets as any) ?? {}

      // Build slug → display name lookup from liveCategories passed in from products.service
      const categoryLookup: Record<string, string> = {}
      for (const cat of liveCategories) {
        if (cat.slug && cat.name) categoryLookup[cat.slug] = cat.name
        for (const sub of cat.subcategories ?? []) {
          if (sub.slug && sub.name) categoryLookup[sub.slug] = sub.name
        }
      }

      facets = this.buildFacetsResponse(
        mainFacets,
        disjFacets,
        facetStats,
        colorHexMap,
        query,
        categoryLookup,
      )
    }

    return {
      data: {
        products,
        pagination,
        facets,
        appliedFilters: this.buildAppliedFilters(query),
        sortOptions: [
          { value: 'relevance',     label: 'Most Relevant' },
          { value: 'price_asc',     label: 'Price: Low to High' },
          { value: 'price_desc',    label: 'Price: High to Low' },
          { value: 'rating_desc',   label: 'Top Rated' },
          { value: 'newest',        label: 'Newest First' },
          { value: 'bestselling',   label: 'Best Selling' },
          { value: 'discount_desc', label: 'Biggest Discount' },
        ],
        searchMeta: {
          query:          query.q ?? null,
          totalResults:   totalHits,
          searchTime:     `${mainResult.processingTimeMS ?? 0}ms`,
          engine:         'algolia',
          paginationMode: isCursorMode ? 'cursor' : 'offset',
          index:          indexName,
          // Algolia query ID — needed for click analytics & A/B testing
          queryID:        mainResult.queryID ?? null,
          // Tell frontend if results are exhaustive or estimated
          exhaustiveNbHits: mainResult.exhaustiveNbHits ?? true,
          // Number of index operations used (useful for monitoring quota)
          serverTimeMS:   mainResult.serverTimeMS ?? null,
          // Applied filters summary
          hasFilters:     !!baseFilters.trim(),
        },
      },
      cacheHit: false,
    }
  }

  // ── In-memory fallback (when Algolia is down) ─────────────────────────────
  // Basic filtering from the in-memory product store.
  // No facets returned — just filtered hits with pagination.

  private fallbackSearch(
    query: SearchQuery,
    allProducts: any[],
  ): { data: any; cacheHit: false } {
    let results = [...allProducts]

    if (query.q) {
      const q = query.q.toLowerCase()
      results = results.filter(
        (p) =>
          p.title?.toLowerCase().includes(q) ||
          p.brand?.toLowerCase().includes(q) ||
          p.category?.toLowerCase().includes(q),
      )
    }
    if (query.category)    results = results.filter((p) => p.category === query.category)
    if (query.subcategory) results = results.filter((p) => p.subcategory === query.subcategory)
    if (query.brand) {
      const brands = query.brand.split(',').map((b) => b.trim().toLowerCase())
      results = results.filter((p) => brands.includes(p.brand?.toLowerCase()))
    }
    if (query.minPrice != null) results = results.filter((p) => (p.pricing?.current ?? 0) >= Number(query.minPrice))
    if (query.maxPrice != null) results = results.filter((p) => (p.pricing?.current ?? 0) <= Number(query.maxPrice))
    if (query.inStock)          results = results.filter((p) => (p.inventory?.stock ?? 0) > 0)
    if (query.onSale)           results = results.filter((p) => p.onSale)
    if (query.freeShipping)     results = results.filter((p) => p.shipping?.freeShipping)

    const page  = Math.max(1, Number(query.page ?? 1))
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)))
    const total = results.length
    const start = (page - 1) * limit
    const items = results.slice(start, start + limit)

    return {
      data: {
        products: items,
        pagination: {
          total,
          limit,
          page,
          totalPages:  Math.ceil(total / limit),
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1,
          mode:        'offset',
        },
        facets:         null,
        appliedFilters: this.buildAppliedFilters(query),
        sortOptions:    [],
        searchMeta: {
          query:          query.q ?? null,
          totalResults:   total,
          searchTime:     '0ms',
          engine:         'in-memory-fallback',
          paginationMode: 'offset',
        },
      },
      cacheHit: false,
    }
  }
}
