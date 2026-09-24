-- 0011_inventory_capacity_guard.sql
--
-- AMPED-06C — the database-level second line of defence against overselling.
--
-- The primary gate is the conditional reservation UPDATE in
-- src/services/inventory/acquire.ts. This trigger independently re-derives
-- commercial inventory from orders/order_items/ticket_types and refuses any
-- pending -> awaiting_payment transition whose whole basket would exceed
-- capacity. Raw SQL that bypasses the service cannot oversell either.
--
-- Logical time: the trigger uses NEW.updated_at, which the application writes
-- as the same canonical `now` it binds into its own predicate, so both layers
-- evaluate existing reservations against identical time. Existing reservations
-- are those with reservation_expires_at strictly greater than that instant.
--
-- The body needs internal semicolons, so it uses the AMPED-06C0 compound
-- statement markers. No counter, table or column is added.

-- amped:statement-begin
CREATE TRIGGER orders_inventory_capacity_guard
BEFORE UPDATE OF status, reservation_expires_at ON orders
WHEN OLD.status = 'pending' AND NEW.status = 'awaiting_payment'
BEGIN
  SELECT RAISE(ABORT, 'inventory_capacity_exceeded')
  WHERE EXISTS (
    SELECT 1
    FROM (
      SELECT oi.ticket_type_id AS ticket_type_id, SUM(oi.quantity) AS requested
      FROM order_items oi
      WHERE oi.order_id = NEW.id
      GROUP BY oi.ticket_type_id
    ) req
    JOIN ticket_types tt ON tt.id = req.ticket_type_id
    WHERE req.requested > tt.capacity
      - COALESCE((
          SELECT SUM(s.quantity) FROM order_items s
          JOIN orders so ON so.id = s.order_id
          WHERE s.ticket_type_id = tt.id
            AND so.status IN ('paid', 'partially_refunded')
        ), 0)
      - COALESCE((
          SELECT SUM(r.quantity) FROM order_items r
          JOIN orders ro ON ro.id = r.order_id
          WHERE r.ticket_type_id = tt.id
            AND ro.status = 'awaiting_payment'
            AND julianday(ro.reservation_expires_at) > julianday(NEW.updated_at)
        ), 0)
  );
END;
-- amped:statement-end
