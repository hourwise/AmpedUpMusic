-- AMPED-08B. An opaque, random credential belongs to the durable ticket.
-- NULL represents an older ticket awaiting idempotent credential recovery.
ALTER TABLE tickets ADD COLUMN credential_id TEXT CHECK (
  credential_id IS NULL OR length(credential_id) = 43
);
CREATE UNIQUE INDEX tickets_credential_id_unique ON tickets (credential_id);
CREATE INDEX tickets_missing_credential_idx ON tickets (issued_at, id)
  WHERE credential_id IS NULL AND status IN ('issued', 'checked_in');

-- A credential may later rotate to another non-NULL value, invalidating its
-- earlier token without rewriting the ticket identity.
-- amped:statement-begin
CREATE TRIGGER tickets_credential_cannot_clear
BEFORE UPDATE OF credential_id ON tickets
WHEN OLD.credential_id IS NOT NULL AND NEW.credential_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'ticket credential cannot be cleared');
END;
-- amped:statement-end

-- One permanent business event per ticket admission, including under races.
CREATE UNIQUE INDEX audit_ticket_checked_in_unique ON audit_log (entity_id)
  WHERE entity_type = 'ticket' AND action = 'ticket.checked_in';
