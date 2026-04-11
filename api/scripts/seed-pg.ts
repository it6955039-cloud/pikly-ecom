/**
 * scripts/seed-pg.ts  —  PostgreSQL product seeder  (v5.0.0 — pikly dataset)
 *
 * Changes vs v4:
 *  • Input file: products_discovery_enhanced.jsonl (post-engine) preferred
 *  • 6 new columns: thumbnails (TEXT[]), sponsored_brands, product_description,
 *    search_metadata, search_parameters, enrichment_source_data (JSONB)
 *  • bought_together / related_products: sourced from engine output
 *    raw.related_products.bought_together / raw.related_products.similar
 *    NOT from raw.data.bought_together / raw.data.related_products (scraper)
 *  • JSONB_COLS: explicit Set<string> — no more brittle string-match heuristic
 *  • helpful_votes: parseHelpfulVotes() handles "" and "N people found…"
 *
 * Usage:
 *   npx ts-node scripts/seed-pg.ts
 *   npx ts-node scripts/seed-pg.ts --limit 50
 *   npx ts-node scripts/seed-pg.ts --clear
 *   npx ts-node scripts/seed-pg.ts --file /path/to/file.jsonl
 *
 * Requires: DATABASE_URL in .env
 */

import * as dotenv from 'dotenv'
dotenv.config()

import * as fs       from 'fs'
import * as readline from 'readline'
import * as path     from 'path'
import * as crypto   from 'crypto'
import { Pool }      from 'pg'

// ── CLI args ──────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2)
const CLEAR   = args.includes('--clear')
const LIMIT_I = args.indexOf('--limit')
const LIMIT   = LIMIT_I !== -1 ? Number(args[LIMIT_I + 1]) : 0
const FILE_I  = args.indexOf('--file')
const BATCH   = 200

// ── JSONB columns — explicit Set prevents silent misses ───────────────────────
const JSONB_COLS = new Set([
  'product_results', 'purchase_options', 'protection_plan',
  'item_specs', 'about_item', 'bought_together', 'related_products',
  'product_details', 'accordion_content', 'reviews_info',
  'category_breadcrumb', 'videos', 'shipping_fees', 'flags', 'bestsellers_rank',
  // ── NEW (migration 004) ──────────────────────────────────────────────────
  'sponsored_brands',
  'product_description',
  'search_metadata',
  'search_parameters',
  'enrichment_source_data',
  // NOTE: 'thumbnails' intentionally excluded — it is TEXT[], not JSONB
])

// ── File resolution ───────────────────────────────────────────────────────────
function resolveFile(): string {
  if (FILE_I !== -1) {
    const f = args[FILE_I + 1]
    if (!f || !fs.existsSync(f)) { console.error(`❌  File not found: ${f}`); process.exit(1) }
    return f
  }
  const candidates = [
    // discovery-enhanced (post-engine) is the primary source
    path.join(process.cwd(), 'data', 'products_discovery_enhanced.jsonl'),
    path.join(process.cwd(), '..', 'api', 'data', 'products_discovery_enhanced.jsonl'),
    // fallback to cleaned (pre-engine) — bt/rp will be empty
    path.join(process.cwd(), 'data', 'products_cleaned.jsonl'),
    path.join(process.cwd(), '..', 'api', 'data', 'products_cleaned.jsonl'),
    // legacy name kept for backward compat during transition
    path.join(process.cwd(), 'data', 'products_enriched.jsonl'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) { console.log(`📂  Using: ${c}`); return c }
  }
  console.error('❌  No products JSONL file found. Provide --file <path> or place in data/.')
  process.exit(1)
}

// ── Slugify ───────────────────────────────────────────────────────────────────
function slugify(text: string, suffix = ''): string {
  const s = (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 80)
    .replace(/-$/, '')
  return suffix ? `${s}-${suffix}` : s
}

// ── parseHelpfulVotes ─────────────────────────────────────────────────────────
// oxylabs: "84 people found this helpful"
// pikly:   "" | "2 people found this helpful" | number
function parseHelpfulVotes(v: any): number {
  if (typeof v === 'number') return v
  const m = String(v ?? '').match(/\d+/)
  return m ? parseInt(m[0], 10) : 0
}

// ── Transform raw JSONL record → store.products row ───────────────────────────
function transform(raw: any): Record<string, any> | null {
  try {
    const pr    = raw.data?.product_results    ?? {}
    const pd    = raw.data?.product_details    ?? {}
    const tax   = raw._taxonomy               ?? {}
    const flags = raw._flags                  ?? {}

    const asin = raw.asin ?? ''
    if (!asin) return null

    const title  = (pr.title  ?? '').slice(0, 500)
    const brand  = (pr.brand  ?? '').replace(/^Visit the\s+|\s+Store\s*$/gi, '').trim()
    const price  = pr.extracted_price     ?? 0
    const oldPx  = pr.extracted_old_price ?? null
    const disc   = (price && oldPx && oldPx > price)
      ? Math.round((1 - price / oldPx) * 100) : 0

    const dept    = (tax.department  ?? '').slice(0, 200)
    const subcat  = (tax.subcategory ?? '').slice(0, 200)
    const catLvl0 = slugify(dept)
    const catLvl1 = subcat ? `${catLvl0} > ${slugify(subcat)}` : catLvl0

    // Colors / sizes from variant groups
    const colors: string[] = []
    const sizes:  string[] = []
    for (const vg of (pr.variants ?? [])) {
      const tl = (vg.title ?? '').toLowerCase()
      for (const item of (vg.items ?? [])) {
        if (!item.name) continue
        if (tl.includes('color') && !colors.includes(item.name)) colors.push(item.name)
        if (tl.includes('size')  && !sizes.includes(item.name))  sizes.push(item.name)
      }
    }

    // attrValues for Algolia faceting
    const attrValues: string[] = []
    const specs = { ...(raw.data?.item_specifications ?? {}), ...pd }
    const skipKeys = new Set(['asin','rating','reviews','customer_reviews','best_sellers_rank'])
    for (const [k, v] of Object.entries(specs)) {
      if (!skipKeys.has(k) && v && String(v).length < 100) {
        attrValues.push(`${k}:${String(v)}`)
      }
    }

    const slug = slugify(`${title.slice(0, 60)}-${asin}`)
    const hash = crypto.createHash('md5').update(asin).digest('hex').slice(0, 6)

    // ── Discovery Engine output (replaces scraper bt/rp) ──────────────────
    // After hybrid_discovery_engine.py runs, the JSONL has a top-level key:
    //   raw.related_products = { similar: [...], bought_together: [...] }
    // If the file is pre-engine (products_cleaned.jsonl), these default to [].
    const engineRp  = (raw.related_products && typeof raw.related_products === 'object'
      && !Array.isArray(raw.related_products))
      ? raw.related_products as Record<string, any>
      : {}
    const boughtTog    = engineRp.bought_together ?? []
    const relatedProds = engineRp.similar          ?? []

    // ── thumbnails: prefer highResolutionImages (pikly) → thumbnails → [] ──
    const thumbnails: string[] = pr.highResolutionImages ?? pr.thumbnails ?? []

    return {
      asin,
      slug: `${slug}-${hash}`,
      is_active:        true,
      source:           raw.source ?? 'pikly',
      taxonomy_dept:    dept,
      taxonomy_subcat:  subcat,
      title,
      brand,
      price,
      original_price:   oldPx,
      discount_pct:     disc,
      avg_rating:       pr.rating  ?? 0,
      review_count:     pr.reviews ?? 0,
      bought_last_month: pr.bought_last_month ?? null,
      thumbnail:        pr.thumbnail   ?? null,
      is_prime:         flags.isPrime         ?? pr.prime        ?? false,
      is_free_ship:     flags.isFreeShipping  ?? false,
      in_stock:         flags.inStock         ?? (pr.stock ?? '').toLowerCase().includes('in stock'),
      is_best_seller:   flags.isBestSeller    ?? false,
      is_trending:      flags.isTrending      ?? false,
      is_top_rated:     flags.isTopRated      ?? false,
      is_on_sale:       flags.isOnSale        ?? disc > 0,
      is_amazon_choice: flags.isAmazonsChoice ?? false,
      is_new_release:   flags.isNewRelease    ?? false,
      is_deal:          flags.isDeal          ?? false,
      cat_lvl0:         catLvl0,
      cat_lvl1:         catLvl1,
      cat_lvl2:         null,
      cat_lvl3:         null,
      colors,
      sizes,
      attr_values:      attrValues,
      product_results:  JSON.stringify(pr),
      purchase_options: JSON.stringify(raw.data?.purchase_options   ?? {}),
      protection_plan:  JSON.stringify(raw.data?.protection_plan    ?? []),
      item_specs:       JSON.stringify(raw.data?.item_specifications ?? {}),
      about_item:       JSON.stringify(raw.data?.about_item         ?? []),
      // Engine output — NOT raw.data.bought_together / raw.data.related_products
      bought_together:  JSON.stringify(boughtTog),
      related_products: JSON.stringify(relatedProds),
      product_details:  JSON.stringify(pd),
      accordion_content:JSON.stringify(raw.data?.accordionContent   ?? []),
      reviews_info:     JSON.stringify(raw.data?.reviews_information ?? {}),
      category_breadcrumb: JSON.stringify(raw.data?.category        ?? []),
      videos:           JSON.stringify(raw.data?.videos             ?? []),
      shipping_fees:    JSON.stringify(raw.data?.shippingFees       ?? {}),
      flags:            JSON.stringify(flags),
      bestsellers_rank: JSON.stringify(pd.best_sellers_rank         ?? []),
      // ── NEW (migration 004 / pikly) ──────────────────────────────────────
      thumbnails,                                                          // TEXT[] — no stringify
      sponsored_brands:      JSON.stringify(raw.data?.sponsored_brands      ?? []),
      product_description:   JSON.stringify(raw.data?.product_description   ?? []),
      search_metadata:       JSON.stringify(raw.data?.search_metadata       ?? {}),
      search_parameters:     JSON.stringify(raw.data?.search_parameters     ?? {}),
      enrichment_source_data: JSON.stringify(raw.enrichment_source_data     ?? {}),
    }
  } catch {
    return null
  }
}

// ── Batch upsert ──────────────────────────────────────────────────────────────
async function upsertBatch(pool: Pool, rows: Record<string, any>[]): Promise<number> {
  if (!rows.length) return 0

  const cols = [
    'asin','slug','is_active','source',
    'taxonomy_dept','taxonomy_subcat',
    'title','brand','price','original_price','discount_pct',
    'avg_rating','review_count','bought_last_month','thumbnail',
    'is_prime','is_free_ship','in_stock',
    'is_best_seller','is_trending','is_top_rated','is_on_sale',
    'is_amazon_choice','is_new_release','is_deal',
    'cat_lvl0','cat_lvl1','cat_lvl2','cat_lvl3',
    'colors','sizes','attr_values',
    'product_results','purchase_options','protection_plan',
    'item_specs','about_item','bought_together','related_products',
    'product_details','accordion_content','reviews_info',
    'category_breadcrumb','videos','shipping_fees','flags','bestsellers_rank',
    // ── NEW ────────────────────────────────────────────────────────────────
    'thumbnails',
    'sponsored_brands',
    'product_description',
    'search_metadata',
    'search_parameters',
    'enrichment_source_data',
  ]

  const placeholders: string[] = []
  const values: any[] = []
  let i = 1

  for (const row of rows) {
    const ph: string[] = []
    for (const col of cols) {
      const v = row[col]
      if (Array.isArray(v)) {
        // Native PG array (TEXT[], etc.)
        ph.push(`$${i++}`)
        values.push(v)
      } else if (typeof v === 'string' && JSONB_COLS.has(col)) {
        ph.push(`$${i++}::jsonb`)
        values.push(v)
      } else {
        ph.push(`$${i++}`)
        values.push(v ?? null)
      }
    }
    placeholders.push(`(${ph.join(',')})`)
  }

  const updateCols = cols
    .filter(c => c !== 'asin')
    .map(c => `${c} = EXCLUDED.${c}`)
    .join(',\n    ')

  const sql = `
    INSERT INTO store.products (${cols.join(',')})
    VALUES ${placeholders.join(',\n    ')}
    ON CONFLICT (asin) DO UPDATE SET
    ${updateCols},
    updated_at = NOW()
  `

  const result = await pool.query(sql, values)
  return result.rowCount ?? 0
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) { console.error('❌  DATABASE_URL not set'); process.exit(1) }

  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await pool.query('SELECT 1')
  console.log('✅  PostgreSQL connected\n')

  if (CLEAR) {
    await pool.query('TRUNCATE store.products CASCADE')
    console.log('🗑️   store.products truncated\n')
  }

  const file = resolveFile()
  const rl   = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })

  let batch:    Record<string, any>[] = []
  let total     = 0
  let inserted  = 0
  let skipped   = 0
  let batchNo   = 0
  const seenSlugs = new Set<string>()

  const flush = async () => {
    if (!batch.length) return
    batchNo++
    try {
      const n = await upsertBatch(pool, batch)
      inserted += n
    } catch (e: any) {
      console.error(`\n⚠️   Batch ${batchNo} error: ${e.message?.slice(0, 120)}`)
    }
    process.stdout.write(`\r   📦  Processed ${total.toLocaleString()} | ✅ ${inserted.toLocaleString()} | ⚠️  ${skipped.toLocaleString()} skipped`)
    batch = []
  }

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    total++
    if (LIMIT && total > LIMIT) break

    let raw: any
    try { raw = JSON.parse(trimmed) } catch { skipped++; continue }

    const row = transform(raw)
    if (!row) { skipped++; continue }

    if (seenSlugs.has(row.slug as string)) {
      row.slug = `${row.slug}-${Date.now()}`
    }
    seenSlugs.add(row.slug as string)

    batch.push(row)
    if (batch.length >= BATCH) await flush()
  }

  await flush()

  const [{ cnt }] = (await pool.query<{cnt:number}>('SELECT COUNT(*)::int AS cnt FROM store.products WHERE is_active = true')).rows
  console.log(`\n\n✅  Seed complete`)
  console.log(`   Records processed : ${total.toLocaleString()}`)
  console.log(`   Upserted          : ${inserted.toLocaleString()}`)
  console.log(`   Skipped (invalid) : ${skipped.toLocaleString()}`)
  console.log(`   Active in DB now  : ${cnt.toLocaleString()}\n`)

  await pool.end()
}

main().catch(err => { console.error('\n❌  Fatal:', err.message); process.exit(1) })
