/**
 * scripts/seed-pg.ts  —  PostgreSQL product seeder  (v5.0.1 — pikly dataset)
 *
 * Fixes vs v5.0.0:
 *  • discount_pct clamped to 0-100 (was causing check constraint violation)
 *  • Batch deduplication by ASIN (was causing ON CONFLICT row-seen-twice error)
 */

import * as dotenv from 'dotenv'
dotenv.config()

import * as fs       from 'fs'
import * as readline from 'readline'
import * as path     from 'path'
import * as crypto   from 'crypto'
import { Pool }      from 'pg'

const args    = process.argv.slice(2)
const CLEAR   = args.includes('--clear')
const LIMIT_I = args.indexOf('--limit')
const LIMIT   = LIMIT_I !== -1 ? Number(args[LIMIT_I + 1]) : 0
const FILE_I  = args.indexOf('--file')
const BATCH   = 200

const JSONB_COLS = new Set([
  'product_results', 'purchase_options', 'protection_plan',
  'item_specs', 'about_item', 'bought_together', 'related_products',
  'product_details', 'accordion_content', 'reviews_info',
  'category_breadcrumb', 'videos', 'shipping_fees', 'flags', 'bestsellers_rank',
  'sponsored_brands', 'product_description',
  'search_metadata', 'search_parameters', 'enrichment_source_data',
])

function resolveFile(): string {
  if (FILE_I !== -1) {
    const f = args[FILE_I + 1]
    if (!f || !fs.existsSync(f)) { console.error(`No file: ${f}`); process.exit(1) }
    return f
  }
  const candidates = [
    path.join(process.cwd(), 'data', 'products_discovery_enhanced.jsonl'),
    path.join(process.cwd(), '..', 'api', 'data', 'products_discovery_enhanced.jsonl'),
    path.join(process.cwd(), 'data', 'products_cleaned.jsonl'),
    path.join(process.cwd(), '..', 'api', 'data', 'products_cleaned.jsonl'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) { console.log(`Using: ${c}`); return c }
  }
  console.error('No JSONL file found.'); process.exit(1)
}

function slugify(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim().slice(0, 80).replace(/-$/, '')
}

function transform(raw: any): Record<string, any> | null {
  try {
    const pr    = raw.data?.product_results    ?? {}
    const pd    = raw.data?.product_details    ?? {}
    const tax   = raw._taxonomy               ?? {}
    const flags = raw._flags                  ?? {}

    const asin = (raw.asin ?? '').trim().toUpperCase()
    if (!asin) return null

    const title = (pr.title ?? '').slice(0, 500)
    const brand = (pr.brand ?? '').replace(/^Visit the\s+|\s+Store\s*$/gi, '').trim()
    const price = Math.max(0, Number(pr.extracted_price) || 0)
    const oldPx = pr.extracted_old_price ? Math.max(0, Number(pr.extracted_old_price)) : null

    // FIX 1: clamp discount_pct to 0-100
    let disc = 0
    if (price > 0 && oldPx && oldPx > price) {
      disc = Math.round((1 - price / oldPx) * 100)
    }
    disc = Math.max(0, Math.min(100, disc))

    const dept   = (tax.department  ?? '').slice(0, 200)
    const subcat = (tax.subcategory ?? '').slice(0, 200)
    const catLvl0 = slugify(dept)
    const catLvl1 = subcat ? `${catLvl0} > ${slugify(subcat)}` : catLvl0

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

    const attrValues: string[] = []
    const specs = { ...(raw.data?.item_specifications ?? {}), ...pd }
    const skipKeys = new Set(['asin','rating','reviews','customer_reviews','best_sellers_rank'])
    for (const [k, v] of Object.entries(specs)) {
      if (!skipKeys.has(k) && v && String(v).length < 100) attrValues.push(`${k}:${String(v)}`)
    }

    const base = slugify(`${title.slice(0, 60)}-${asin}`)
    const hash = crypto.createHash('md5').update(asin).digest('hex').slice(0, 6)

    const engineRp = (raw.related_products && typeof raw.related_products === 'object'
      && !Array.isArray(raw.related_products)) ? raw.related_products as Record<string, any> : {}
    const boughtTog    = engineRp.bought_together ?? []
    const relatedProds = engineRp.similar          ?? []
    const thumbnails: string[] = pr.highResolutionImages ?? pr.thumbnails ?? []

    return {
      asin,
      slug: `${base}-${hash}`,
      is_active: true,
      source:    raw.source ?? 'pikly',
      taxonomy_dept:   dept,
      taxonomy_subcat: subcat,
      title, brand, price,
      original_price:   oldPx,
      discount_pct:     disc,
      avg_rating:       Math.max(0, Math.min(5, Number(pr.rating)  || 0)),
      review_count:     Math.max(0, Math.round(Number(pr.reviews)  || 0)),
      bought_last_month: pr.bought_last_month ?? null,
      thumbnail:        pr.thumbnail ?? null,
      is_prime:         flags.isPrime         ?? pr.prime ?? false,
      is_free_ship:     flags.isFreeShipping  ?? false,
      in_stock:         flags.inStock         ?? (pr.stock ?? '').toLowerCase().includes('in stock'),
      is_best_seller:   flags.isBestSeller    ?? false,
      is_trending:      flags.isTrending      ?? false,
      is_top_rated:     flags.isTopRated      ?? false,
      is_on_sale:       flags.isOnSale        ?? disc > 0,
      is_amazon_choice: flags.isAmazonsChoice ?? false,
      is_new_release:   flags.isNewRelease    ?? false,
      is_deal:          flags.isDeal          ?? false,
      cat_lvl0: catLvl0, cat_lvl1: catLvl1, cat_lvl2: null, cat_lvl3: null,
      colors, sizes, attr_values: attrValues,
      product_results:  JSON.stringify(pr),
      purchase_options: JSON.stringify(raw.data?.purchase_options   ?? {}),
      protection_plan:  JSON.stringify(raw.data?.protection_plan    ?? []),
      item_specs:       JSON.stringify(raw.data?.item_specifications ?? {}),
      about_item:       JSON.stringify(raw.data?.about_item         ?? []),
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
      thumbnails,
      sponsored_brands:       JSON.stringify(raw.data?.sponsored_brands      ?? []),
      product_description:    JSON.stringify(raw.data?.product_description   ?? []),
      search_metadata:        JSON.stringify(raw.data?.search_metadata       ?? {}),
      search_parameters:      JSON.stringify(raw.data?.search_parameters     ?? {}),
      enrichment_source_data: JSON.stringify(raw.enrichment_source_data      ?? {}),
    }
  } catch { return null }
}

async function upsertBatch(pool: Pool, rows: Record<string, any>[]): Promise<number> {
  if (!rows.length) return 0

  const cols = [
    'asin','slug','is_active','source','taxonomy_dept','taxonomy_subcat',
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
    'thumbnails','sponsored_brands','product_description',
    'search_metadata','search_parameters','enrichment_source_data',
  ]

  // FIX 2: deduplicate by ASIN within batch — prevents "ON CONFLICT row seen twice" error
  const seenAsins = new Set<string>()
  const deduped = rows.filter(r => {
    if (seenAsins.has(r.asin as string)) return false
    seenAsins.add(r.asin as string)
    return true
  })

  const placeholders: string[] = []
  const values: any[] = []
  let i = 1

  for (const row of deduped) {
    const ph: string[] = []
    for (const col of cols) {
      const v = row[col]
      if (Array.isArray(v)) {
        ph.push(`$${i++}`); values.push(v)
      } else if (typeof v === 'string' && JSONB_COLS.has(col)) {
        ph.push(`$${i++}::jsonb`); values.push(v)
      } else {
        ph.push(`$${i++}`); values.push(v ?? null)
      }
    }
    placeholders.push(`(${ph.join(',')})`)
  }

  const updateCols = cols.filter(c => c !== 'asin')
    .map(c => `${c} = EXCLUDED.${c}`).join(',\n    ')

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

async function main() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) { console.error('DATABASE_URL not set'); process.exit(1) }

  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await pool.query('SELECT 1')
  console.log('PostgreSQL connected\n')

  if (CLEAR) {
    await pool.query('TRUNCATE store.products CASCADE')
    console.log('Table cleared\n')
  }

  const file = resolveFile()
  const rl   = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })

  let batch:   Record<string, any>[] = []
  let total = 0, inserted = 0, skipped = 0, batchNo = 0, errors = 0
  const seenSlugs = new Set<string>()

  const flush = async () => {
    if (!batch.length) return
    batchNo++
    try {
      const n = await upsertBatch(pool, batch)
      inserted += n
    } catch (e: any) {
      errors++
      console.error(`\nBatch ${batchNo} error: ${e.message?.slice(0, 200)}`)
    }
    process.stdout.write(
      `\r   Processed ${total.toLocaleString()} | Upserted ${inserted.toLocaleString()} | Errors ${errors}`
    )
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

    if (seenSlugs.has(row.slug as string)) row.slug = `${row.slug}-${total}`
    seenSlugs.add(row.slug as string)

    batch.push(row)
    if (batch.length >= BATCH) await flush()
  }
  await flush()

  const [{ cnt }] = (await pool.query<{cnt: number}>(
    'SELECT COUNT(*)::int AS cnt FROM store.products WHERE is_active = true'
  )).rows

  console.log(`\n\nSeed complete`)
  console.log(`  Records processed : ${total.toLocaleString()}`)
  console.log(`  Upserted          : ${inserted.toLocaleString()}`)
  console.log(`  Skipped (invalid) : ${skipped.toLocaleString()}`)
  console.log(`  Batch errors      : ${errors}`)
  console.log(`  Active in DB now  : ${cnt.toLocaleString()}\n`)

  await pool.end()
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1) })
