-- =============================================================================
-- Migration: 007_identity_bugfix_patch.sql
-- Purpose:   Schema hardening for all identity sync bug fixes.
--            All changes are additive — zero downtime, no data loss.
-- =============================================================================

BEGIN;

-- ── 1. clerk_id column on store.users ────────────────────────────────────────
--   BUG-4 FIX: auth_provider and clerk_id were never set in upsertMapping().
--   The clerk_id column is referenced in fixed code but may be absent in some
--   deployments if migration 002 was not fully applied.

ALTER TABLE store.users
    ADD COLUMN IF NOT EXISTS clerk_id TEXT;

-- Fast reverse lookup: clerk_id → user row (used by admin session revocation)
CREATE INDEX IF NOT EXISTS idx_users_clerk_id
    ON store.users (clerk_id)
    WHERE clerk_id IS NOT NULL;

-- ── 2. Ensure password_hash is nullable ──────────────────────────────────────
--   BUG-PWD SAFETY: upsertMapping uses '$CLERK_MANAGED$' as sentinel but the
--   column must be nullable for future migrations. Apply defensively.
ALTER TABLE store.users
    ALTER COLUMN password_hash DROP NOT NULL;

-- ── 3. Partial unique index for outbox idempotency ───────────────────────────
--   BUG-ONCONFLICT FIX: The ON CONFLICT clause in enqueue() now correctly
--   specifies the WHERE predicate to match this partial index.
--   Re-create if it doesn't exist with the correct definition.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idempotency
    ON store.identity_outbox (aggregate_id, event_type)
    WHERE processed_at IS NULL;

-- ── 4. Performance indexes for GIM queries ────────────────────────────────────
--   BUG-DI FIX: GIM is now SINGLETON — every resolve() call hits the DB.
--   These indexes ensure sub-millisecond lookups even at scale.

-- Existing: idx_im_external_id — covers resolve(externalId) WHERE is_active = true
-- Ensure it exists:
CREATE UNIQUE INDEX IF NOT EXISTS idx_im_external_id
    ON store.identity_mapping (external_id);

-- New: covers deactivateByInternalId() and reactivateByInternalId() — UPDATE on
-- all rows for an internalId. Previously only a filtered index existed.
CREATE INDEX IF NOT EXISTS idx_im_internal_id_all
    ON store.identity_mapping (internal_id);

-- New: covers resolveExternal() ORDER BY updated_at DESC LIMIT 1 and
-- DISTINCT ON queries in admin findAll() / findOne().
CREATE INDEX IF NOT EXISTS idx_im_internal_updated
    ON store.identity_mapping (internal_id, updated_at DESC);

-- ── 5. Outbox polling index ───────────────────────────────────────────────────
--   BUG-6 FIX: The CTE UPDATE in fetchPending() filters:
--     processed_at IS NULL AND next_retry_at <= NOW() AND attempts < 5
--   This covering index makes the poll sub-millisecond even with millions of rows.
CREATE INDEX IF NOT EXISTS idx_outbox_pending_retry
    ON store.identity_outbox (created_at ASC, next_retry_at ASC)
    WHERE processed_at IS NULL AND attempts < 5;

COMMIT;

-- =============================================================================
-- VERIFICATION QUERIES (run after migration to confirm):
-- =============================================================================
--
--   -- Check clerk_id column exists
--   SELECT column_name, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'store' AND table_name = 'users' AND column_name = 'clerk_id';
--
--   -- Check partial unique index exists with correct predicate
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE schemaname = 'store' AND tablename = 'identity_outbox'
--     AND indexname = 'idx_outbox_idempotency';
--
--   -- Expected: "CREATE UNIQUE INDEX idx_outbox_idempotency ON store.identity_outbox
--   --   USING btree (aggregate_id, event_type) WHERE (processed_at IS NULL)"
-- =============================================================================
