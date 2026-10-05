-- AMPED-08A: each purchased unit has one durable identity. Existing tickets
-- remain valid; the backfill assigns identities where their order-item
-- snapshots account for them. NULL is retained only for legacy/unmatched rows.
ALTER TABLE tickets ADD COLUMN order_item_id TEXT REFERENCES order_items (id);
ALTER TABLE tickets ADD COLUMN unit_ordinal INTEGER CHECK (unit_ordinal IS NULL OR unit_ordinal > 0);
CREATE UNIQUE INDEX tickets_purchased_unit_unique ON tickets (order_item_id, unit_ordinal);

-- A completion marker is a bounded recovery queue: the scheduler reads only
-- paid orders with no marker, rather than revisiting every historical sale.
ALTER TABLE orders ADD COLUMN tickets_fulfilled_at TEXT CHECK (
  tickets_fulfilled_at IS NULL OR
  strftime('%Y-%m-%dT%H:%M:%fZ', tickets_fulfilled_at) IS tickets_fulfilled_at
);
CREATE INDEX orders_unfulfilled_paid_idx ON orders (paid_at, id)
  WHERE status = 'paid' AND tickets_fulfilled_at IS NULL;
CREATE UNIQUE INDEX audit_order_fulfilled_unique
  ON audit_log (entity_id) WHERE entity_type = 'order' AND action = 'order.fulfilled';

-- Existing databases may already hold tickets. Rank each ticket inside its
-- order/type and assign it to the corresponding immutable item quantity range.
-- Unmatched excess legacy rows are intentionally left NULL for operator repair
-- rather than silently inventing a purchased unit.
WITH ticket_positions AS (
  SELECT id, order_id, ticket_type_id,
         row_number() OVER (PARTITION BY order_id, ticket_type_id ORDER BY id) AS n
  FROM tickets
), item_ranges AS (
  SELECT id, order_id, ticket_type_id, quantity,
         sum(quantity) OVER (
           PARTITION BY order_id, ticket_type_id ORDER BY id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) - quantity AS before_n
  FROM order_items
), matches AS (
  SELECT t.id AS ticket_id, i.id AS item_id, t.n - i.before_n AS ordinal
  FROM ticket_positions t JOIN item_ranges i
    ON i.order_id = t.order_id AND i.ticket_type_id = t.ticket_type_id
   AND t.n > i.before_n AND t.n <= i.before_n + i.quantity
)
UPDATE tickets
SET order_item_id = (SELECT item_id FROM matches WHERE ticket_id = tickets.id),
    unit_ordinal = (SELECT ordinal FROM matches WHERE ticket_id = tickets.id)
WHERE id IN (SELECT ticket_id FROM matches);

-- Already-complete paid histories do not enter the recovery queue. The
-- certified CF-02 order has no tickets, so it deliberately remains pending.
UPDATE orders
SET tickets_fulfilled_at = paid_at
WHERE status = 'paid'
  AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = orders.id)
  AND (SELECT count(*) FROM tickets t WHERE t.order_id = orders.id AND t.order_item_id IS NOT NULL)
      = (SELECT sum(quantity) FROM order_items i WHERE i.order_id = orders.id)
  AND (SELECT count(*) FROM tickets t WHERE t.order_id = orders.id)
      = (SELECT sum(quantity) FROM order_items i WHERE i.order_id = orders.id);

-- 08A-written tickets are permitted only for already-paid matching items.
-- Legacy rows without a unit identity retain their pre-existing behaviour.
-- amped:statement-begin
CREATE TRIGGER tickets_purchased_unit_paid_guard
BEFORE INSERT ON tickets
WHEN NEW.order_item_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'purchased ticket requires a paid matching order item')
  WHERE NEW.unit_ordinal IS NULL OR NOT EXISTS (
    SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE i.id = NEW.order_item_id AND i.order_id = NEW.order_id
      AND i.ticket_type_id = NEW.ticket_type_id AND o.event_id = NEW.event_id
      AND o.status = 'paid' AND NEW.unit_ordinal BETWEEN 1 AND i.quantity
  );
END;
-- amped:statement-end

-- Purchased quantities and prices are historical snapshots after payment.
-- Seed insertion into an already-paid historical order remains possible, but
-- neither the application nor a later operator edit can rewrite or remove a
-- captured paid item.
-- amped:statement-begin
CREATE TRIGGER paid_order_item_immutable_update
BEFORE UPDATE ON order_items
WHEN EXISTS (
  SELECT 1 FROM orders o WHERE o.id = OLD.order_id
    AND o.status IN ('paid', 'partially_refunded', 'refunded')
)
BEGIN
  SELECT RAISE(ABORT, 'paid order item is immutable');
END;
-- amped:statement-end

-- amped:statement-begin
CREATE TRIGGER paid_order_item_immutable_delete
BEFORE DELETE ON order_items
WHEN EXISTS (
  SELECT 1 FROM orders o WHERE o.id = OLD.order_id
    AND o.status IN ('paid', 'partially_refunded', 'refunded')
)
BEGIN
  SELECT RAISE(ABORT, 'paid order item is immutable');
END;
-- amped:statement-end
