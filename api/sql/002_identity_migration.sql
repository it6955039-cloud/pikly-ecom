-- =============================================================================
-- Migration: 002_identity_migration.sql
-- Purpose:   Clerk IdP migration — Global Identity Mapping + Transactional Outbox
-- Author:    Principal Staff Engineer
-- Strategy:  Additive-only. Zero breaking changes to existing store.users schema.
--            All new columns are nullable or have defaults.
--            Rollback: run 002_identity_migration.rollback.sql
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Global Identity Mapping Table
--    Maps Clerk K-Sortable IDs → internal UUIDs
--
--    Design decisions:
--      • external_id UNIQUE — one Clerk ID per mapping row
--      • internal_id FK to store.users — preserves referential integrity
--      • provider column — forward-compatible if we ever add a second IdP
--      • is_active — soft-delete for user.deleted events (preserves FK chains)
--      • email denormalised here for fast reverse-lookup without joining users
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS store.identity_mapping (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    external_id TEXT        NOT NULL UNIQUE,         -- Clerk ID: user_2abc123...
    internal_id UUID        NOT NULL
                REFERENCES store.users(id)
                ON DELETE RESTRICT,                  -- Never cascade-delete users
    provider    TEXT        NOT NULL DEFAULT 'clerk'
                CHECK (provider IN ('clerk', 'legacy')),
    email       TEXT        NOT NULL,                -- Denormalised for fast lookup
    is_active   BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup by external ID (primary query pattern — every authenticated request)
CREATE INDEX IF NOT EXISTS idx_im_external_id
    ON store.identity_mapping (external_id)
    WHERE is_active = true;

-- Fast reverse lookup: internal UUID → external ID (for Clerk API calls)
CREATE INDEX IF NOT EXISTS idx_im_internal_id
    ON store.identity_mapping (internal_id)
    WHERE is_active = true;

-- Provider + active filter (useful for admin queries)
CREATE INDEX IF NOT EXISTS idx_im_provider_active
    ON store.identity_mapping (provider, is_active);

COMMENT ON TABLE store.identity_mapping IS
    'Global Identity Mapping (GIM): Clerk external IDs → internal UUIDs. '
    'Never contains credentials. Soft-deleted on user.deleted webhook events.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Transactional Outbox Table
--    At-least-once event delivery for identity lifecycle events
--
--    Idempotency key: (aggregate_id, event_type) UNIQUE WHERE processed_at IS NULL
--    → Prevents duplicate pending events for the same aggregate
--    → Processed events are retained for audit purposes (archive after 30 days)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS store.identity_outbox (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type   TEXT        NOT NULL
                 CHECK (event_type IN ('user.provisioned', 'user.updated', 'user.deactivated')),
    aggregate_id UUID        NOT NULL,               -- store.users.id
    external_id  TEXT        NOT NULL,               -- Clerk user ID
    payload      JSONB       NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,                        -- NULL = pending
    next_retry_at TIMESTAMPTZ,                       -- Exponential backoff target
    attempts     INTEGER     NOT NULL DEFAULT 0,
    last_error   TEXT
);

-- Primary polling query: unprocessed + ready-to-retry, FIFO
CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON store.identity_outbox (created_at ASC)
    WHERE processed_at IS NULL AND attempts < 5;

-- Retry scheduling
CREATE INDEX IF NOT EXISTS idx_outbox_retry
    ON store.identity_outbox (next_retry_at)
    WHERE processed_at IS NULL AND next_retry_at IS NOT NULL;

-- Idempotency constraint: only one pending event per (aggregate, type)
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idempotency
    ON store.identity_outbox (aggregate_id, event_type)
    WHERE processed_at IS NULL;

-- Audit retention: query processed events by aggregate
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate_processed
    ON store.identity_outbox (aggregate_id, processed_at DESC)
    WHERE processed_at IS NOT NULL;

COMMENT ON TABLE store.identity_outbox IS
    'Transactional Outbox for identity lifecycle events. '
    'Events are written in the same transaction as domain state changes. '
    'OutboxProcessorService polls this table and delivers events to consumers.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Augment store.users for Clerk coexistence
--    All additions are nullable / have defaults — zero impact on legacy rows
-- ─────────────────────────────────────────────────────────────────────────────

-- Track which IdP manages this user's authentication
ALTER TABLE store.users
    ADD COLUMN IF NOT EXISTS auth_provider TEXT
        NOT NULL DEFAULT 'legacy'
        CHECK (auth_provider IN ('clerk', 'legacy'));

-- Clerk-managed users have no password — make password_hash optional
-- The '$CLERK_MANAGED$' sentinel in existing code is replaced by NULL
ALTER TABLE store.users
    ALTER COLUMN password_hash DROP NOT NULL;

-- Optional: store Clerk user ID directly on users for single-table queries
-- (The identity_mapping table is the canonical source — this is a convenience
-- denormalisation for admin dashboards that don't want an extra join)
ALTER TABLE store.users
    ADD COLUMN IF NOT EXISTS clerk_id TEXT UNIQUE;

-- Index for direct Clerk ID lookups (admin dashboards, Clerk webhook handlers)
CREATE INDEX IF NOT EXISTS idx_users_clerk_id
    ON store.users (clerk_id)
    WHERE clerk_id IS NOT NULL;

COMMENT ON COLUMN store.users.auth_provider IS
    'legacy = managed by bcrypt/JWT engine (showcase only). '
    'clerk = managed by Clerk IdP (production).';

COMMENT ON COLUMN store.users.clerk_id IS
    'Denormalised Clerk user ID. Canonical mapping is in store.identity_mapping.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Migrate existing users to legacy auth_provider
--    All pre-existing users keep password_hash = existing value, auth_provider = 'legacy'
--    New Clerk users get auth_provider = 'clerk', password_hash = NULL
-- ─────────────────────────────────────────────────────────────────────────────

-- Mark all rows that have a real password hash as 'legacy'
UPDATE store.users
SET auth_provider = 'legacy'
WHERE password_hash IS NOT NULL
  AND password_hash != '$CLERK_MANAGED$';

-- Clean up the '$CLERK_MANAGED$' sentinel placeholder from interim migration
UPDATE store.users
SET password_hash = NULL,
    auth_provider = 'clerk'
WHERE password_hash = '$CLERK_MANAGED$';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Automated outbox cleanup (archive processed records after 30 days)
--    Run via pg_cron or application-level scheduler
-- ─────────────────────────────────────────────────────────────────────────────

-- Partition hint for future archival:
-- CREATE TABLE store.identity_outbox_archive (LIKE store.identity_outbox);
-- SELECT * FROM store.identity_outbox
--   WHERE processed_at < NOW() - INTERVAL '30 days';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback script (002_identity_migration.rollback.sql)
-- Run only after verifying zero Clerk users exist in the system
-- ─────────────────────────────────────────────────────────────────────────────
/*
BEGIN;
DROP TABLE IF EXISTS store.identity_outbox;
DROP TABLE IF EXISTS store.identity_mapping;
ALTER TABLE store.users DROP COLUMN IF EXISTS auth_provider;
ALTER TABLE store.users DROP COLUMN IF EXISTS clerk_id;
ALTER TABLE store.users ALTER COLUMN password_hash SET NOT NULL;
COMMIT;
*/
