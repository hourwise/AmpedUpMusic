-- 0013_payment_discrepancies.sql
--
-- AMPED-07D2-2 — durable record of money we cannot safely account for.
--
-- WHY THIS EXISTS
-- A reservation stops reserving inventory the instant `reservation_expires_at`
-- passes: availability is computed against the reading request's clock, not
-- against whether the bookkeeping sweep has run yet. So once that moment
-- passes the seats are genuinely back on sale, and an order can never
-- afterwards become `paid` without risking selling the same seat twice.
--
-- That is the right rule, and it leaves a real-world hole: SumUp may already
-- have taken the customer's money. Until now that condition existed only as a
-- console warning, which is not an acceptable record of a financial exception.
-- This table is that record.
--
-- WHAT A ROW MEANS
-- "Authenticated provider evidence indicates SumUp may hold customer money
-- which Amped Up cannot safely attach to the local order."
--
-- It does NOT mean an order is refunded, or that Amped Up has done anything.
-- V1 policy is unchanged: the operator refunds in SumUp. These rows exist so
-- that a human knows to, and can prove what happened afterwards.
--
-- WHY NOT `processed_webhooks`
-- That table records a different fact - "we have already verified and applied
-- this provider observation". Reusing it would conflate a success with an
-- exception. They are kept apart deliberately.
--
-- TWO UNIQUE CONSTRAINTS, BOTH LOAD-BEARING
--   `identity_key` is the business idempotency key, and is never NULL - which
--   is precisely why it is not `UNIQUE(provider, transaction_id)`: SQLite
--   permits unlimited NULLs through a UNIQUE constraint, so a nullable
--   transaction id would silently allow duplicate rows for the one case most
--   likely to recur (a PAID checkout whose transaction list has not settled).
--
--   `UNIQUE(order_id, checkout_id)` closes a second, different gap. A
--   discrepancy first seen without a transaction id gets the checkout-derived
--   key; if the transaction later settles, the preferred transaction-derived
--   key would differ and would otherwise insert a SECOND row for the same
--   money. One checkout belongs to one order (0012), and one checkout can
--   only be paid once, so one row per (order, checkout) is the truth.
--
-- Neither constraint subsumes the other: the first stops concurrent inserts,
-- the second stops sequential re-identification. Both are required.
--
-- Forward-only: migrations 0001-0012 are accepted history and are untouched.

CREATE TABLE payment_discrepancies (
  id                       TEXT PRIMARY KEY,
  -- Deterministic business identity. Derived only from our own stored
  -- checkout id or from an authenticated provider transaction id - never
  -- from webhook payload text, which is attacker-supplied.
  identity_key             TEXT NOT NULL,
  order_id                 TEXT NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  provider                 TEXT NOT NULL,
  checkout_id              TEXT NOT NULL,
  -- Null while a PAID checkout's transaction list has not yet settled.
  transaction_id           TEXT,
  kind                     TEXT NOT NULL CHECK (kind IN (
                             'paid_after_expiry',
                             'paid_order_expired',
                             'amount_mismatch',
                             'correlation_mismatch'
                           )),
  -- Integer pence, never a float. Null only when the provider's amount was
  -- malformed or over-precision, which is itself the discrepancy.
  provider_amount_in_pence INTEGER CHECK (provider_amount_in_pence IS NULL OR provider_amount_in_pence >= 0),
  local_amount_in_pence    INTEGER NOT NULL CHECK (local_amount_in_pence >= 0),
  provider_paid_at         TEXT CHECK (provider_paid_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', provider_paid_at) IS provider_paid_at),
  reservation_expires_at   TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', reservation_expires_at) IS reservation_expires_at),
  -- `refund_requested` / `refund_confirmed` / `refund_failed` are reserved for
  -- the later in-app refund slice. AMPED-07D2-2 can only ever write `open`;
  -- the operator workflow in 07D2-3 adds the two manual outcomes.
  state                    TEXT NOT NULL CHECK (state IN (
                             'open',
                             'resolved_manually',
                             'dismissed',
                             'refund_requested',
                             'refund_confirmed',
                             'refund_failed'
                           )),
  detected_at              TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', detected_at) IS detected_at),
  last_checked_at          TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', last_checked_at) IS last_checked_at),
  resolved_at              TEXT CHECK (resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS resolved_at)
) STRICT;

CREATE UNIQUE INDEX payment_discrepancies_identity_unique
  ON payment_discrepancies (identity_key);

CREATE UNIQUE INDEX payment_discrepancies_order_checkout_unique
  ON payment_discrepancies (order_id, checkout_id);

-- The detector's candidate query asks "does this order already have one?",
-- and the operator list asks "what is still open, newest first".
CREATE INDEX payment_discrepancies_state_detected_at_idx
  ON payment_discrepancies (state, detected_at);

-- Append-only history. Rows are never updated or deleted, including after a
-- discrepancy is resolved: destroying the trail once the money is sorted out
-- would remove exactly the evidence an auditor would ask for.
CREATE TABLE payment_discrepancy_events (
  id             TEXT PRIMARY KEY,
  discrepancy_id TEXT NOT NULL REFERENCES payment_discrepancies (id) ON DELETE RESTRICT,
  event          TEXT NOT NULL,
  actor          TEXT NOT NULL,
  occurred_at    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  -- Short, safe, operator-readable context. Never a provider response body,
  -- never card data, never credentials.
  detail         TEXT
) STRICT;

CREATE INDEX payment_discrepancy_events_discrepancy_id_idx
  ON payment_discrepancy_events (discrepancy_id, occurred_at);
