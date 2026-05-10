-- =============================================================================
-- Migration: 003_payment_hardening.sql
-- Run AFTER 002_payment_tables.sql
-- Adds 'processing' state and stripe_payment_intent to checkout sessions.
-- =============================================================================

-- Add 'processing' to the enum check — needed for two-phase claim (BUG-1 fix)
ALTER TABLE store.payment_events
  DROP CONSTRAINT IF EXISTS payment_events_processing_status_check;

ALTER TABLE store.payment_events
  ADD CONSTRAINT payment_events_processing_status_check
  CHECK (processing_status IN ('received','processing','processed','failed','skipped'));

-- Add stripe_payment_intent to checkout sessions for PI-based lookups (BUG-3 fix)
ALTER TABLE store.payment_checkout_sessions
  ADD COLUMN IF NOT EXISTS stripe_payment_intent TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_sessions_pi
  ON store.payment_checkout_sessions (stripe_payment_intent)
  WHERE stripe_payment_intent IS NOT NULL;

-- Index for stuck-order reconciliation query (corr. service)
CREATE INDEX IF NOT EXISTS idx_orders_payment_status
  ON store.orders (payment_status, updated_at)
  WHERE payment_status IS NOT NULL;
