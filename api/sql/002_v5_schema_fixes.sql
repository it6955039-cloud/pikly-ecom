-- =============================================================================
-- PIKLY — Migration 002: v5 Schema Fixes
-- Safe to re-run (all statements are idempotent).
--
-- Fixes applied:
--   1. store.verification_tokens — add UNIQUE (user_id), rename column token→token_hash
--   2. store.webhooks            — add missing columns: user_id, last_triggered_at,
--                                  consecutive_failures, last_failure_at, last_failure_reason
--
-- Run: psql $DATABASE_URL -f api/sql/002_v5_schema_fixes.sql
-- =============================================================================

BEGIN;

-- ── 1. store.verification_tokens ─────────────────────────────────────────────
--
-- The original schema defined `token_hash TEXT NOT NULL UNIQUE` but the
-- application code was inserting into a column named `token`.  The correct
-- behaviour is to store a SHA-256 hash of the raw token (like password_reset_tokens).
-- This migration renames the column so existing rows stay valid, and adds a
-- per-user UNIQUE constraint so only one pending verification exists per user.

-- Rename column if it exists under the old name (no-op if already token_hash)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'store'
      AND table_name   = 'verification_tokens'
      AND column_name  = 'token'
  ) THEN
    ALTER TABLE store.verification_tokens RENAME COLUMN token TO token_hash;
  END IF;
END $$;

-- Add UNIQUE constraint on user_id (one pending verification per user)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'store.verification_tokens'::regclass
      AND contype  = 'u'
      AND array_length(conkey, 1) = 1
      AND conkey[1] = (
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'store.verification_tokens'::regclass
          AND attname  = 'user_id'
      )
  ) THEN
    ALTER TABLE store.verification_tokens ADD CONSTRAINT uq_vt_user_id UNIQUE (user_id);
  END IF;
END $$;

-- Ensure token_hash column is NOT NULL and has its UNIQUE index
DO $$
BEGIN
  -- Make token_hash NOT NULL if it isn't already
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'store'
      AND table_name   = 'verification_tokens'
      AND column_name  = 'token_hash'
      AND is_nullable  = 'YES'
  ) THEN
    ALTER TABLE store.verification_tokens ALTER COLUMN token_hash SET NOT NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vt_token_hash ON store.verification_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_vt_user             ON store.verification_tokens (user_id);

-- ── 2. store.webhooks ────────────────────────────────────────────────────────
--
-- The original schema was missing: user_id, last_triggered_at,
-- consecutive_failures, last_failure_at, last_failure_reason.
-- The secret column was nullable; it should be NOT NULL.

-- Add user_id FK if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'store' AND table_name = 'webhooks' AND column_name = 'user_id'
  ) THEN
    -- Allow NULL temporarily so existing rows don't violate NOT NULL
    ALTER TABLE store.webhooks ADD COLUMN user_id UUID REFERENCES store.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Add last_triggered_at
ALTER TABLE store.webhooks ADD COLUMN IF NOT EXISTS last_triggered_at    TIMESTAMPTZ;
-- Add failure tracking columns
ALTER TABLE store.webhooks ADD COLUMN IF NOT EXISTS consecutive_failures  INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE store.webhooks ADD COLUMN IF NOT EXISTS last_failure_at       TIMESTAMPTZ;
ALTER TABLE store.webhooks ADD COLUMN IF NOT EXISTS last_failure_reason   TEXT;

-- Make secret NOT NULL (set empty string for any legacy NULLs first)
UPDATE store.webhooks SET secret = '' WHERE secret IS NULL;
ALTER TABLE store.webhooks ALTER COLUMN secret SET NOT NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_webhooks_user   ON store.webhooks (user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON store.webhooks (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_webhooks_events ON store.webhooks USING GIN (events);

COMMIT;
