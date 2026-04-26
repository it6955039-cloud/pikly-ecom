-- =============================================================================
-- sql/004_campaigns.sql
--
-- Seasonal campaign system for the Storefront v2 editorial_campaign section.
--
-- When to run:
--   This migration is OPTIONAL for launch. Without it, fetchActiveCampaign()
--   in HomepageStorefrontV2Service catches the error and returns null — the
--   editorial_campaign section simply does not appear.
--
--   Run this when you want to manage Mother's Day / Prime Day / Black Friday
--   style campaign banners via the database.
--
-- How to run:
--   psql $DATABASE_URL -f api/sql/004_campaigns.sql
--   -- or via your existing migration tooling
--
-- No other SQL is needed for Storefront v2.
-- All other tables used (banners, orders, recently_viewed, products,
-- categories) already exist in 000_complete_schema.sql.
-- =============================================================================

-- ── Schema guard — idempotent ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store.campaigns (
    id               TEXT        PRIMARY KEY,
    name             TEXT        NOT NULL,                -- "Mother's Day", "Prime Day"
    headline         TEXT        NOT NULL,                -- "Explore Mother's Day deals"
    tagline          TEXT,                                -- "Shop deals up to 50% off"
    subheadline      TEXT,
    background_image TEXT,                                -- CDN URL
    is_active        BOOLEAN     NOT NULL DEFAULT false,
    priority         SMALLINT    NOT NULL DEFAULT 0,      -- higher = shown first when multiple active
    starts_at        TIMESTAMPTZ NOT NULL,
    ends_at          TIMESTAMPTZ NOT NULL,

    -- Campaign tile links (4 tiles shown in the editorial section)
    -- Stored as JSONB array: [{ id, label, image, link, badge }, ...]
    tiles            JSONB       NOT NULL DEFAULT '[]',

    -- CSS / color theme for frontend theming
    -- { primaryColor, accentColor, heroBackground, badgeLabel }
    theme            JSONB,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the active campaign lookup in HomepageStorefrontV2Service:
--   WHERE is_active=true AND starts_at<=$now AND ends_at>=$now ORDER BY priority DESC
CREATE INDEX IF NOT EXISTS idx_campaigns_active_window
    ON store.campaigns (is_active, priority DESC, starts_at, ends_at);

-- ── Example campaign row — delete before production ───────────────────────────
INSERT INTO store.campaigns (id, name, headline, tagline, is_active, priority, starts_at, ends_at, tiles, theme)
VALUES (
    'mothers-day-2026',
    'Mother''s Day',
    'Explore Mother''s Day deals',
    'Shop deals up to 50% off',
    false,  -- set true when you want it live
    10,
    '2026-05-01 00:00:00+00',
    '2026-05-12 23:59:59+00',
    '[
        { "id": "t1", "label": "Apparel",  "image": null, "link": "/category/apparel",  "badge": null },
        { "id": "t2", "label": "Shoes",    "image": null, "link": "/category/shoes",    "badge": null },
        { "id": "t3", "label": "Jewelry",  "image": null, "link": "/category/jewelry",  "badge": null },
        { "id": "t4", "label": "Handbags", "image": null, "link": "/category/handbags", "badge": null }
    ]',
    '{
        "primaryColor":   "#e91e8c",
        "accentColor":    "#ff9900",
        "heroBackground": "linear-gradient(135deg, #f8d7e8, #fff0f5)",
        "badgeLabel":     "Mother''s Day Deal"
    }'
)
ON CONFLICT (id) DO NOTHING;
