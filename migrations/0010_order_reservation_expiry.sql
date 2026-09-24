-- 0010_order_reservation_expiry.sql
--
-- AMPED-06B — supports the reservation-expiry sweep.
--
-- The sweep runs every five minutes and looks for:
--
--   status = 'awaiting_payment' AND reservation_expires_at <= now
--
-- Before this migration `orders` had only the reference-unique index and
-- `orders_event_id_idx`, so that predicate was a full scan. This adds one
-- composite index; it changes no column, constraint or data.
--
-- Forward-only: migrations 0001–0009 are accepted history and are untouched.

CREATE INDEX orders_status_reservation_expires_at_idx
  ON orders (status, reservation_expires_at);
