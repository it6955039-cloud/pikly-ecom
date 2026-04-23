-- ============================================================
-- 003_homepage_widgets.sql
-- Additive migration: homepage widget slot configuration table
--
-- Purpose:
--   Replaces the hardcoded homepage payload in HomepageService with a
--   database-driven slot configuration system (Amazon "Alexa"-style page
--   composition).  Each row represents one configurable section of the
--   homepage.  The resolution engine in HomepageWidgetsService reads these
--   rows and hydrates them with live product / banner data at request time.
--
-- Zero destructive changes — this migration only creates new objects.
-- Safe to re-run (IF NOT EXISTS / ON CONFLICT DO NOTHING guards throughout).
-- ============================================================

-- ── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS store.homepage_widgets (
  id          TEXT        PRIMARY KEY,

  -- Widget rendering type — drives which resolver is called
  type        TEXT        NOT NULL
                CHECK (type IN (
                  'hero_banner',      -- fetches rows from store.banners
                  'product_carousel', -- uses ProductsService strategy
                  'category_grid',    -- 2×N subcategory image grid
                  'dept_spotlight',   -- single dept with product preview
                  'campaign'          -- themed product group (e.g. "Mother's Day")
                )),

  -- Display copy (optional — front-end may override via its own i18n)
  title       TEXT,
  subtitle    TEXT,
  badge       TEXT,       -- optional badge label e.g. "Limited Time"

  -- Strategy / data config — shape depends on `type` (see comments below)
  --
  -- hero_banner:      { "bannerPosition": "hero" | "secondary" | "sidebar" }
  --
  -- product_carousel: { "strategy": "featured" | "bestsellers" | "trending"
  --                      | "new_arrivals" | "on_sale" | "top_rated" | "by_dept",
  --                     "dept": "Electronics",   -- required when strategy="by_dept"
  --                     "limit": 12 }
  --
  -- category_grid:    { "dept": "Home & Kitchen",   -- optional top-level dept filter
  --                     "subcats": ["Kitchen","Dining"],  -- specific subcategories
  --                     "maxPrice": 50,           -- price cap (for "under $N" widgets)
  --                     "limit": 4,               -- cells to show
  --                     "productsPerCell": 2 }    -- product images per cell
  --
  -- dept_spotlight:   { "dept": "Electronics", "limit": 4 }
  --
  -- campaign:         { "strategy": "featured" | "bestsellers" | "on_sale" | "trending",
  --                     "dept": "Electronics",   -- optional dept filter
  --                     "limit": 8 }
  config      JSONB       NOT NULL DEFAULT '{}',

  -- Display order — lower = higher on page
  position    SMALLINT    NOT NULL DEFAULT 99,

  is_active   BOOLEAN     NOT NULL DEFAULT true,

  -- Visibility targeting:
  --   'all'           → shown to everyone (anonymous and authenticated)
  --   'authenticated' → shown only when a valid JWT is present
  --   'anonymous'     → shown only to unauthenticated visitors
  target      TEXT        NOT NULL DEFAULT 'all'
                CHECK (target IN ('all', 'authenticated', 'anonymous')),

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Query pattern: fetch active, ordered list — cover it with a composite index
CREATE INDEX IF NOT EXISTS idx_hw_active_position
  ON store.homepage_widgets (is_active, position ASC);

-- ── Seed ─────────────────────────────────────────────────────────────────────
-- Default slots that reproduce the current hardcoded homepage payload.
-- Admins can update/reorder/add via the admin API after deployment.

INSERT INTO store.homepage_widgets
  (id, type, title, subtitle, config, position, is_active, target)
VALUES
  -- Row 1: main hero banner
  ('hw_hero',
   'hero_banner',
   'Hero',
   NULL,
   '{"bannerPosition":"hero"}',
   1, true, 'all'),

  -- Row 2: featured (Amazon's Choice + best sellers)
  ('hw_featured',
   'product_carousel',
   'Featured Picks',
   NULL,
   '{"strategy":"featured","limit":12}',
   2, true, 'all'),

  -- Row 3: best sellers
  ('hw_bestsellers',
   'product_carousel',
   'Best Sellers',
   NULL,
   '{"strategy":"bestsellers","limit":12}',
   3, true, 'all'),

  -- Row 4: trending
  ('hw_trending',
   'product_carousel',
   'Trending Now',
   NULL,
   '{"strategy":"trending","limit":12}',
   4, true, 'all'),

  -- Row 5: new arrivals
  ('hw_new_arrivals',
   'product_carousel',
   'New Arrivals',
   NULL,
   '{"strategy":"new_arrivals","limit":12}',
   5, true, 'all'),

  -- Row 6: on-sale deals
  ('hw_on_sale',
   'product_carousel',
   'Today''s Deals',
   NULL,
   '{"strategy":"on_sale","limit":12}',
   6, true, 'all'),

  -- Row 7: top rated
  ('hw_top_rated',
   'product_carousel',
   'Top Rated',
   NULL,
   '{"strategy":"top_rated","limit":12}',
   7, true, 'all'),

  -- Row 8: secondary / sidebar banners
  ('hw_secondary',
   'hero_banner',
   'Secondary Banners',
   NULL,
   '{"bannerPosition":"secondary"}',
   8, true, 'all')

ON CONFLICT (id) DO NOTHING;
