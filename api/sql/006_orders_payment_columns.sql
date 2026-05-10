-- =============================================================================
-- Migration: 006_orders_payment_columns.sql
-- Adds payment_status and timeline columns that were missing from base schema.
-- Run AFTER 005_constraints_and_recovery.sql
-- Safe to re-run (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS guards).
-- =============================================================================

-- Add payment_status — the column the entire payments module depends on
ALTER TABLE store.orders
  ADD COLUMN IF NOT EXISTS payment_status TEXT;

-- Add timeline — append-only JSON audit trail of order status changes
ALTER TABLE store.orders
  ADD COLUMN IF NOT EXISTS timeline JSONB NOT NULL DEFAULT '[]';

-- DB-level guard on payment_status values (re-apply in case 005 ran before column existed)
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

-- Index for reconciliation queries (re-apply in case 003 ran before column existed)
DROP INDEX IF EXISTS store.idx_orders_payment_status;

CREATE INDEX idx_orders_payment_status
  ON store.orders (payment_status, updated_at)
  WHERE payment_status IS NOT NULL;
