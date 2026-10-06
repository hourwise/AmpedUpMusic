-- AMPED-08C1: durable ticket-confirmation email outbox.
--
-- One row is one logical delivery intent. The local identity is `id`; the
-- provider's message id is nullable evidence that must never be used to
-- identify a delivery. `UNIQUE(order_id, message_type, version)` is the
-- invariant: one ticket-confirmation v1 intent per order, no matter how many
-- workers race to create it or how often the scheduler recovers.
--
-- The payload snapshot is frozen when the intent is created. A later event or
-- venue edit must not silently change an existing queued or retry delivery,
-- and a retry must render the same frozen values, so the table is immutable in
-- its identity and payload columns (see the trigger below).
CREATE TABLE email_deliveries (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  message_type        TEXT NOT NULL CHECK (message_type <> ''),
  version             INTEGER NOT NULL CHECK (version >= 1),
  recipient           TEXT NOT NULL CHECK (recipient <> ''),
  state               TEXT NOT NULL CHECK (
    state IN ('pending', 'claimed', 'accepted', 'retryable',
              'permanent_failure', 'ambiguous')
  ),
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider            TEXT,
  provider_message_id TEXT,
  idempotency_key     TEXT NOT NULL CHECK (idempotency_key <> ''),
  payload             TEXT NOT NULL CHECK (payload <> ''),
  payload_hash        TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at          TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  updated_at          TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at
  ),
  last_attempt_at     TEXT CHECK (
    last_attempt_at IS NULL OR
    strftime('%Y-%m-%dT%H:%M:%fZ', last_attempt_at) IS last_attempt_at
  ),
  accepted_at         TEXT CHECK (
    accepted_at IS NULL OR
    strftime('%Y-%m-%dT%H:%M:%fZ', accepted_at) IS accepted_at
  ),
  next_retry_at       TEXT CHECK (
    next_retry_at IS NULL OR
    strftime('%Y-%m-%dT%H:%M:%fZ', next_retry_at) IS next_retry_at
  ),
  claimed_at          TEXT CHECK (
    claimed_at IS NULL OR
    strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at) IS claimed_at
  ),
  lease_expires_at    TEXT CHECK (
    lease_expires_at IS NULL OR
    strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) IS lease_expires_at
  ),
  -- Fencing token. A worker may only record a result for the claim it holds;
  -- after a lease expires and another worker reclaims, the first worker's
  -- late result is a no-op rather than a corrupted state.
  claim_token         TEXT,
  -- Provider-independent classification of the last failure. No provider
  -- HTTP status or Resend-specific code may appear in business logic.
  last_error_class    TEXT CHECK (
    last_error_class IS NULL OR
    last_error_class IN ('retryable', 'permanent_failure', 'ambiguous', 'lease_expired')
  ),
  last_error_code     TEXT,
  last_error_message  TEXT CHECK (
    last_error_message IS NULL OR length(last_error_message) <= 500
  )
) STRICT;

-- The logical-delivery invariant for the V1 ticket confirmation, and the key
-- every recovery scan joins against.
CREATE UNIQUE INDEX email_deliveries_logical_unique
  ON email_deliveries (order_id, message_type, version);

-- The provider-independent logical idempotency key, stored with the intent.
CREATE UNIQUE INDEX email_deliveries_idempotency_unique
  ON email_deliveries (idempotency_key);

-- Bounded due-queue scans: only pending/retryable rows are ever claimed.
CREATE INDEX email_deliveries_due_idx
  ON email_deliveries (next_retry_at, created_at, id)
  WHERE state IN ('pending', 'retryable');

-- Bounded abandoned-lease scans.
CREATE INDEX email_deliveries_lease_idx
  ON email_deliveries (lease_expires_at, id)
  WHERE state = 'claimed';

-- Email-intent recovery scans only paid, fully-fulfilled orders. The ticket
-- and credential completeness predicates are per-order subqueries bounded by
-- this partial index and the limit clause.
CREATE INDEX orders_email_intent_missing_idx ON orders (paid_at, id)
  WHERE status = 'paid' AND tickets_fulfilled_at IS NOT NULL;

-- The snapshot and the logical identity are frozen at creation. State,
-- attempts, leases, provider evidence and error classification may change;
-- these columns may not.
-- amped:statement-begin
CREATE TRIGGER email_deliveries_frozen_guard
BEFORE UPDATE OF
  id, order_id, message_type, version, recipient, idempotency_key,
  payload, payload_hash, created_at
ON email_deliveries
BEGIN
  SELECT RAISE(ABORT, 'email delivery identity and payload are immutable');
END;
-- amped:statement-end

-- A durable outbox row is never deleted, so it can never be recreated as a
-- second logical intent for the same order.
-- amped:statement-begin
CREATE TRIGGER email_deliveries_no_delete
BEFORE DELETE ON email_deliveries
BEGIN
  SELECT RAISE(ABORT, 'email delivery records are durable');
END;
-- amped:statement-end
