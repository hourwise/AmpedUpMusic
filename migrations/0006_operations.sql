-- 0006_operations.sql
--
-- AMPED-02A — the two operational ledgers: `audit_log` and
-- `processed_webhooks`.
-- Mirrors `AuditLogEntry` in src/types/domain.ts; `processed_webhooks`
-- implements the webhook idempotency requirement from architecture note R3.
--
-- `processed_webhooks` is deliberately keyed on (provider, provider_event_id),
-- not on an order: SumUp retries the same event id, so the second delivery of
-- a webhook must be recognisable before any order state is touched.
--
-- `audit_log` has no foreign key to the row it describes. The log has to
-- outlive the thing it describes - an audit trail that disappears when the
-- subject is deleted is not an audit trail - so `entity_id` is an opaque id
-- and `entity_type` names the table it referred to.

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  summary     TEXT NOT NULL,
  occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at)
) STRICT;

CREATE INDEX audit_log_occurred_at_idx ON audit_log (occurred_at);

CREATE TABLE processed_webhooks (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  received_at       TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', received_at) IS received_at),
  processed_at      TEXT CHECK (processed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', processed_at) IS processed_at)
) STRICT;

CREATE UNIQUE INDEX processed_webhooks_provider_event_unique ON processed_webhooks (provider, provider_event_id);
