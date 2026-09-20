-- 0004_ticketing.sql
--
-- AMPED-02A — the money path: `ticket_types`, `orders`, `order_items`,
-- `tickets` and `checkins`.
-- Mirrors `TicketType`, `Order`, `OrderItem`, `Ticket` and `CheckIn` in
-- src/types/domain.ts.
--
-- DELETION RULES (architecture note R8). An event that has ever taken money
-- can never be hard-deleted:
--   * orders.event_id -> events RESTRICT  (the rule the build plan names)
--   * tickets.order_id -> orders RESTRICT (a ticket never silently vanishes)
--   * order_items.ticket_type_id -> ticket_types RESTRICT
--   * checkins.ticket_id -> tickets RESTRICT
-- So `delete from events where id = ?` is refused while an order exists, and
-- no cascade can reach an admission record behind the database's back.
--
-- Order state rules that the domain model documents in prose are enforced
-- here as well:
--   * `paid` requires `paid_at`. `paid` may only be written from a verified
--     provider confirmation (R2), and that confirmation always carries a time.
--   * `awaiting_payment` requires `reservation_expires_at`. The reservation
--     window is what AMPED-02D/06B use to decide whether held stock still
--     counts against availability (R15), so it must never be absent.
--
-- Note on tickets: `TicketStatus` has no "held" state, and the domain model
-- says only a paid order may issue tickets, so an unpaid order has order_items
-- but no ticket rows. Reserved stock is therefore derived from order_items,
-- never from tickets.

CREATE TABLE ticket_types (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  price_in_pence INTEGER NOT NULL CHECK (price_in_pence >= 0),
  capacity       INTEGER NOT NULL CHECK (capacity >= 0),
  max_per_order  INTEGER CHECK (max_per_order IS NULL OR max_per_order > 0),
  sales_open_at  TEXT CHECK (sales_open_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sales_open_at) IS sales_open_at),
  sales_close_at TEXT CHECK (sales_close_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sales_close_at) IS sales_close_at),
  position       INTEGER NOT NULL CHECK (position >= 0),
  visibility     TEXT NOT NULL CHECK (visibility IN ('public', 'hidden')),
  CHECK (sales_open_at IS NULL OR sales_close_at IS NULL OR sales_close_at > sales_open_at)
) STRICT;

CREATE INDEX ticket_types_event_id_idx ON ticket_types (event_id);

CREATE TABLE orders (
  id                     TEXT PRIMARY KEY,
  reference              TEXT NOT NULL,
  event_id               TEXT NOT NULL REFERENCES events (id) ON DELETE RESTRICT,
  customer_name          TEXT NOT NULL,
  customer_email         TEXT NOT NULL,
  customer_phone         TEXT,
  status                 TEXT NOT NULL CHECK (status IN ('pending', 'awaiting_payment', 'paid', 'cancelled', 'expired', 'refunded', 'partially_refunded')),
  total_in_pence         INTEGER NOT NULL CHECK (total_in_pence >= 0),
  fee_in_pence           INTEGER NOT NULL DEFAULT 0 CHECK (fee_in_pence >= 0),
  payment_reference      TEXT,
  payment_provider       TEXT CHECK (payment_provider IS NULL OR payment_provider IN ('sumup', 'mock', 'cash', 'comp')),
  paid_at                TEXT CHECK (paid_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', paid_at) IS paid_at),
  reservation_expires_at TEXT CHECK (reservation_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', reservation_expires_at) IS reservation_expires_at),
  marketing_opt_in       INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0, 1)),
  created_at             TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at             TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  CHECK (status <> 'awaiting_payment' OR reservation_expires_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX orders_reference_unique ON orders (reference);

CREATE INDEX orders_event_id_idx ON orders (event_id);

CREATE TABLE order_items (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  ticket_type_id     TEXT NOT NULL REFERENCES ticket_types (id) ON DELETE RESTRICT,
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_in_pence INTEGER NOT NULL CHECK (unit_price_in_pence >= 0),
  ticket_type_name   TEXT NOT NULL
) STRICT;

CREATE INDEX order_items_order_id_idx ON order_items (order_id);

CREATE INDEX order_items_ticket_type_id_idx ON order_items (ticket_type_id);

CREATE TABLE tickets (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  event_id      TEXT NOT NULL REFERENCES events (id) ON DELETE RESTRICT,
  ticket_type_id TEXT NOT NULL REFERENCES ticket_types (id) ON DELETE RESTRICT,
  reference     TEXT NOT NULL,
  token_hash    TEXT,
  status        TEXT NOT NULL CHECK (status IN ('issued', 'checked_in', 'void', 'refunded')),
  attendee_name TEXT,
  is_guest_list INTEGER NOT NULL DEFAULT 0 CHECK (is_guest_list IN (0, 1)),
  issued_at     TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) IS issued_at),
  checked_in_at TEXT CHECK (checked_in_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', checked_in_at) IS checked_in_at)
) STRICT;

CREATE UNIQUE INDEX tickets_reference_unique ON tickets (reference);

CREATE INDEX tickets_order_id_idx ON tickets (order_id);

CREATE INDEX tickets_event_id_idx ON tickets (event_id);

-- Drives `sold` in AMPED-02D: tickets in `issued` or `checked_in` per type.
CREATE INDEX tickets_ticket_type_status_idx ON tickets (ticket_type_id, status);

CREATE TABLE checkins (
  id             TEXT PRIMARY KEY,
  ticket_id      TEXT NOT NULL REFERENCES tickets (id) ON DELETE RESTRICT,
  event_id       TEXT NOT NULL REFERENCES events (id) ON DELETE RESTRICT,
  operator_email TEXT NOT NULL,
  method         TEXT NOT NULL CHECK (method IN ('qr', 'manual', 'guest-list')),
  scanned_at     TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', scanned_at) IS scanned_at)
) STRICT;

-- One admission record per ticket. Two phones scanning the same code produce
-- one row and one unique-constraint failure, never two admissions (R4).
CREATE UNIQUE INDEX checkins_ticket_id_unique ON checkins (ticket_id);

CREATE INDEX checkins_event_id_idx ON checkins (event_id);
