/**
 * scripts/seed-categories-pg.ts  —  PostgreSQL category seeder  (v4.0.0)
 *
 * Reads amazon_categories.csv (id,category_name) and upserts into
 * store.categories.  Replaces the old MongoDB-based seed-categories.ts.
 *
 * Usage:
 *   npx ts-node scripts/seed-categories-pg.ts
 *   npx ts-node scripts/seed-categories-pg.ts --csv /path/to/amazon_categories.csv
 *   npx ts-node scripts/seed-categories-pg.ts --clear
 */

import * as dotenv from 'dotenv'
dotenv.config()

import * as fs   from 'fs'
import * as path from 'path'
import { Pool }  from 'pg'

const args   = process.argv.slice(2)
const CLEAR  = args.includes('--clear')
const CSV_I  = args.indexOf('--csv')
const CSV_PATH = CSV_I !== -1
  ? args[CSV_I + 1]
  : (process.env.AMAZON_CATEGORIES_CSV ?? path.join(process.cwd(), 'data', 'amazon_categories.csv'))

// ── Slugify ───────────────────────────────────────────────────────────────────
function slugify(text: string): string {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .replace(/-$/, '')
    .slice(0, 80)
}

// ── Parent category definitions ───────────────────────────────────────────────
const PARENTS = [
  { id:'cat_electronics',  name:'Electronics',              slug:'electronics',           icon:'Laptop',     featured:true,  order:1  },
  { id:'cat_fashion',      name:'Fashion',                  slug:'fashion',               icon:'Shirt',      featured:true,  order:2  },
  { id:'cat_home_kitchen', name:'Home & Kitchen',           slug:'home-kitchen',          icon:'Home',       featured:true,  order:3  },
  { id:'cat_beauty',       name:'Beauty & Personal Care',   slug:'beauty',                icon:'Sparkles',   featured:true,  order:4  },
  { id:'cat_sports',       name:'Sports & Outdoors',        slug:'sports-outdoors',       icon:'Dumbbell',   featured:true,  order:5  },
  { id:'cat_toys',         name:'Toys & Games',             slug:'toys-games',            icon:'Gamepad2',   featured:true,  order:6  },
  { id:'cat_health',       name:'Health & Household',       slug:'health',                icon:'Heart',      featured:true,  order:7  },
  { id:'cat_automotive',   name:'Automotive',               slug:'automotive',            icon:'Car',        featured:false, order:8  },
  { id:'cat_baby',         name:'Baby',                     slug:'baby',                  icon:'Baby',       featured:false, order:9  },
  { id:'cat_video_games',  name:'Video Games',              slug:'video-games',           icon:'Gamepad',    featured:true,  order:10 },
  { id:'cat_luggage',      name:'Luggage & Travel',         slug:'luggage-travel',        icon:'Luggage',    featured:false, order:11 },
  { id:'cat_tools',        name:'Tools & Home Improvement', slug:'tools-home-improvement',icon:'Wrench',     featured:false, order:12 },
  { id:'cat_pet',          name:'Pet Supplies',             slug:'pet-supplies',          icon:'PawPrint',   featured:false, order:13 },
  { id:'cat_smart_home',   name:'Smart Home',               slug:'smart-home',            icon:'Wifi',       featured:false, order:14 },
  { id:'cat_arts_crafts',  name:'Arts & Crafts',            slug:'arts-crafts',           icon:'Palette',    featured:false, order:15 },
  { id:'cat_industrial',   name:'Industrial & Scientific',  slug:'industrial',            icon:'Factory',    featured:false, order:16 },
]

// Maps amazon CSV id → parent slug
const ID_TO_PARENT: Record<string, string> = {
  '1':'arts-crafts','2':'arts-crafts','3':'arts-crafts','54':'electronics','55':'electronics','56':'electronics',
  '57':'electronics','60':'electronics','63':'electronics','64':'electronics','65':'electronics',
  '84':'fashion','87':'fashion','88':'fashion','89':'fashion','90':'fashion','91':'fashion',
  '163':'home-kitchen','164':'home-kitchen','165':'home-kitchen','166':'home-kitchen','167':'home-kitchen',
  '45':'beauty','46':'beauty','47':'beauty','48':'beauty','49':'beauty','50':'beauty',
  '198':'sports-outdoors','199':'sports-outdoors','200':'sports-outdoors',
  '217':'toys-games','218':'toys-games','220':'toys-games','221':'toys-games','222':'toys-games',
  '126':'health','127':'health','128':'health','129':'health','130':'health',
  '14':'automotive','15':'automotive','16':'automotive','17':'automotive','18':'automotive',
  '29':'baby','30':'baby','31':'baby','32':'baby','33':'baby','34':'baby',
  '83':'video-games','241':'video-games','242':'video-games','243':'video-games',
  '99':'luggage-travel','100':'luggage-travel','101':'luggage-travel',
  '203':'tools-home-improvement','204':'tools-home-improvement','205':'tools-home-improvement',
  '178':'pet-supplies','179':'pet-supplies','180':'pet-supplies',
  '185':'smart-home','186':'smart-home','187':'smart-home',
  '138':'industrial','139':'industrial','140':'industrial',
}

const STANDARD_FACETS = JSON.stringify([
  { key:'brand',   label:'Brand',        type:'checkbox' },
  { key:'price',   label:'Price Range',  type:'range'    },
  { key:'rating',  label:'Rating',       type:'rating'   },
  { key:'inStock', label:'Availability', type:'boolean'  },
])

async function main() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) { console.error('❌  DATABASE_URL not set'); process.exit(1) }

  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await pool.query('SELECT 1')
  console.log('✅  PostgreSQL connected\n')

  if (CLEAR) {
    await pool.query('DELETE FROM store.categories')
    console.log('🗑️   store.categories cleared\n')
  }

  // ── Upsert parent categories ────────────────────────────────────────────
  for (const p of PARENTS) {
    await pool.query(
      `INSERT INTO store.categories
         (id, name, slug, parent_id, level, icon, description, is_active, is_featured, sort_order, facets)
       VALUES ($1,$2,$3,NULL,0,$4,$5,true,$6,$7,$8::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, slug=$3, icon=$4, description=$5, is_featured=$6, sort_order=$7, updated_at=NOW()`,
      [p.id, p.name, p.slug, p.icon, `Shop ${p.name}`, p.featured, p.order, STANDARD_FACETS],
    )
  }
  console.log(`✅  ${PARENTS.length} parent categories upserted`)

  // ── Parse CSV ───────────────────────────────────────────────────────────
  if (!fs.existsSync(CSV_PATH)) {
    console.log(`⚠️   CSV not found at ${CSV_PATH} — skipping subcategories`)
    await pool.end(); return
  }

  const lines   = fs.readFileSync(CSV_PATH, 'utf-8').split('\n').filter(Boolean)
  const csvMap: Record<string, string> = {}
  for (let i = 1; i < lines.length; i++) {
    const comma = lines[i].indexOf(',')
    if (comma === -1) continue
    const id   = lines[i].slice(0, comma).trim()
    const name = lines[i].slice(comma + 1).replace(/^"|"$/g, '').trim()
    if (id && name) csvMap[id] = name
  }

  const parentBySlug = Object.fromEntries(PARENTS.map(p => [p.slug, p.id]))
  let subOrder = 1
  let subCount = 0
  const slugSeen = new Set<string>()

  for (const [csvId, categoryName] of Object.entries(csvMap)) {
    const parentSlug = ID_TO_PARENT[csvId]
    if (!parentSlug) continue
    const parentId = parentBySlug[parentSlug]
    if (!parentId) continue

    let subSlug = slugify(categoryName)
    if (slugSeen.has(subSlug)) subSlug = `${subSlug}-${csvId}`
    slugSeen.add(subSlug)

    await pool.query(
      `INSERT INTO store.categories
         (id, name, slug, parent_id, level, description, is_active, is_featured, sort_order, facets)
       VALUES ($1,$2,$3,$4,1,$5,true,false,$6,$7::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, slug=$3, parent_id=$4, description=$5, sort_order=$6, updated_at=NOW()`,
      [`cat_sub_${csvId}`, categoryName, subSlug, parentId, `Shop ${categoryName}`, subOrder++, STANDARD_FACETS],
    )
    subCount++
  }

  console.log(`✅  ${subCount} subcategories upserted`)
  console.log(`\n📌  Total categories in DB: ${PARENTS.length + subCount}`)
  console.log('   Next: npx ts-node scripts/seed-pg.ts\n')

  await pool.end()
}

main().catch(err => { console.error('\n❌  Fatal:', err.message); process.exit(1) })
