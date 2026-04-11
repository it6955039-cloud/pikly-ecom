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
  const pr    = row.product_results  ?? {}
  const flags = row.flags            ?? {}

  return {
    objectID:         row.asin,
    asin:             row.asin,
    slug:             row.slug,
    title:            row.title               ?? pr.title        ?? '',
    brand:            row.brand               ?? '',
    price:            Number(row.price)       ?? 0,
    originalPrice:    Number(row.original_price) || 0,
    discountPercent:  Number(row.discount_pct)   || 0,
    avgRating:        Number(row.avg_rating)     || 0,
    reviewCount:      Number(row.review_count)   || 0,
    thumbnail:        row.thumbnail          ?? pr.thumbnail      ?? '',
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
    'categories.lvl0': row.cat_lvl0          ?? '',
    'categories.lvl1': row.cat_lvl1          ?? '',
    'categories.lvl2': row.cat_lvl2          ?? '',
    'categories.lvl3': row.cat_lvl3          ?? '',
    colors:           row.colors             ?? [],
    sizes:            row.sizes              ?? [],
    attrValues:       row.attr_values        ?? [],
    createdAtMs:      new Date(row.created_at ?? Date.now()).getTime(),
    // ── Computed boolean fields — used by buildFilters() in algolia.service.ts ──
    // topRated:        true when avg_rating >= 4.5 AND review_count >= 100
    // featured:        true when Amazon's Choice OR Best Seller
    // expressAvailable: same as isPrime — Prime = express delivery for Amazon products
    topRated:         (Number(row.avg_rating) >= 4.5 && Number(row.review_count) >= 100),
    featured:         Boolean(row.is_amazon_choice || row.is_best_seller),
    expressAvailable: Boolean(row.is_prime ?? false),
  }
}

// ── Configure Algolia index settings ─────────────────────────────────────────
async function configureIndex(client: any) {
  console.log('⚙️   Configuring Algolia index…')

  await client.setSettings({
    indexName:     INDEX_NAME,
    indexSettings: {
      searchableAttributes: [
        'title', 'brand',
        'unordered(taxonomyDept)', 'unordered(taxonomySubcat)',
        'unordered(attrValues)',
      ],
      attributesForFaceting: [
        'searchable(brand)', 'searchable(taxonomyDept)', 'searchable(taxonomySubcat)',
        'searchable(colors)', 'searchable(sizes)', 'attrValues',
        'inStock', 'isPrime', 'isFreeShip', 'isOnSale', 'isBestSeller',
        'isTrending', 'isNewRelease', 'isDeal', 'isAmazonsChoice',
        'topRated', 'featured', 'expressAvailable',
        'categories.lvl0', 'categories.lvl1', 'categories.lvl2', 'categories.lvl3',
      ],
      numericAttributesForFiltering: [
        'price', 'avgRating', 'discountPercent', 'reviewCount', 'createdAtMs',
      ],
      customRanking: [
        'desc(isBestSeller)', 'desc(avgRating)', 'desc(reviewCount)', 'desc(isPrime)',
      ],
      replicas: [
        `${INDEX_NAME}_price_asc`, `${INDEX_NAME}_price_desc`,
        `${INDEX_NAME}_rating_desc`, `${INDEX_NAME}_newest`,
        `${INDEX_NAME}_discount_desc`, `${INDEX_NAME}_bestselling`,
      ],
      typoTolerance:       true,
      minWordSizefor1Typo: 4,
      minWordSizefor2Typos:8,
      ignorePlurals:       true,
      removeStopWords:     true,
      advancedSyntax:      true,
      queryType:           'prefixLast',
      hitsPerPage:         20,
      maxFacetHits:        100,
      attributesToHighlight: ['title', 'brand'],
      highlightPreTag:       '<mark>',
      highlightPostTag:      '</mark>',
    },
  })

  // Sort replicas
  const replicas: [string, string, string][] = [
    [`${INDEX_NAME}_price_asc`,    'price',           'asc'],
    [`${INDEX_NAME}_price_desc`,   'price',           'desc'],
    [`${INDEX_NAME}_rating_desc`,  'avgRating',       'desc'],
    [`${INDEX_NAME}_newest`,       'createdAtMs',     'desc'],
    [`${INDEX_NAME}_discount_desc`,'discountPercent', 'desc'],
    [`${INDEX_NAME}_bestselling`,  'reviewCount',     'desc'],  // Most reviewed = best selling proxy
  ]

  await Promise.allSettled(replicas.map(([name, field, dir]) =>
    client.setSettings({
      indexName: name,
      indexSettings: {
        ranking: [`${dir}(${field})`, 'typo','geo','words','filters','proximity','attribute','exact','custom'],
      },
    }),
  ))

  console.log('✅  Index configured\n')
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
            colors, sizes, attr_values, product_results, flags, created_at
     FROM store.products WHERE is_active = true`,
  )

  console.log(`📦  ${rows.rows.length.toLocaleString()} active products found in PostgreSQL`)

  const objects = rows.rows.map(toAlgoliaRecord)
  console.log(`🚀  Syncing to Algolia…`)

  for (let i = 0; i < objects.length; i += CHUNK) {
    await client.saveObjects({ indexName: INDEX_NAME, objects: objects.slice(i, i + CHUNK) })
    process.stdout.write(`\r   ${Math.min(i + CHUNK, objects.length).toLocaleString()} / ${objects.length.toLocaleString()}`)
  }

  console.log(`\n\n✅  Done — ${objects.length.toLocaleString()} records synced to Algolia.\n`)
  await pool.end()
}

main().catch(err => { console.error('\n❌  Fatal:', err.message); process.exit(1) })
