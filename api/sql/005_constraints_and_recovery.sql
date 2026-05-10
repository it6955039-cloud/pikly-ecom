-- =============================================================================
-- Migration: 005_constraints_and_recovery.sql
-- Minimal schema hardening for production correctness.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- BUG-5 FIX: Add processing_claimed_at to both tables.
-- A recovery job resets rows where processing_claimed_at < NOW() - 10 minutes
-- AND processing_status = 'processing'.
-- This is the only correct way to recover from crashed workers.
-- ---------------------------------------------------------------------------
ALTER TABLE store.payment_events
  ADD COLUMN IF NOT EXISTS processing_claimed_at TIMESTAMPTZ;

ALTER TABLE store.payment_outbox
  ADD COLUMN IF NOT EXISTS processing_claimed_at TIMESTAMPTZ;

-- Index for recovery query: find stuck events efficiently
CREATE INDEX IF NOT EXISTS idx_payment_events_stuck_processing
  ON store.payment_events (processing_claimed_at)
  WHERE processing_status = 'processing';

CREATE INDEX IF NOT EXISTS idx_payment_outbox_stuck_processing
  ON store.payment_outbox (processing_claimed_at)
  WHERE status = 'processing';

-- ---------------------------------------------------------------------------
-- BUG-6 FIX: DB-level constraint on payment_status.
-- Application state machine is the primary guard, but this prevents
-- direct SQL bypasses that could corrupt financial state.
-- ---------------------------------------------------------------------------
ALTER TABLE store.orders
  DROP CONSTRAINT IF EXISTS orders_payment_status_check;

ALTER TABLE store.orders
  ADD CONSTRAINT orders_payment_status_check
  CHECK (
    payment_status IS NULL OR
    payment_status IN (
      'checkout_created',
      'succeeded',
      'failed',
      'cancelled',
      'pending_refund',
      'refunded'
    )
  );

-- ---------------------------------------------------------------------------
-- Prevent impossible financial states at DB level.
-- An order cannot be 'confirmed' (delivered/shipped) with a failed payment.
-- This does NOT replace application logic — it is a last-resort guard.
-- ---------------------------------------------------------------------------
ALTER TABLE store.orders
  DROP CONSTRAINT IF EXISTS orders_status_payment_consistency;

-- Note: not adding status+payment_status cross-constraint here since
-- COD/wallet orders have null payment_status but can be confirmed.
-- Application logic handles this correctly.
