/**
 * scripts/sync-algolia-pg.ts  —  PostgreSQL → Algolia sync  (v4.0.0)
 *
 * Replaces the old MongoDB-based sync-algolia.ts.
 * Reads all active products from store.products (PostgreSQL),
 * builds Algolia records, configures the index, and batch-saves.
 *
 * Usage:
 *   npx ts-node scripts/sync-algolia-pg.ts
 *   npx ts-node scripts/sync-algolia-pg.ts --configure-only   # just set index settings
 *   npx ts-node scripts/sync-algolia-pg.ts --clear-index      # clear Algolia first
 */

import * as dotenv from 'dotenv'
dotenv.config()

import { Pool }          from 'pg'
import { algoliasearch } from 'algoliasearch'
// Single source of truth for index settings — MUST stay in sync with algolia.service.ts.
// Importing here prevents the sync script from silently reverting facet config on every run.
import {
  ALGOLIA_FACET_SETTINGS,
  ALGOLIA_NUMERIC_ATTRS,
  SORT_INDEX_MAP,
} from '../src/algolia/facet-config'

const args          = process.argv.slice(2)
const CONFIGURE_ONLY = args.includes('--configure-only')
const CLEAR_INDEX    = args.includes('--clear-index')

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID!
const ALGOLIA_WRITE_KEY = process.env.ALGOLIA_WRITE_KEY!
const INDEX_NAME        = process.env.ALGOLIA_INDEX ?? 'products'
const CHUNK             = 1_000

if (!ALGOLIA_APP_ID || !ALGOLIA_WRITE_KEY) {
  console.error('❌  Missing env vars: ALGOLIA_APP_ID, ALGOLIA_WRITE_KEY')
  process.exit(1)
}

// ── Map a store.products row → Algolia record ─────────────────────────────────
function toAlgoliaRecord(row: any): Record<string, any> {

  const flags = row.flags            ?? {}

  return {
    objectID:         row.asin,
    asin:             row.asin,
    slug:             row.slug,
    title:            row.title ?? '',
    brand:            row.brand               ?? '',
    price:            Number(row.price)       ?? 0,
    originalPrice:    Number(row.original_price) || 0,
    discountPercent:  Number(row.discount_pct)   || 0,
    avgRating:        Number(row.avg_rating)     || 0,
    reviewCount:      Number(row.review_count)   || 0,
    thumbnail:        row.thumbnail ?? '',
    isPrime:          row.is_prime           ?? flags.isPrime     ?? false,
    isFreeShip:       row.is_free_ship       ?? flags.isFreeShipping ?? false,
    inStock:          row.in_stock           ?? flags.inStock     ?? true,
    isBestSeller:     row.is_best_seller     ?? flags.isBestSeller ?? false,
    isTrending:       row.is_trending        ?? flags.isTrending  ?? false,
    isOnSale:         row.is_on_sale         ?? flags.isOnSale    ?? false,
    isAmazonsChoice:  row.is_amazon_choice   ?? flags.isAmazonsChoice ?? false,
    isNewRelease:     row.is_new_release     ?? flags.isNewRelease ?? false,
    isDeal:           row.is_deal            ?? flags.isDeal      ?? false,
    taxonomyDept:     row.taxonomy_dept      ?? '',
    taxonomySubcat:   row.taxonomy_subcat    ?? '',
    // Flat category/subcategory slugs — needed by searchable(category) + searchable(subcategory)
    // in ALGOLIA_FACET_SETTINGS.  cat_lvl0/cat_lvl1 are the canonical DB columns for these.
    category:         row.cat_lvl0           ?? row.taxonomy_dept    ?? '',
    subcategory:      row.cat_lvl1           ?? row.taxonomy_subcat  ?? '',
    // Algolia hierarchical lvl0–lvl3 for category tree drill-down
    'categories.lvl0': row.cat_lvl0          ?? '',
    'categories.lvl1': row.cat_lvl1          ?? '',
    'categories.lvl2': row.cat_lvl2          ?? '',
    'categories.lvl3': row.cat_lvl3          ?? '',
    // condition + warehouse are not dedicated DB columns — read from flags JSONB or default.
    // They ARE in ALGOLIA_FACET_SETTINGS so every record must carry them (even if empty string).
    // Empty string means Algolia won't create a bucket — no harm, just no counts for that value.
    condition:        flags.condition        ?? row.condition  ?? 'New',
    warehouse:        flags.warehouse        ?? row.warehouse  ?? '',
    colors:           row.colors             ?? [],
    sizes:            row.sizes              ?? [],
    attrValues:       (row.attr_values ?? []).slice(0, 200), // trimRecord enforces 10KB hard limit
    createdAtMs:      new Date(row.created_at ?? Date.now()).getTime(),
    // ── Computed boolean fields — used by buildFilters() in algolia.service.ts ──
    // topRated:        true when avg_rating >= 4.5 AND review_count >= 100
    // featured:        true when Amazon's Choice OR Best Seller
    // expressAvailable: same as isPrime — Prime = express delivery for Amazon products
    // ── Price range buckets (Amazon-style) ────────────────────────────────────
    priceRange: (() => {
      const p = Number(row.price) || 0
      if (p === 0)    return 'Price not available'
      if (p < 10)     return 'Under $10'
      if (p < 25)     return '$10 to $25'
      if (p < 50)     return '$25 to $50'
      if (p < 100)    return '$50 to $100'
      if (p < 200)    return '$100 to $200'
      if (p < 500)    return '$200 to $500'
      if (p < 1000)   return '$500 to $1,000'
      return 'Over $1,000'
    })(),
    // ── Rating buckets (Amazon-style) ──────────────────────────────────────────
    ratingBucket: (() => {
      const r = Number(row.avg_rating) || 0
      if (r >= 4.5) return '4.5 Stars & Up'
      if (r >= 4.0) return '4 Stars & Up'
      if (r >= 3.5) return '3.5 Stars & Up'
      if (r >= 3.0) return '3 Stars & Up'
      return 'Under 3 Stars'
    })(),
    // ── Discount buckets ────────────────────────────────────────────────────────
    discountRange: (() => {
      const d = Number(row.discount_pct) || 0
      if (d === 0)  return null
      if (d < 10)   return 'Up to 10% off'
      if (d < 25)   return '10% - 25% off'
      if (d < 50)   return '25% - 50% off'
      return 'Over 50% off'
    })(),
    topRated:         (Number(row.avg_rating) >= 4.5 && Number(row.review_count) >= 100),
    featured:         Boolean(row.is_amazon_choice || row.is_best_seller),
    expressAvailable: Boolean(row.is_prime ?? false),
  }
}

// ── Configure Algolia index settings ─────────────────────────────────────────
// Uses ALGOLIA_FACET_SETTINGS and ALGOLIA_NUMERIC_ATTRS imported from facet-config.ts.
// This is the single source of truth — algolia.service.ts configureIndex() uses the same
// constants, so both code paths always push identical settings to Algolia.
async function configureIndex(client: any) {
  console.log('⚙️   Configuring Algolia index…')

  // Derive replica index names from the shared SORT_INDEX_MAP
  const replicaNames = Object.values(SORT_INDEX_MAP).map((suffix) => `${INDEX_NAME}${suffix}`)

  await client.setSettings({
    indexName:     INDEX_NAME,
    indexSettings: {
      // Searchable attributes — ordered by relevance weight.
      // Position matters: title matches outrank description matches.
      searchableAttributes: [
        'title',
        'brand',
        'unordered(tags)',
        'unordered(asin)',
        'unordered(taxonomyDept)',
        'unordered(taxonomySubcat)',
        'unordered(category)',
        'unordered(subcategory)',
        'unordered(categoryPath)',
        'unordered(featureBullets)',
        'unordered(attrValues)',
        'unordered(description)',
      ],
      // Imported from facet-config.ts — identical to what algolia.service.ts pushes.
      // Contains all facetable attributes WITHOUT filterOnly() so counts are returned.
      attributesForFaceting: ALGOLIA_FACET_SETTINGS,
      numericAttributesForFiltering: ALGOLIA_NUMERIC_ATTRS,
      customRanking: [
        'desc(isBestSeller)',
        'desc(avgRating)',
        'desc(reviewCount)',
        'desc(isPrime)',
      ],
      replicas: replicaNames,
      typoTolerance:        true,
      minWordSizefor1Typo:  4,
      minWordSizefor2Typos: 8,
      ignorePlurals:        true,
      removeStopWords:      true,
      advancedSyntax:       true,
      queryType:            'prefixLast',
      hitsPerPage:          20,
      // maxValuesPerFacet: 500 matches the search query setting in algolia.service.ts
      // so the dashboard view and API response always return the same counts.
      maxValuesPerFacet:    500,
      attributesToHighlight: ['title', 'brand'],
      highlightPreTag:       '<mark>',
      highlightPostTag:      '</mark>',
    },
  })

  // ── Sort replica indexes — one per sort option ──────────────────────────────
  // Each replica only overrides ranking; inherits all other settings from main.
  const replicaConfigs: Array<[string, string, string]> = [
    [`${INDEX_NAME}_price_asc`,    'price',           'asc' ],
    [`${INDEX_NAME}_price_desc`,   'price',           'desc'],
    [`${INDEX_NAME}_rating_desc`,  'avgRating',       'desc'],
    [`${INDEX_NAME}_newest`,       'createdAtMs',     'desc'],
    [`${INDEX_NAME}_discount_desc`,'discountPercent', 'desc'],
    [`${INDEX_NAME}_bestselling`,  'reviewCount',     'desc'],
  ]

  await Promise.allSettled(replicaConfigs.map(([name, field, dir]) =>
    client.setSettings({
      indexName: name,
      indexSettings: {
        ranking: [
          `${dir}(${field})`,
          'typo', 'geo', 'words', 'filters', 'proximity', 'attribute', 'exact', 'custom',
        ],
        customRanking: [
          'desc(isBestSeller)',
          'desc(avgRating)',
          'desc(reviewCount)',
          'desc(isPrime)',
        ],
      },
    }),
  ))

  console.log('✅  Index configured\n')
}


// ── Trim oversized records to fit Algolia 10KB limit ─────────────────────────
const ALGOLIA_MAX_BYTES = 9500
function byteSize(obj: any): number {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8')
}
function trimRecord(rec: Record<string, any>): Record<string, any> {
  if (byteSize(rec) <= ALGOLIA_MAX_BYTES) return rec
  for (const limit of [30, 20, 10, 5, 0]) {
    const t = { ...rec, attrValues: rec.attrValues.slice(0, limit) }
    if (byteSize(t) <= ALGOLIA_MAX_BYTES) return t
  }
  const r2 = { ...rec, attrValues: [], colors: [], sizes: [] }
  if (byteSize(r2) <= ALGOLIA_MAX_BYTES) return r2
  return { objectID: rec.objectID, asin: rec.asin, slug: rec.slug,
    title: rec.title, brand: rec.brand, price: rec.price,
    originalPrice: rec.originalPrice, discountPercent: rec.discountPercent,
    avgRating: rec.avgRating, reviewCount: rec.reviewCount,
    thumbnail: rec.thumbnail, isPrime: rec.isPrime, inStock: rec.inStock,
    isBestSeller: rec.isBestSeller, isOnSale: rec.isOnSale,
    taxonomyDept: rec.taxonomyDept, taxonomySubcat: rec.taxonomySubcat,
    'categories.lvl0': rec['categories.lvl0'], 'categories.lvl1': rec['categories.lvl1'],
    attrValues: [], colors: [], sizes: [], topRated: rec.topRated,
    featured: rec.featured, createdAtMs: rec.createdAtMs }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) { console.error('❌  DATABASE_URL not set'); process.exit(1) }

  const pool   = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_WRITE_KEY)

  await pool.query('SELECT 1')
  console.log('✅  PostgreSQL connected')
  console.log(`✅  Algolia client ready — index: "${INDEX_NAME}"\n`)

  await configureIndex(client)
  if (CONFIGURE_ONLY) { await pool.end(); return }

  if (CLEAR_INDEX) {
    await client.clearObjects({ indexName: INDEX_NAME })
    console.log('🗑️   Algolia index cleared\n')
  }

  const rows = await pool.query<any>(
    `SELECT asin, slug, source, title, brand, price::float, original_price::float,
            discount_pct, avg_rating::float, review_count, thumbnail,
            is_prime, is_free_ship, in_stock, is_best_seller, is_trending,
            is_on_sale, is_amazon_choice, is_new_release, is_deal,
            cat_lvl0, cat_lvl1, cat_lvl2, cat_lvl3, taxonomy_dept, taxonomy_subcat,
            colors, sizes, attr_values, flags, created_at
     FROM store.products WHERE is_active = true`,
  )

  console.log(`📦  ${rows.rows.length.toLocaleString()} active products found in PostgreSQL`)

  const objects = rows.rows.map(r => trimRecord(toAlgoliaRecord(r)))
  console.log(`🚀  Syncing to Algolia…`)

  for (let i = 0; i < objects.length; i += CHUNK) {
    await client.saveObjects({ indexName: INDEX_NAME, objects: objects.slice(i, i + CHUNK) })
    process.stdout.write(`\r   ${Math.min(i + CHUNK, objects.length).toLocaleString()} / ${objects.length.toLocaleString()}`)
  }

  console.log(`\n\n✅  Done — ${objects.length.toLocaleString()} records synced to Algolia.\n`)
  await pool.end()
}

main().catch(err => { console.error('\n❌  Fatal:', err.message); process.exit(1) })
