-- =============================================================================
-- Migration: 002_payment_tables.sql
-- Run ONCE against store schema before deploying PaymentsModule.
-- Idempotent: all statements use IF NOT EXISTS / ON CONFLICT guards.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- payment_events — immutable audit log of every Stripe event received.
-- The UNIQUE constraint on stripe_event_id is the primary idempotency guard:
-- duplicate webhook deliveries are detected with INSERT ... ON CONFLICT DO NOTHING.
-- Processing status transitions: received → processed | failed | skipped
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store.payment_events (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id   TEXT        UNIQUE NOT NULL,
  event_type        TEXT        NOT NULL,
  object_id         TEXT,                          -- stripe session / payment_intent id
  order_id          TEXT,                          -- resolved after entity lookup
  raw_payload       JSONB       NOT NULL,
  processing_status TEXT        NOT NULL DEFAULT 'received'
                    CHECK (processing_status IN ('received','processed','failed','skipped')),
  processed_at      TIMESTAMPTZ,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_created_at
  ON store.payment_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_events_order_id
  ON store.payment_events (order_id)
  WHERE order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- payment_checkout_sessions — maps Stripe Checkout Sessions to orders.
-- One order can have at most one active session.
-- Expired sessions are kept for audit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store.payment_checkout_sessions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              TEXT        NOT NULL,
  user_id               UUID        NOT NULL,
  stripe_session_id     TEXT        UNIQUE NOT NULL,
  stripe_payment_intent TEXT,
  amount_cents          INTEGER     NOT NULL CHECK (amount_cents > 0),
  currency              TEXT        NOT NULL DEFAULT 'usd',
  status                TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','completed','expired','cancelled')),
  checkout_url          TEXT        NOT NULL,
  success_url           TEXT        NOT NULL,
  cancel_url            TEXT        NOT NULL,
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_sessions_order_id
  ON store.payment_checkout_sessions (order_id);

CREATE INDEX IF NOT EXISTS idx_payment_sessions_stripe_id
  ON store.payment_checkout_sessions (stripe_session_id);

-- ---------------------------------------------------------------------------
-- orders table: add payment columns if not already present.
-- payment_status values:
--   NULL            → initial (cod/wallet orders that don't need card payment)
--   checkout_created → Stripe session created, awaiting user action
--   succeeded       → payment confirmed via webhook
--   failed          → payment failed
--   refunded        → fully refunded
--   pending_refund  → cancellation requested, refund in flight
-- ---------------------------------------------------------------------------
ALTER TABLE store.orders
  ADD COLUMN IF NOT EXISTS stripe_session_id     TEXT,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_stripe_session
  ON store.orders (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
