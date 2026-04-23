# Pikly Dataset Migration — Runbook v5.0.0
## oxylabs → pikly | Discovery Engine | Fresh Neon Account

---

## Overview of Changes

| Layer | File | What Changed |
|---|---|---|
| Pipeline | `validate.py` | `source` default `'pikly'`; `enrichment_source_data` field added; `_dummy_fields` optional |
| Pipeline | `transform.py` | 6 new DB columns; bt/rp sourced from Discovery Engine (not scraper) |
| Pipeline | `ingest.py` | COLUMNS + JSONB_COLS expanded; file resolution prefers `products_discovery_enhanced.jsonl` |
| Pipeline | `hybrid_discovery_engine.py` | Cross-platform paths; strips scraper bt/rp before writing output |
| API | `seed-pg.ts` | 6 new cols; JSONB_COLS as explicit Set; engine bt/rp; `parseHelpfulVotes` |
| API | `products.service.ts` | `helpful_votes` sort fixed; `enrichment_source_data` in findOne; `thumbnails` in loadProducts |
| SQL | `005_pikly_source_migration.sql` | 6 new columns + GIN indexes; self-verifying |

---

## Step 1 — Replace Pipeline Files

```bash
cp migration/pipeline/validate.py              pikly-ecom-main/pipeline/validate.py
cp migration/pipeline/transform.py             pikly-ecom-main/pipeline/transform.py
cp migration/pipeline/ingest.py                pikly-ecom-main/pipeline/ingest.py
cp migration/pipeline/hybrid_discovery_engine.py  pikly-ecom-main/pipeline/hybrid_discovery_engine.py
```

## Step 2 — Replace API Files

```bash
cp migration/api/scripts/seed-pg.ts            pikly-ecom-main/api/scripts/seed-pg.ts
cp migration/api/src/products/products.service.ts  pikly-ecom-main/api/src/products/products.service.ts
```

---

## Step 3 — Create Fresh Neon Account & Database

1. Go to https://neon.tech → New Project
2. Name it `pikly-prod` (or your choice)
3. Copy the **connection string** — save as `DATABASE_URL`
4. Copy the **direct connection string** — save as `DIRECT_NEON_URL`

---

## Step 4 — Run SQL Schemas (in order)

```bash
# From the project root
export DIRECT_NEON_URL="postgresql://..."

psql $DIRECT_NEON_URL < pikly-ecom-main/sql/001_schema_neon.sql
psql $DIRECT_NEON_URL < pikly-ecom-main/sql/002_cil_schema.sql
psql $DIRECT_NEON_URL < pikly-ecom-main/sql/003_app_schema.sql
psql $DIRECT_NEON_URL < migration/sql/005_pikly_source_migration.sql
```

You should see:
```
NOTICE:  Migration 005 OK — all pikly columns present.
```

---

## Step 5 — Run the Discovery Engine

```bash
cd pikly-ecom-main/pipeline

# Set input path (your pikly products_cleaned.jsonl)
export JSONL_FILE=../api/data/products_cleaned.jsonl

python hybrid_discovery_engine.py
# Output: ../api/data/products_discovery_enhanced.jsonl
```

This step:
- Strips scraper's `bought_together` / `related_products` from each record
- Computes Semantic + BM25 RRF recommendations
- Injects engine output as top-level `related_products: { similar, bought_together }`

---

## Step 6 — Seed the Database

### Option A: Python pipeline (preferred for production)

```bash
cd pikly-ecom-main/pipeline

export DATABASE_URL="postgresql://..."
export JSONL_FILE=../api/data/products_discovery_enhanced.jsonl

# Dry run first
python ingest.py --dry-run

# Full ingest
python ingest.py --clear
```

### Option B: TypeScript seeder

```bash
cd pikly-ecom-main/api

export DATABASE_URL="postgresql://..."

npx ts-node scripts/seed-pg.ts --clear
```

---

## Step 7 — Seed Categories

```bash
cd pikly-ecom-main/api
npx ts-node scripts/seed-categories-pg.ts
```

---

## Step 8 — Sync Algolia

```bash
cd pikly-ecom-main/api

export ALGOLIA_APP_ID="..."
export ALGOLIA_WRITE_KEY="..."

npx ts-node scripts/sync-algolia-pg.ts
```

No changes needed to `sync-algolia-pg.ts` — it reads flat DB columns, not raw JSONL.

---

## Step 9 — Update Environment Variables

Update your deployment environment (Railway / Render / Fly) with the new Neon credentials:

```
DATABASE_URL=postgresql://...           # Neon pooled (port 6543)
DIRECT_NEON_URL=postgresql://...        # Neon direct (port 5432, for migrations)
```

---

## What Is NOT Changed (Zero Touch)

| File | Reason |
|---|---|
| `sync-algolia-pg.ts` | Reads flat DB columns only |
| `algolia.service.ts` | Schema-level config, data-independent |
| `facet-config.ts` | Static config |
| `categories.service.ts` | Fully independent |
| All controllers | Delegate to service layer |
| `enrichment-pipeline.service.ts` | Orchestrates from DB |
| `data-quality.service.ts` | Reads JSONB blobs transparently |
| `attribute-intelligence.service.ts` | Same |
| SQL schemas 001, 002, 003 | Untouched |

---

## Verification Checklist

```sql
-- 1. All 6 new columns present
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='store' AND table_name='products'
  AND column_name IN (
    'thumbnails','sponsored_brands','product_description',
    'search_metadata','search_parameters','enrichment_source_data'
  );
-- Expect: 6 rows

-- 2. Source is pikly
SELECT DISTINCT source FROM store.products;
-- Expect: pikly

-- 3. thumbnails populated
SELECT asin, array_length(thumbnails,1) AS thumb_count
FROM store.products LIMIT 5;
-- Expect: non-null counts

-- 4. enrichment_source_data populated
SELECT asin, jsonb_object_keys(enrichment_source_data) AS key
FROM store.products LIMIT 10;
-- Expect: body, etc.

-- 5. bought_together / related_products from engine (not empty)
SELECT asin,
  jsonb_array_length(bought_together) AS bt_count,
  jsonb_array_length(related_products) AS rp_count
FROM store.products
WHERE jsonb_array_length(bought_together) > 0
LIMIT 5;
```

---

## Rollback Plan

If anything fails after Step 6:
1. Neon console → Restore to point-in-time (before `--clear` ingest)
2. Revert the 6 pipeline/API files to their v4 versions
3. Re-run ingest with original `products_cleaned.jsonl`

The new Neon account means the old account is untouched — zero risk.

---

## Step 8 — Homepage Widget Slots (003_homepage_widgets.sql)

This step is **additive only** — no existing tables are modified.

### Run the migration

```bash
psql $DATABASE_URL -f api/sql/003_homepage_widgets.sql
```

### What it creates

| Object | Type | Notes |
|---|---|---|
| `store.homepage_widgets` | Table | Widget slot config rows |
| `idx_hw_active_position` | Index | Covers `WHERE is_active=true ORDER BY position` |
| 8 seed rows | Data | Reproduces current hardcoded homepage sections |

### Verify

```sql
-- 1. Table exists and has seed rows
SELECT id, type, title, position, is_active, target
FROM store.homepage_widgets
ORDER BY position;
-- Expect: 8 rows (hw_hero → hw_secondary)

-- 2. Index was created
SELECT indexname FROM pg_indexes
WHERE tablename = 'homepage_widgets';
-- Expect: idx_hw_active_position

-- 3. New endpoints respond
-- GET /api/homepage/widgets          → 200, data array with 8 items
-- GET /api/homepage/personalized     → 401 (requires JWT — correct)
-- GET /api/admin/homepage-widgets    → 401 (requires admin JWT — correct)
```

### Rollback (if needed)

```sql
DROP TABLE IF EXISTS store.homepage_widgets;
```

The existing `GET /api/homepage` endpoint is completely unaffected — it does not
read from this table. The widget system is fully parallel.

---

## New Files Added (v5.1.0)

| File | Type | Purpose |
|---|---|---|
| `api/sql/003_homepage_widgets.sql` | SQL | Migration — widget slots table + seed |
| `api/src/homepage/dto/homepage-widget.dto.ts` | TS | CreateWidgetDto, UpdateWidgetDto, ReorderWidgetsDto |
| `api/src/homepage/homepage-widgets.service.ts` | TS | Widget resolution engine |
| `api/src/homepage/homepage-personalization.service.ts` | TS | P13N engine (collaborative filtering) |
| `api/src/admin/admin-homepage-widgets.controller.ts` | TS | Admin CRUD + reorder |
| `api/src/homepage/tests/homepage-widgets.service.spec.ts` | TS | 30 unit tests |
| `api/src/homepage/tests/homepage-personalization.service.spec.ts` | TS | 23 unit tests |

**Modified files (additive only — zero breaking changes):**

| File | What changed |
|---|---|
| `api/src/homepage/homepage.controller.ts` | +2 GET routes (`/widgets`, `/personalized`) |
| `api/src/homepage/homepage.module.ts` | +2 providers registered |
| `api/src/admin/admin.module.ts` | +1 controller registered |
| `api/src/recently-viewed/recently-viewed.service.ts` | +Redis publish on track() for P13N cache invalidation |
