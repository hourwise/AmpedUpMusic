/**
 * AMPED-08A — durable fulfilment of an already-paid order.
 *
 * Payment is never inferred here. A SQL paid predicate and the 0014 trigger
 * gate every inserted unit. The purchased order-item snapshots, rather than
 * current ticket-type price or availability, determine the ticket set.
 *
 * One D1 batch inserts missing deterministic units, marks the order complete,
 * and records one business audit. D1 rolls the whole batch back on failure.
 * A crash before the batch is recovered by the indexed pending-order scan;
 * a retry after the batch is a no-op. The unique (order_item_id, unit_ordinal)
 * index is the concurrency authority, including across Worker isolates.
 */

export const FULFILMENT_RECOVERY_LIMIT = 25;

import { createD1TicketCredentials } from './credentials.ts';

export interface IssuanceResult {
  orderId: string;
  outcome: 'unpaid' | 'complete';
  expected: number;
  issued: number;
}

export interface FulfilmentRecoverySummary {
  examined: number;
  issued: number;
  completed: number;
  failures: number;
}

export interface TicketIssuanceService {
  issuePaidOrder(orderId: string): Promise<IssuanceResult>;
  recoverPending(limit?: number): Promise<FulfilmentRecoverySummary>;
}

interface OrderSnapshot {
  status: string;
  tickets_fulfilled_at: string | null;
  expected: number;
  unkeyed: number;
}

const ORDER_SNAPSHOT_SQL =
  'select o.status, o.tickets_fulfilled_at, ' +
  '(select coalesce(sum(i.quantity), 0) from order_items i where i.order_id = o.id) as expected, ' +
  '(select count(*) from tickets t where t.order_id = o.id and t.order_item_id is null) as unkeyed ' +
  'from orders o where o.id = ?1';

// SQLite's SELECT ... ON CONFLICT grammar needs WHERE 1 before the upsert.
// row_number gives a stable, human-readable reference across multiple items.
const INSERT_UNITS_SQL = `
  with recursive units (
    item_id, order_id, event_id, ticket_type_id, unit_ordinal, quantity,
    order_reference
  ) as (
    select i.id, i.order_id, o.event_id, i.ticket_type_id, 1, i.quantity,
           o.reference
    from order_items i
      join orders o on o.id = i.order_id
    where o.id = ?1 and o.status = 'paid' and o.tickets_fulfilled_at is null
    union all
    select item_id, order_id, event_id, ticket_type_id,
           unit_ordinal + 1, quantity, order_reference
    from units where unit_ordinal < quantity
  ), numbered as (
    select *, row_number() over (order by item_id, unit_ordinal) as reference_ordinal
    from units
  )
  insert into tickets (
    id, order_id, event_id, ticket_type_id, order_item_id, unit_ordinal,
    reference, token_hash, status, attendee_name, is_guest_list, issued_at, checked_in_at
  )
  select 'tkt_' || item_id || '_' || unit_ordinal,
         order_id, event_id, ticket_type_id, item_id, unit_ordinal,
         order_reference || '-' || reference_ordinal,
         null, 'issued', null, 0, ?2, null
  from numbered where 1
  on conflict (order_item_id, unit_ordinal) do nothing
`;

const MARK_COMPLETE_SQL = `
  update orders set tickets_fulfilled_at = ?2
  where id = ?1 and status = 'paid' and tickets_fulfilled_at is null
    and exists (select 1 from order_items i where i.order_id = orders.id)
    and (select count(*) from tickets t where t.order_id = orders.id)
      = (select sum(i.quantity) from order_items i where i.order_id = orders.id)
    and (select count(*) from tickets t
         where t.order_id = orders.id and t.order_item_id is not null)
      = (select sum(i.quantity) from order_items i where i.order_id = orders.id)
`;

const AUDIT_COMPLETE_SQL = `
  insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at)
  select 'aud_fulfil_' || o.id, 'system:ticket-fulfilment',
         'order.fulfilled', 'order', o.id,
         'Issued ' || (select sum(i.quantity) from order_items i where i.order_id = o.id)
           || ' tickets for ' || o.reference,
         ?2
  from orders o
  where o.id = ?1 and o.status = 'paid' and o.tickets_fulfilled_at is not null
    and not exists (
      select 1 from audit_log a where a.entity_type = 'order'
        and a.entity_id = o.id and a.action = 'order.fulfilled'
    )
`;

const CANDIDATES_SQL = `
  select id from orders indexed by orders_unfulfilled_paid_idx
  where status = 'paid' and tickets_fulfilled_at is null
  order by paid_at, id limit ?1
`;

export function createD1TicketIssuance(
  db: D1Database,
  now: () => Date = () => new Date(),
): TicketIssuanceService {
  const credentials = createD1TicketCredentials(db);
  async function issuePaidOrder(orderId: string): Promise<IssuanceResult> {
    const snapshot = await db.prepare(ORDER_SNAPSHOT_SQL).bind(orderId).first<OrderSnapshot>();
    if (!snapshot) throw new Error('Order not found for ticket fulfilment.');
    if (snapshot.status !== 'paid') {
      return { orderId, outcome: 'unpaid', expected: snapshot.expected, issued: 0 };
    }
    if (snapshot.tickets_fulfilled_at !== null) {
      await credentials.ensureForOrder(orderId);
      return { orderId, outcome: 'complete', expected: snapshot.expected, issued: 0 };
    }
    if (snapshot.expected <= 0 || snapshot.unkeyed > 0) {
      throw new Error('Paid order has no authoritative ticket-unit mapping.');
    }

    const at = now().toISOString();
    const results = await db.batch([
      db.prepare(INSERT_UNITS_SQL).bind(orderId, at),
      db.prepare(MARK_COMPLETE_SQL).bind(orderId, at),
      db.prepare(AUDIT_COMPLETE_SQL).bind(orderId, at),
    ]);
    const issued = Number(results[0]?.meta?.changes ?? 0);
    const completion = await db
      .prepare('select tickets_fulfilled_at from orders where id = ?1 and status = ?2')
      .bind(orderId, 'paid')
      .first<{ tickets_fulfilled_at: string | null }>();
    if (!completion?.tickets_fulfilled_at) {
      throw new Error('Paid order ticket fulfilment remains incomplete.');
    }
    await credentials.ensureForOrder(orderId);
    return { orderId, outcome: 'complete', expected: snapshot.expected, issued };
  }

  async function recoverPending(limit = FULFILMENT_RECOVERY_LIMIT): Promise<FulfilmentRecoverySummary> {
    const boundedLimit = Math.max(1, Math.min(FULFILMENT_RECOVERY_LIMIT, Math.floor(limit)));
    const candidates = await db
      .prepare(CANDIDATES_SQL)
      .bind(boundedLimit)
      .all<{ id: string }>();
    const summary: FulfilmentRecoverySummary = {
      examined: candidates.results.length,
      issued: 0,
      completed: 0,
      failures: 0,
    };
    for (const candidate of candidates.results) {
      try {
        const result = await issuePaidOrder(candidate.id);
        if (result.outcome === 'complete') {
          summary.issued += result.issued;
          summary.completed += 1;
        }
      } catch (error) {
        summary.failures += 1;
        console.warn(JSON.stringify({
          at: 'ticket-fulfilment',
          event: 'recovery-failed',
          kind: error instanceof Error ? error.name : 'unknown',
        }));
      }
    }
    return summary;
  }

  return { issuePaidOrder, recoverPending };
}
