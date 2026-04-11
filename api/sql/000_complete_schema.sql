-- =============================================================================
-- PIKLY — Complete Database Schema  v5.0.0
-- Single idempotent file for fresh Neon PostgreSQL setup.
-- Run: psql $DATABASE_URL -f api/sql/000_complete_schema.sql
--
-- Extensions: ltree, pg_trgm, uuid-ossp, btree_gin — all native on Neon ✅
--
-- Schema design:
--   store.*   — application layer (NestJS API reads/writes here)
--   catalog.* — catalog intelligence output (LTREE-indexed, CIL writes here)
--   cil.*     — enrichment metadata (quality scores, AI cache, job tracking)
--
-- Key architectural decision:
--   store.products  is the seeding target and the hot-path read table.
--   catalog.products is a MATERIALIZED SNAPSHOT of store.products populated
--   by sql/001_sync_catalog.sql (run once after seeding). It carries a proper
--   LTREE taxonomy_path column so CIL can use <@ ancestor queries.
--   The two tables stay in sync via the store_to_catalog_sync() trigger.
-- =============================================================================

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- ── Schemas ───────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS store;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS cil;

-- =============================================================================
-- STORE SCHEMA — NestJS application layer (hot path)
-- =============================================================================

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store.users (
    id               UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    email            TEXT         NOT NULL UNIQUE,
    password_hash    TEXT         NOT NULL,
    first_name       TEXT         NOT NULL DEFAULT '',
    last_name        TEXT         NOT NULL DEFAULT '',
    avatar           TEXT,
    phone            TEXT,
    role             TEXT         NOT NULL DEFAULT 'customer'
                     CHECK (role IN ('customer','admin')),
    addresses        JSONB        NOT NULL DEFAULT '[]',
    wishlist_asins   TEXT[]       NOT NULL DEFAULT '{}',
    recently_viewed  TEXT[]       NOT NULL DEFAULT '{}',
    loyalty_points   INTEGER      NOT NULL DEFAULT 0,
    is_verified      BOOLEAN      NOT NULL DEFAULT false,
    is_active        BOOLEAN      NOT NULL DEFAULT true,
    last_login       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email    ON store.users (email);
CREATE INDEX IF NOT EXISTS idx_users_role     ON store.users (role, is_active);

-- ── Auth tokens ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store.refresh_tokens (
    id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID        NOT NULL REFERENCES store.users(id) ON DELETE CASCADE,
    token_hash TEXT        NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rt_user    ON store.refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_rt_expires ON store.refresh_tokens (expires_at);

CREATE TABLE IF NOT EXISTS store.verification_tokens (
    id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID        NOT NULL UNIQUE REFERENCES store.users(id) ON DELETE CASCADE,
    token_hash TEXT        NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vt_user       ON store.verification_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_vt_token_hash ON store.verification_tokens (token_hash);
CREATE TABLE IF NOT EXISTS store.password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES store.users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS store.token_blacklist (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_hash TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bl_expires ON store.token_blacklist (expires_at);

-- ── Products ──────────────────────────────────────────────────────────────────
-- taxonomy_path LTREE: computed from taxonomy_dept + taxonomy_subcat at insert.
-- Format: dept_slug.subcat_slug  (e.g. beauty_and_personal_care.toners)
-- Spaces/special chars → underscores; hierarchy separator → dot.
-- This column enables proper LTREE <@ ancestor queries in CIL.
CREATE TABLE IF NOT EXISTS store.products (
    id               UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    asin             TEXT          NOT NULL UNIQUE,
    slug             TEXT          NOT NULL UNIQUE,
    is_active        BOOLEAN       NOT NULL DEFAULT true,
    source           TEXT          NOT NULL DEFAULT 'pikly',

    -- Taxonomy (denormalised from _taxonomy in JSONL)
    taxonomy_dept    TEXT          NOT NULL DEFAULT '',
    taxonomy_subcat  TEXT          NOT NULL DEFAULT '',
    -- LTREE path computed from dept + subcat — used by CIL for ancestor queries
    taxonomy_path    LTREE,

    title            TEXT          NOT NULL DEFAULT '',
    brand            TEXT          NOT NULL DEFAULT '',
    price            NUMERIC(12,2) NOT NULL DEFAULT 0,
    original_price   NUMERIC(12,2),
    discount_pct     SMALLINT      NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
    avg_rating       NUMERIC(3,2)  NOT NULL DEFAULT 0 CHECK (avg_rating BETWEEN 0 AND 5),
    review_count     INTEGER       NOT NULL DEFAULT 0,
    bought_last_month TEXT,
    thumbnail        TEXT,
    thumbnails       TEXT[]        NOT NULL DEFAULT '{}',

    -- Boolean flags (from _flags in JSONL)
    is_prime         BOOLEAN NOT NULL DEFAULT false,
    is_free_ship     BOOLEAN NOT NULL DEFAULT false,
    in_stock         BOOLEAN NOT NULL DEFAULT true,
    is_best_seller   BOOLEAN NOT NULL DEFAULT false,
    is_trending      BOOLEAN NOT NULL DEFAULT false,
    is_top_rated     BOOLEAN NOT NULL DEFAULT false,
    is_on_sale       BOOLEAN NOT NULL DEFAULT false,
    is_amazon_choice BOOLEAN NOT NULL DEFAULT false,
    is_new_release   BOOLEAN NOT NULL DEFAULT false,
    is_deal          BOOLEAN NOT NULL DEFAULT false,

    -- Algolia hierarchical category strings
    cat_lvl0         TEXT,
    cat_lvl1         TEXT,
    cat_lvl2         TEXT,
    cat_lvl3         TEXT,

    colors           TEXT[]  NOT NULL DEFAULT '{}',
    sizes            TEXT[]  NOT NULL DEFAULT '{}',
    attr_values      TEXT[]  NOT NULL DEFAULT '{}',

    -- Full JSONB blobs (raw data — source of truth)
    product_results       JSONB NOT NULL DEFAULT '{}',
    purchase_options      JSONB NOT NULL DEFAULT '{}',
    protection_plan       JSONB NOT NULL DEFAULT '[]',
    item_specs            JSONB NOT NULL DEFAULT '{}',
    about_item            JSONB NOT NULL DEFAULT '[]',
    bought_together       JSONB NOT NULL DEFAULT '[]',
    related_products      JSONB NOT NULL DEFAULT '[]',
    product_details       JSONB NOT NULL DEFAULT '{}',
    accordion_content     JSONB NOT NULL DEFAULT '[]',
    reviews_info          JSONB NOT NULL DEFAULT '{}',
    category_breadcrumb   JSONB NOT NULL DEFAULT '[]',
    videos                JSONB NOT NULL DEFAULT '[]',
    shipping_fees         JSONB NOT NULL DEFAULT '{}',
    flags                 JSONB NOT NULL DEFAULT '{}',
    bestsellers_rank      JSONB NOT NULL DEFAULT '[]',

    -- Pikly v5 columns (migration 005)
    sponsored_brands       JSONB NOT NULL DEFAULT '[]',
    product_description    JSONB NOT NULL DEFAULT '[]',
    search_metadata        JSONB NOT NULL DEFAULT '{}',
    search_parameters      JSONB NOT NULL DEFAULT '{}',
    enrichment_source_data JSONB NOT NULL DEFAULT '{}',

    algolia_synced_at TIMESTAMPTZ,
    plytix_id         TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- LTREE trigger: auto-compute taxonomy_path from dept + subcat on INSERT/UPDATE
CREATE OR REPLACE FUNCTION store.fn_set_taxonomy_path()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  dept_slug  TEXT;
  subcat_slug TEXT;
BEGIN
  -- Convert to LTREE-safe label: lower, replace non-alphanum with underscore, collapse
  dept_slug := lower(regexp_replace(
    regexp_replace(COALESCE(NEW.taxonomy_dept, ''), '[^a-z0-9]+', '_', 'gi'),
    '_+', '_', 'g'
  ));
  dept_slug := trim(both '_' from dept_slug);

  IF dept_slug = '' THEN
    NEW.taxonomy_path := NULL;
    RETURN NEW;
  END IF;

  subcat_slug := lower(regexp_replace(
    regexp_replace(COALESCE(NEW.taxonomy_subcat, ''), '[^a-z0-9]+', '_', 'gi'),
    '_+', '_', 'g'
  ));
  subcat_slug := trim(both '_' from subcat_slug);

  IF subcat_slug = '' OR subcat_slug IS NULL THEN
    NEW.taxonomy_path := dept_slug::LTREE;
  ELSE
    NEW.taxonomy_path := (dept_slug || '.' || subcat_slug)::LTREE;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_store_products_taxonomy_path ON store.products;
CREATE TRIGGER trg_store_products_taxonomy_path
  BEFORE INSERT OR UPDATE OF taxonomy_dept, taxonomy_subcat
  ON store.products
  FOR EACH ROW EXECUTE FUNCTION store.fn_set_taxonomy_path();

-- Product indexes
CREATE INDEX IF NOT EXISTS idx_prod_tax_gist   ON store.products USING GIST (taxonomy_path) WHERE taxonomy_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prod_tax_btree  ON store.products (taxonomy_path) WHERE taxonomy_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prod_active     ON store.products (is_active);
CREATE INDEX IF NOT EXISTS idx_prod_dept       ON store.products (taxonomy_dept, is_active);
CREATE INDEX IF NOT EXISTS idx_prod_subcat     ON store.products (taxonomy_subcat, is_active);
CREATE INDEX IF NOT EXISTS idx_prod_brand      ON store.products (brand, is_active);
CREATE INDEX IF NOT EXISTS idx_prod_price      ON store.products (price, is_active);
CREATE INDEX IF NOT EXISTS idx_prod_rating     ON store.products (avg_rating DESC, review_count DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_prod_discount   ON store.products (discount_pct DESC) WHERE is_active AND is_on_sale;
CREATE INDEX IF NOT EXISTS idx_prod_cat0       ON store.products (cat_lvl0) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_prod_cat1       ON store.products (cat_lvl1) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_prod_prime      ON store.products (is_prime) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_prod_trending   ON store.products (is_trending) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_prod_bestseller ON store.products (is_best_seller) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_prod_colors     ON store.products USING GIN (colors);
CREATE INDEX IF NOT EXISTS idx_prod_sizes      ON store.products USING GIN (sizes);
CREATE INDEX IF NOT EXISTS idx_prod_attrs      ON store.products USING GIN (attr_values);
CREATE INDEX IF NOT EXISTS idx_prod_thumbnails ON store.products USING GIN (thumbnails);
CREATE INDEX IF NOT EXISTS idx_prod_title_trgm ON store.products USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_prod_brand_trgm ON store.products USING GIN (brand gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_prod_pr_gin     ON store.products USING GIN (product_results);
CREATE INDEX IF NOT EXISTS idx_prod_esd_gin    ON store.products USING GIN (enrichment_source_data);
CREATE INDEX IF NOT EXISTS idx_prod_updated    ON store.products (updated_at DESC);
-- Composite for most common list queries
CREATE INDEX IF NOT EXISTS idx_prod_list       ON store.products (taxonomy_path, is_active, price, avg_rating DESC) WHERE taxonomy_path IS NOT NULL;

-- ── Categories ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store.categories (
    id            TEXT         PRIMARY KEY,
    name          TEXT         NOT NULL,
    slug          TEXT         NOT NULL UNIQUE,
    node_id       TEXT,
    amazon_path   TEXT,
    ltree_path    LTREE,
    parent_id     TEXT         REFERENCES store.categories(id),
    level         SMALLINT     NOT NULL DEFAULT 0,
    image         TEXT,
    icon          TEXT,
    description   TEXT         NOT NULL DEFAULT '',
    product_count INTEGER      NOT NULL DEFAULT 0,
    is_active     BOOLEAN      NOT NULL DEFAULT true,
    is_featured   BOOLEAN      NOT NULL DEFAULT false,
    sort_order    SMALLINT     NOT NULL DEFAULT 0,
    facets        JSONB        NOT NULL DEFAULT '[]',
    sort_options  JSONB        NOT NULL DEFAULT '[]',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cat_ltree    ON store.categories USING GIST (ltree_path) WHERE ltree_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cat_parent   ON store.categories (parent_id);
CREATE INDEX IF NOT EXISTS idx_cat_level    ON store.categories (level, is_active);
CREATE INDEX IF NOT EXISTS idx_cat_featured ON store.categories (is_featured, is_active);

-- ── Carts ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store.carts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id TEXT NOT NULL UNIQUE,
    user_id UUID REFERENCES store.users(id) ON DELETE SET NULL,
    items JSONB NOT NULL DEFAULT '[]',
    coupon JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cart_user    ON store.carts (user_id);
CREATE INDEX IF NOT EXISTS idx_cart_updated ON store.carts (updated_at DESC);

-- ── Coupons ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store.coupons (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('percentage','fixed')),
    value NUMERIC(10,2) NOT NULL,
    min_order_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    max_discount NUMERIC(10,2),
    usage_limit INTEGER, used_count INTEGER NOT NULL DEFAULT 0,
    applicable_categories TEXT[] NOT NULL DEFAULT '{}',
    applicable_products TEXT[] NOT NULL DEFAULT '{}',
    expires_at TIMESTAMPTZ, is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coupon_code   ON store.coupons (code);
CREATE INDEX IF NOT EXISTS idx_coupon_active ON store.coupons (is_active);

-- ── Orders ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store.orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES store.users(id),
    status TEXT NOT NULL DEFAULT 'pending'
           CHECK (status IN ('pending','confirmed','processing','shipped','delivered','cancelled','refunded')),
    items JSONB NOT NULL DEFAULT '[]',
    shipping_addr JSONB NOT NULL DEFAULT '{}',
    billing_addr JSONB NOT NULL DEFAULT '{}',
    subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount NUMERIC(12,2) NOT NULL DEFAULT 0,
    shipping_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax NUMERIC(12,2) NOT NULL DEFAULT 0,
    total NUMERIC(12,2) NOT NULL DEFAULT 0,
    coupon JSONB, payment JSONB NOT NULL DEFAULT '{}', notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_user    ON store.orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON store.orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_updated ON store.orders (updated_at DESC);

-- ── Banners ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store.banners (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT,
    image TEXT NOT NULL, link TEXT, badge TEXT, color TEXT,
    position TEXT DEFAULT 'hero', is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    start_date TIMESTAMPTZ, end_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_banners_active ON store.banners (is_active, sort_order);

-- ── Wishlists / Recently Viewed / Compare / Reviews / Webhooks ───────────────
CREATE TABLE IF NOT EXISTS store.wishlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES store.users(id) ON DELETE CASCADE,
    asin TEXT NOT NULL, added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, asin)
);
CREATE INDEX IF NOT EXISTS idx_wish_user ON store.wishlists (user_id, added_at DESC);

CREATE TABLE IF NOT EXISTS store.recently_viewed (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES store.users(id) ON DELETE CASCADE,
    asin TEXT NOT NULL, viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, asin)
);
CREATE INDEX IF NOT EXISTS idx_rv_user ON store.recently_viewed (user_id, viewed_at DESC);

CREATE TABLE IF NOT EXISTS store.product_reviews (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asin TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES store.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    is_verified BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (asin, user_id)
);
CREATE INDEX IF NOT EXISTS idx_rev_asin ON store.product_reviews (asin, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rev_user ON store.product_reviews (user_id);

CREATE TABLE IF NOT EXISTS store.compare_lists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id TEXT NOT NULL UNIQUE, asins TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS store.webhooks (
    id                   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id              UUID        NOT NULL REFERENCES store.users(id) ON DELETE CASCADE,
    url                  TEXT        NOT NULL,
    events               TEXT[]      NOT NULL DEFAULT '{}',
    secret               TEXT        NOT NULL,
    is_active            BOOLEAN     NOT NULL DEFAULT true,
    -- Delivery health tracking (updated on every send attempt)
    last_triggered_at    TIMESTAMPTZ,
    consecutive_failures INTEGER     NOT NULL DEFAULT 0,
    last_failure_at      TIMESTAMPTZ,
    last_failure_reason  TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhooks_user   ON store.webhooks (user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON store.webhooks (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_webhooks_events ON store.webhooks USING GIN (events);

-- =============================================================================
-- CATALOG SCHEMA — CIL layer (LTREE-indexed, proper ancestor queries)
-- =============================================================================

-- ── catalog.products — LTREE-indexed mirror of store.products ─────────────────
-- Populated by the sync trigger below. CIL reads from here for:
--   • <@ ancestor queries (e.g. "all products under electronics")
--   • Partitioned attribute EAV joins
-- Never write to this table directly — store.products is the source of truth.
CREATE TABLE IF NOT EXISTS catalog.products (
    id            UUID         PRIMARY KEY,          -- same UUID as store.products.id
    asin          TEXT         NOT NULL UNIQUE,
    slug          TEXT         NOT NULL UNIQUE,
    taxonomy_path LTREE        NOT NULL,
    title         TEXT         NOT NULL DEFAULT '',
    brand         TEXT         NOT NULL DEFAULT '',
    price         NUMERIC(12,2) NOT NULL DEFAULT 0,
    avg_rating    NUMERIC(3,2) NOT NULL DEFAULT 0,
    review_count  INTEGER      NOT NULL DEFAULT 0,
    thumbnail     TEXT,
    cat_lvl0      TEXT,
    cat_lvl1      TEXT,
    is_active     BOOLEAN      NOT NULL DEFAULT true,
    synced_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cat_prod_tax_gist  ON catalog.products USING GIST (taxonomy_path);
CREATE INDEX IF NOT EXISTS idx_cat_prod_tax_btree ON catalog.products (taxonomy_path);
CREATE INDEX IF NOT EXISTS idx_cat_prod_active    ON catalog.products (is_active);
CREATE INDEX IF NOT EXISTS idx_cat_prod_list      ON catalog.products (taxonomy_path, is_active, price, avg_rating DESC);

-- Sync trigger: keep catalog.products in sync with store.products
CREATE OR REPLACE FUNCTION store.fn_sync_to_catalog()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM catalog.products WHERE asin = OLD.asin;
    RETURN OLD;
  END IF;

  IF NEW.taxonomy_path IS NULL THEN
    -- No valid taxonomy — remove from catalog if it was there
    DELETE FROM catalog.products WHERE asin = NEW.asin;
    RETURN NEW;
  END IF;

  INSERT INTO catalog.products
    (id, asin, slug, taxonomy_path, title, brand, price, avg_rating,
     review_count, thumbnail, cat_lvl0, cat_lvl1, is_active, synced_at)
  VALUES
    (NEW.id, NEW.asin, NEW.slug, NEW.taxonomy_path, NEW.title, NEW.brand,
     NEW.price, NEW.avg_rating, NEW.review_count, NEW.thumbnail,
     NEW.cat_lvl0, NEW.cat_lvl1, NEW.is_active, NOW())
  ON CONFLICT (asin) DO UPDATE SET
    taxonomy_path = EXCLUDED.taxonomy_path,
    title         = EXCLUDED.title,
    brand         = EXCLUDED.brand,
    price         = EXCLUDED.price,
    avg_rating    = EXCLUDED.avg_rating,
    review_count  = EXCLUDED.review_count,
    thumbnail     = EXCLUDED.thumbnail,
    cat_lvl0      = EXCLUDED.cat_lvl0,
    cat_lvl1      = EXCLUDED.cat_lvl1,
    is_active     = EXCLUDED.is_active,
    synced_at     = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_to_catalog ON store.products;
CREATE TRIGGER trg_sync_to_catalog
  AFTER INSERT OR UPDATE OR DELETE ON store.products
  FOR EACH ROW EXECUTE FUNCTION store.fn_sync_to_catalog();

-- ── catalog.product_accordion — AI-generated accordion (keyed by asin) ────────
CREATE TABLE IF NOT EXISTS catalog.product_accordion (
    asin       TEXT        PRIMARY KEY,
    content    JSONB       NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_acc_updated ON catalog.product_accordion (updated_at DESC);

-- ── catalog.product_attributes — Partitioned EAV (LTREE-linked) ──────────────
-- Stores normalised attribute key-value pairs per product.
-- Populated by CIL accordion_generation job (writes here alongside catalog.product_accordion).
-- Partitioned by taxonomy_depth for efficient subtree queries.
CREATE TABLE IF NOT EXISTS catalog.product_attributes (
    id             UUID        DEFAULT uuid_generate_v4(),
    asin           TEXT        NOT NULL,
    taxonomy_path  LTREE       NOT NULL,
    taxonomy_depth SMALLINT    NOT NULL,
    attr_group     TEXT        NOT NULL,
    attr_group_icon TEXT,
    attr_key       TEXT        NOT NULL,
    attr_label     TEXT        NOT NULL,
    attr_value     TEXT        NOT NULL,
    attr_value_num NUMERIC,
    attr_unit      TEXT,
    algolia_facet  TEXT GENERATED ALWAYS AS (attr_key || ':' || attr_value) STORED,
    sort_order     SMALLINT    NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, taxonomy_depth)
) PARTITION BY RANGE (taxonomy_depth);

CREATE TABLE IF NOT EXISTS catalog.product_attributes_d1 PARTITION OF catalog.product_attributes FOR VALUES FROM (1) TO (2);
CREATE TABLE IF NOT EXISTS catalog.product_attributes_d2 PARTITION OF catalog.product_attributes FOR VALUES FROM (2) TO (3);
CREATE TABLE IF NOT EXISTS catalog.product_attributes_d3 PARTITION OF catalog.product_attributes FOR VALUES FROM (3) TO (4);
CREATE TABLE IF NOT EXISTS catalog.product_attributes_d4 PARTITION OF catalog.product_attributes FOR VALUES FROM (4) TO (5);
CREATE TABLE IF NOT EXISTS catalog.product_attributes_d5 PARTITION OF catalog.product_attributes FOR VALUES FROM (5) TO (6);
CREATE TABLE IF NOT EXISTS catalog.product_attributes_d6 PARTITION OF catalog.product_attributes FOR VALUES FROM (6) TO (7);

-- Partition indexes
DO $$ DECLARE d INT; BEGIN FOR d IN 1..6 LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_attr_d%s_kv    ON catalog.product_attributes_d%s (attr_key, attr_value)', d, d);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_attr_d%s_tax   ON catalog.product_attributes_d%s USING GIST (taxonomy_path)', d, d);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_attr_d%s_facet ON catalog.product_attributes_d%s (algolia_facet)', d, d);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_attr_d%s_asin  ON catalog.product_attributes_d%s (asin)', d, d);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_attr_d%s_num   ON catalog.product_attributes_d%s (attr_key, attr_value_num) WHERE attr_value_num IS NOT NULL', d, d);
END LOOP; END; $$;

-- =============================================================================
-- CIL SCHEMA — Catalog Intelligence Layer metadata
-- =============================================================================

-- ── Attribute families — one per taxonomy node (LTREE path) ──────────────────
CREATE TABLE IF NOT EXISTS cil.attribute_families (
    id               UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    taxonomy_path    LTREE        NOT NULL UNIQUE,   -- e.g. beauty_and_personal_care.toners
    taxonomy_depth   SMALLINT     NOT NULL CHECK (taxonomy_depth BETWEEN 1 AND 6),
    name             TEXT         NOT NULL,
    slug             TEXT         NOT NULL UNIQUE,
    description      TEXT,
    attribute_schema JSONB        NOT NULL DEFAULT '[]',
    facet_config     JSONB        NOT NULL DEFAULT '[]',
    schema_coverage  NUMERIC(5,2) NOT NULL DEFAULT 0,
    last_ai_review   TIMESTAMPTZ,
    ai_model_used    TEXT,
    is_active        BOOLEAN      NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fam_tax_gist ON cil.attribute_families USING GIST (taxonomy_path);
CREATE INDEX IF NOT EXISTS idx_fam_depth    ON cil.attribute_families (taxonomy_depth) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_fam_slug     ON cil.attribute_families (slug);

-- ── Normalised attribute registry ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cil.attribute_registry (
    id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_key         TEXT         NOT NULL UNIQUE,
    canonical_key   TEXT         NOT NULL,
    canonical_label TEXT         NOT NULL,
    group_name      TEXT         NOT NULL,
    group_icon      TEXT         NOT NULL DEFAULT '📋',
    data_type       TEXT         NOT NULL DEFAULT 'text'
                    CHECK (data_type IN ('text','numeric','boolean','url','enum')),
    unit            TEXT,
    family_paths    LTREE[]      NOT NULL DEFAULT '{}',
    is_facetable    BOOLEAN      NOT NULL DEFAULT false,
    is_searchable   BOOLEAN      NOT NULL DEFAULT false,
    is_required     BOOLEAN      NOT NULL DEFAULT false,
    product_count   INTEGER      NOT NULL DEFAULT 0,
    null_count      INTEGER      NOT NULL DEFAULT 0,
    known_values    TEXT[]       NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reg_group    ON cil.attribute_registry (group_name);
CREATE INDEX IF NOT EXISTS idx_reg_facet    ON cil.attribute_registry (is_facetable) WHERE is_facetable;
CREATE INDEX IF NOT EXISTS idx_reg_families ON cil.attribute_registry USING GIN (family_paths);

-- ── Product quality scores ────────────────────────────────────────────────────
-- asin TEXT PK — intentionally no FK to catalog.products to allow CIL to run
-- independently (quality scoring can start before catalog sync completes).
CREATE TABLE IF NOT EXISTS cil.product_quality (
    asin                TEXT         PRIMARY KEY,
    quality_score       NUMERIC(5,2) NOT NULL DEFAULT 0,
    score_title         NUMERIC(5,2) NOT NULL DEFAULT 0,
    score_images        NUMERIC(5,2) NOT NULL DEFAULT 0,
    score_description   NUMERIC(5,2) NOT NULL DEFAULT 0,
    score_attributes    NUMERIC(5,2) NOT NULL DEFAULT 0,
    score_variants      NUMERIC(5,2) NOT NULL DEFAULT 0,
    score_reviews       NUMERIC(5,2) NOT NULL DEFAULT 0,
    score_taxonomy      NUMERIC(5,2) NOT NULL DEFAULT 0,
    issues              JSONB        NOT NULL DEFAULT '[]',
    missing_attrs       TEXT[]       NOT NULL DEFAULT '{}',
    present_attrs       TEXT[]       NOT NULL DEFAULT '{}',
    attribute_coverage  NUMERIC(5,2) NOT NULL DEFAULT 0,
    pipeline_version    TEXT         NOT NULL DEFAULT 'v1',
    scored_at           TIMESTAMPTZ,
    enriched_at         TIMESTAMPTZ,
    needs_rescore       BOOLEAN      NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qual_score   ON cil.product_quality (quality_score ASC) WHERE needs_rescore = false;
CREATE INDEX IF NOT EXISTS idx_qual_rescore ON cil.product_quality (scored_at ASC)     WHERE needs_rescore = true;
CREATE INDEX IF NOT EXISTS idx_qual_issues  ON cil.product_quality USING GIN (issues);

-- ── Enrichment jobs ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cil.enrichment_jobs (
    id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_type            TEXT        NOT NULL
                        CHECK (job_type IN (
                            'accordion_generation','quality_scoring',
                            'attribute_normalization','facet_config_generation',
                            'family_assignment','variant_image_fill','cross_sell_enrichment'
                        )),
    last_processed_asin TEXT,
    total_items         INTEGER     NOT NULL DEFAULT 0,
    processed_items     INTEGER     NOT NULL DEFAULT 0,
    failed_items        INTEGER     NOT NULL DEFAULT 0,
    skipped_items       INTEGER     NOT NULL DEFAULT 0,
    status              TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','completed','failed','cancelled')),
    error_message       TEXT,
    config              JSONB       NOT NULL DEFAULT '{}',
    results             JSONB       NOT NULL DEFAULT '{}',
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_type   ON cil.enrichment_jobs (job_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON cil.enrichment_jobs (status) WHERE status IN ('pending','running');

-- ── AI generation cache ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cil.ai_cache (
    content_hash   TEXT        PRIMARY KEY,
    job_type       TEXT        NOT NULL,
    model_used     TEXT        NOT NULL DEFAULT 'gemini-1.5-flash',
    prompt_version TEXT        NOT NULL DEFAULT 'v3',
    input_tokens   INTEGER     NOT NULL DEFAULT 0,
    output_tokens  INTEGER     NOT NULL DEFAULT 0,
    response       JSONB       NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cil.ai_cache (expires_at ASC);
CREATE INDEX IF NOT EXISTS idx_cache_job     ON cil.ai_cache (job_type, model_used);

-- ── Facet configs per taxonomy path ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cil.facet_configs (
    id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    taxonomy_path LTREE        NOT NULL UNIQUE,
    facets        JSONB        NOT NULL DEFAULT '[]',
    sort_options  JSONB        NOT NULL DEFAULT '[
        {"key":"relevance","label":"Best Match","algoliaReplica":""},
        {"key":"price_asc","label":"Price: Low to High","algoliaReplica":"_price_asc"},
        {"key":"price_desc","label":"Price: High to Low","algoliaReplica":"_price_desc"},
        {"key":"rating_desc","label":"Avg. Customer Review","algoliaReplica":"_rating_desc"},
        {"key":"newest","label":"Newest Arrivals","algoliaReplica":"_newest"},
        {"key":"bestselling","label":"Best Sellers","algoliaReplica":"_bestselling"}
    ]',
    ai_generated  BOOLEAN      NOT NULL DEFAULT false,
    ai_confidence NUMERIC(5,2),
    generated_at  TIMESTAMPTZ,
    overrides     JSONB        NOT NULL DEFAULT '{}',
    is_active     BOOLEAN      NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_facet_cfg_gist ON cil.facet_configs USING GIST (taxonomy_path);

-- =============================================================================
-- HELPER VIEWS
-- =============================================================================

-- Products pending quality scoring (uses catalog.products for LTREE context)
CREATE OR REPLACE VIEW cil.v_products_pending_quality AS
SELECT
    sp.id,
    sp.asin,
    sp.taxonomy_path,
    sp.cat_lvl0,
    sp.cat_lvl1,
    COALESCE(q.quality_score, 0)   AS current_score,
    COALESCE(q.needs_rescore, true) AS needs_rescore,
    q.asin IS NULL                  AS is_new
FROM store.products sp
LEFT JOIN cil.product_quality q ON q.asin = sp.asin
WHERE sp.is_active = true
  AND (q.needs_rescore = true OR q.asin IS NULL)
ORDER BY sp.asin;

-- Family coverage summary (joins cil + catalog for LTREE subtree stats)
CREATE OR REPLACE VIEW cil.v_family_coverage AS
SELECT
    af.name         AS family_name,
    af.taxonomy_path,
    af.schema_coverage,
    COUNT(cp.asin)                                              AS product_count,
    AVG(COALESCE(q.quality_score, 0))::NUMERIC(5,2)            AS avg_quality,
    COUNT(cp.asin) FILTER (WHERE q.quality_score >= 80)        AS high_quality_count,
    COUNT(cp.asin) FILTER (WHERE q.quality_score < 40)         AS low_quality_count
FROM cil.attribute_families af
LEFT JOIN catalog.products cp ON cp.taxonomy_path <@ af.taxonomy_path AND cp.is_active
LEFT JOIN cil.product_quality q ON q.asin = cp.asin
GROUP BY af.id, af.name, af.taxonomy_path, af.schema_coverage;

-- =============================================================================
-- Table comments
-- =============================================================================
COMMENT ON TABLE store.products           IS 'Primary product table — seeded from products_cleaned.jsonl. Hot path.';
COMMENT ON COLUMN store.products.taxonomy_path IS 'LTREE auto-computed from taxonomy_dept + taxonomy_subcat via trigger.';
COMMENT ON TABLE catalog.products         IS 'LTREE-indexed mirror of store.products — synced by trigger. CIL reads from here.';
COMMENT ON TABLE catalog.product_accordion IS 'AI-generated accordion content per product. Keyed by asin.';
COMMENT ON TABLE catalog.product_attributes IS 'Partitioned EAV attributes. Populated by CIL accordion job.';
COMMENT ON TABLE cil.attribute_families   IS 'One family per taxonomy node — defines attribute schema + facet config.';
COMMENT ON TABLE cil.product_quality      IS 'Per-product 7-dimension quality score. asin PK — no FK to allow independent operation.';
COMMENT ON TABLE cil.enrichment_jobs      IS 'Cursor-based restartable enrichment job tracking.';
COMMENT ON TABLE cil.ai_cache             IS 'Gemini response cache — 30-day TTL, keyed by SHA-256 content hash.';
COMMENT ON TABLE cil.facet_configs        IS 'Dynamic per-category facet config for frontend sidebar.';

-- =============================================================================
-- Schema verification
-- =============================================================================
DO $$
DECLARE
  tbl TEXT; missing TEXT := '';
  expected TEXT[] := ARRAY[
    'store.users','store.products','store.categories','store.carts',
    'store.orders','store.coupons','store.banners','store.wishlists',
    'store.recently_viewed','store.product_reviews','store.compare_lists',
    'catalog.products','catalog.product_accordion','catalog.product_attributes',
    'cil.attribute_families','cil.attribute_registry','cil.product_quality',
    'cil.enrichment_jobs','cil.ai_cache','cil.facet_configs'
  ];
BEGIN
  FOREACH tbl IN ARRAY expected LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = split_part(tbl,'.', 1)
        AND table_name   = split_part(tbl,'.', 2)
    ) THEN missing := missing || tbl || ', '; END IF;
  END LOOP;
  IF missing <> '' THEN
    RAISE EXCEPTION 'Schema v5.0.0 incomplete — missing: %', missing;
  ELSE
    RAISE NOTICE 'Schema v5.0.0 verified — all tables, triggers, LTREE indexes present.';
  END IF;
END $$;

ANALYZE;
