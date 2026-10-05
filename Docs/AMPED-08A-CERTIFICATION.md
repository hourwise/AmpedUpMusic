# AMPED-08A — paid order ticket issuance

## Boundary

This slice issues durable ticket rows for orders already marked `paid` by the
existing verified payment path. It does not verify payments, create SumUp
checkouts, produce QR credentials, or send email. The older build-plan
requirement to transact payment and issuance together is superseded by the
accepted 08A request: payment is committed first and fulfilment is recoverable.

## Data model and existing history

`tickets.id` is the internal primary key; `tickets.reference` is globally
unique. Each ticket belongs to an order, event, and ticket type. The row has
optional attendee name, `issued` / `checked_in` / `void` / `refunded` status,
guest-list flag, issue/check-in timestamps, and a nullable token hash. The
token hash remains null for new 08A tickets. `order_items` store the purchased
ticket type, name, unit price and quantity. Those snapshots determine the
historical ticket count; later ticket-type changes do not.

Migration 0014 adds nullable `order_item_id` and positive `unit_ordinal` to
ticket rows, a unique index on that pair, and `orders.tickets_fulfilled_at`.
Existing tickets are matched to purchased units where possible. Already
complete paid histories receive a completion marker. Unmatched legacy tickets
remain unkeyed for explicit repair; issuance refuses to silently issue around
them. The existing seed has paid history with tickets and refunded history;
paid seed rows carry the marker and purchased-unit identities.

## Issuance and recovery invariant

For each paid order item, one ticket is inserted for every ordinal from 1 to
its purchased quantity. The internal ID is `tkt_<order_item_id>_<ordinal>`;
the public-facing reference is the order reference plus a stable sequence
number. This reference is an identifier, not a QR or admission secret. A D1
unique index on `(order_item_id, unit_ordinal)` is the concurrency authority.
A database trigger permits keyed tickets only against a matching paid order
item, within its purchased quantity. Paid order item snapshots cannot be
updated or deleted.

The webhook and payment reconciler invoke fulfilment after the existing paid
transition returns. A D1 batch inserts missing units, conditionally writes
the completion marker only when the whole expected set exists, and writes one
`order.fulfilled` audit record. If the Worker stops after payment but before
fulfilment, the order remains paid and unmarked. The five-minute scheduled
task scans that indexed pending set in `(paid_at, id)` order, at most 25 per
run, and retries the same idempotent service. A partial keyed set is filled
without duplicating existing units. Fulfilment failure does not roll back or
reinterpret a verified payment.

## Verification record

Local D1 tests cover concurrent issuers, webhook/reconciler overlap, immediate
issuance versus scheduler recovery, a crash between payment and fulfilment,
partial recovery, unpaid states, ticket-type edits after purchase, multiple
order items, the bounded indexed recovery query, and one order-level audit.

Hosted staging evidence, exact commit/deployment IDs, test totals, and the
certified CF-02 order result are recorded in the 08A completion report after
deployment.
