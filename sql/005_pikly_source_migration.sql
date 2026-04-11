-- =============================================================================
-- sql/005_pikly_source_migration.sql
-- Pikly Dataset Migration — adds all columns introduced in 004 + source update
-- Target: Fresh Neon PostgreSQL account
-- Run AFTER 001_schema_neon.sql, 002_cil_schema.sql, 003_app_schema.sql
-- Safe to run multiple times (all statements use IF NOT EXISTS / DO blocks)
-- =============================================================================

-- ── 1. thumbnails — TEXT[]  (pikly provides highResolutionImages array) ───────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='store' AND table_name='products' AND column_name='thumbnails'
  ) THEN
    ALTER TABLE store.products ADD COLUMN thumbnails TEXT[] DEFAULT '{}';
  END IF;
END $$;

-- ── 2. sponsored_brands — JSONB ───────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='store' AND table_name='products' AND column_name='sponsored_brands'
  ) THEN
    ALTER TABLE store.products ADD COLUMN sponsored_brands JSONB DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- ── 3. product_description — JSONB (A+ content carousel images) ──────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='store' AND table_name='products' AND column_name='product_description'
  ) THEN
    ALTER TABLE store.products ADD COLUMN product_description JSONB DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- ── 4. search_metadata — JSONB ────────────────────────────────────────────────
--      pikly: { amazon_product_url, status }
--      oxylabs (legacy): { id, status, amazon_product_url, raw_html_file, total_time_taken }
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='store' AND table_name='products' AND column_name='search_metadata'
  ) THEN
    ALTER TABLE store.products ADD COLUMN search_metadata JSONB DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- ── 5. search_parameters — JSONB ──────────────────────────────────────────────
--      pikly: { asin, pikly_product }
--      oxylabs (legacy): { engine, asin, amazon_domain, device, other_sellers }
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='store' AND table_name='products' AND column_name='search_parameters'
  ) THEN
    ALTER TABLE store.products ADD COLUMN search_parameters JSONB DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- ── 6. enrichment_source_data — JSONB ─────────────────────────────────────────
--      pikly top-level field: asinVariationValues, highResolutionImages,
--      manufacturerProductImages, reviews (with media), productInformation, etc.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='store' AND table_name='products' AND column_name='enrichment_source_data'
  ) THEN
    ALTER TABLE store.products ADD COLUMN enrichment_source_data JSONB DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- ── Indexes ────────────────────────────────────────────────────────────────────
-- GIN index on thumbnails for array contains queries (optional but useful)
CREATE INDEX IF NOT EXISTS idx_products_thumbnails_gin
  ON store.products USING GIN (thumbnails);

-- GIN index on enrichment_source_data for JSONB path queries
CREATE INDEX IF NOT EXISTS idx_products_enrichment_source_data_gin
  ON store.products USING GIN (enrichment_source_data);

-- ── Verify all columns present ────────────────────────────────────────────────
DO $$
DECLARE
  missing TEXT := '';
  col     TEXT;
  expected TEXT[] := ARRAY[
    'thumbnails','sponsored_brands','product_description',
    'search_metadata','search_parameters','enrichment_source_data'
  ];
BEGIN
  FOREACH col IN ARRAY expected LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='store' AND table_name='products' AND column_name=col
    ) THEN
      missing := missing || col || ', ';
    END IF;
  END LOOP;
  IF missing <> '' THEN
    RAISE EXCEPTION 'Migration 005 incomplete — missing columns: %', missing;
  END IF;
  RAISE NOTICE 'Migration 005 OK — all pikly columns present.';
END $$;
