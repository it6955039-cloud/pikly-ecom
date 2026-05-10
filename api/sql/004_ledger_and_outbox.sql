-- =============================================================================
-- Migration: 004_ledger_and_outbox.sql
-- Run AFTER 003_payment_hardening.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- store.payment_ledger — IMMUTABLE append-only financial record.
--
-- Purpose: Every payment state transition is permanently recorded here.
-- Records are NEVER updated or deleted — only appended.
-- This is the authoritative audit trail for:
--   * financial audits
--   * reconciliation investigations
--   * dispute resolution
--   * incident forensics
--   * replay analysis
--
-- Analogy: the double-entry ledger in accounting. Every debit and credit
-- is recorded regardless of what the mutable order row says.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store.payment_ledger (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          TEXT        NOT NULL,
  user_id           UUID        NOT NULL,
  entry_type        TEXT        NOT NULL
                    CHECK (entry_type IN (
                      'checkout_initiated',
                      'payment_succeeded',
                      'payment_failed',
                      'payment_cancelled',
                      'refund_issued',
                      'refund_partial',
                      'dispute_opened',
                      'checkout_expired',
                      'reconciliation_correction'
                    )),
  amount_cents      INTEGER     NOT NULL,
  currency          TEXT        NOT NULL DEFAULT 'usd',
  previous_status   TEXT,
  new_status        TEXT        NOT NULL,
  stripe_object_id  TEXT,           -- session / payment_intent / charge / refund id
  stripe_event_id   TEXT,           -- Stripe event that triggered this entry (NULL for manual)
  correlation_id    TEXT        NOT NULL,
  metadata          JSONB       NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ledger is write-once — no UPDATE/DELETE permissions should be granted in production
CREATE INDEX IF NOT EXISTS idx_payment_ledger_order_id
  ON store.payment_ledger (order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_ledger_user_id
  ON store.payment_ledger (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_ledger_stripe_event
  ON store.payment_ledger (stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- store.payment_outbox — Transactional outbox for payment domain events.
--
-- Events are written IN THE SAME TRANSACTION as order state mutations.
-- A dedicated processor polls and delivers them asynchronously.
--
-- Guarantee: Either the order state mutation AND the outbox event both commit,
-- or neither does. No split-brain. Side effects (email, fulfillment, analytics)
-- are delivered at-least-once with retry semantics.
--
-- Event types → consumers:
--   PaymentSucceeded    → email, fulfillment, analytics
--   PaymentFailed       → email notification
--   FulfillmentRequested → fulfillment service
--   CheckoutExpired     → notification
--   RefundIssued        → email, analytics
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store.payment_outbox (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      TEXT        NOT NULL
                  CHECK (event_type IN (
                    'PaymentSucceeded',
                    'PaymentFailed',
                    'FulfillmentRequested',
                    'CheckoutExpired',
                    'RefundIssued',
                    'DisputeOpened'
                  )),
  aggregate_id    TEXT        NOT NULL,   -- order_id
  payload         JSONB       NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','processed','failed','dead_lettered')),
  attempts        INTEGER     NOT NULL DEFAULT 0,
  max_attempts    INTEGER     NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error      TEXT,
  correlation_id  TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ
);

-- Processor query index: pending events ready to run, oldest first
CREATE INDEX IF NOT EXISTS idx_payment_outbox_pending
  ON store.payment_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_payment_outbox_aggregate
  ON store.payment_outbox (aggregate_id);

-- ---------------------------------------------------------------------------
-- store.orders: add version column for optimistic concurrency control
-- ---------------------------------------------------------------------------
ALTER TABLE store.orders
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

-- Bump version on every update — prevents stale writes
-- Callers must: UPDATE orders SET ..., version = version + 1 WHERE order_id = $1 AND version = $expectedVersion
