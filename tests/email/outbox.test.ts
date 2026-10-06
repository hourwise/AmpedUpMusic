/**
 * AMPED-08C1: the durable ticket-email outbox.
 *
 * Real ephemeral D1; a mock payment provider; a fake email transport only
 * where the delivery machinery itself is under test. No provider is
 * contacted anywhere and no email API key exists.
 *
 * What this suite is really about:
 *  - one logical intent per order, under concurrency and under recovery;
 *  - eligibility that fails closed for anything except paid + fully
 *    fulfilled + fully credentialised;
 *  - a frozen payload that later event/venue edits cannot rewrite;
 *  - claim/lease fencing, so concurrent workers cannot own one delivery and
 *    an abandoned lease is recoverable without letting a stale writer win;
 *  - a no-transport pass that performs zero external sends and does not
 *    churn unsendable rows.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../../src/db/local.ts';
import { migrate } from '../../src/db/migrations.ts';
import { applySeed } from '../../src/db/seed.ts';
import { createD1OrderMutations } from '../../src/services/orders/service.ts';
import { createMockPaymentProvider } from '../../src/services/payments/mock.ts';
import { createD1TicketIssuance } from '../../src/services/tickets/issuance.ts';
import { createD1TicketCredentials } from '../../src/services/tickets/credentials.ts';
import { createTicketTokenService, newCredentialId } from '../../src/services/tickets/token.ts';
import {
  createD1EmailDeliveries,
  retryDelayMs,
  EMAIL_RETRY_BASE_MS,
  type EmailDeliveryService,
} from '../../src/services/email/deliveries.ts';
import { createEmailDeliveryPass } from '../../src/services/email/runner.ts';
import {
  payloadHash,
  ticketConfirmationIdempotencyKey,
  type TicketConfirmationPayload,
} from '../../src/services/email/render.ts';
import type { OutboundEmail } from '../../src/services/email/transport.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NOW = new Date('2026-10-06T12:00:00.000Z');
const EVENT = 'evt_glass_hearts_nov';
const TYPE = 'tt_gh_ga';

describe('AMPED-08C1 durable ticket-email outbox', () => {
  let ephemeral: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let serial = 0;
  // Ephemeral signing material; never a staging or fixture secret.
  const tokens = createTicketTokenService(newCredentialId());

  beforeAll(async () => {
    ephemeral = await openEphemeralDatabase();
    db = ephemeral.db;
    await migrate(db);
    await applySeed(db);
  });

  afterAll(async () => ephemeral.dispose());

  function deliveries(): EmailDeliveryService {
    return createD1EmailDeliveries(db);
  }

  /** A paid order, exactly as the accepted checkout/webhook path leaves it. */
  async function paidOrder(quantity = 2) {
    const orders = createD1OrderMutations(db, () => NOW, (prefix) => `${prefix}_08c1_${++serial}`);
    const created = await orders.createOrder({
      eventId: EVENT,
      items: [{ ticketTypeId: TYPE, quantity }],
      customerName: '08C1 Buyer',
      customerEmail: `08c1-${++serial}@example.invalid`,
      marketingOptIn: false,
    });
    const provider = createMockPaymentProvider({ now: () => NOW, newId: () => `08c1_${++serial}` });
    const checkout = await orders.beginPayment(created.orderId, provider, 'https://amped.test/checkout/return');
    await orders.confirmPayment(created.orderId, checkout.checkoutId, provider);
    return created.orderId;
  }

  /** Paid, ticketed and credentialised: the full 08A/08B pipeline. */
  async function fulfilledOrder(quantity = 2) {
    const orderId = await paidOrder(quantity);
    await createD1TicketIssuance(db, () => NOW).issuePaidOrder(orderId);
    return orderId;
  }

  async function intentFor(orderId: string) {
    const created = await deliveries().ensureConfirmationIntent(orderId, NOW);
    expect(created.outcome).toBe('created');
    return { id: created.deliveryId!, service: deliveries() };
  }

  async function deliveryCount(orderId: string): Promise<number> {
    const row = await db
      .prepare('select count(*) as n from email_deliveries where order_id = ?1')
      .bind(orderId)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  it('creates one logical intent under 20 concurrent creators, with the frozen identity', async () => {
    const orderId = await fulfilledOrder(3);
    const service = deliveries();

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => service.ensureConfirmationIntent(orderId, NOW)),
    );
    expect(outcomes.filter((outcome) => outcome.outcome === 'created')).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.deliveryId).filter(Boolean)).size).toBe(1);
    expect(await deliveryCount(orderId)).toBe(1);

    const row = await service.findForOrder(orderId);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(`eml_${orderId}_ticket_confirmation_v1`);
    expect(row!.state).toBe('pending');
    expect(row!.attemptCount).toBe(0);
    expect(row!.idempotencyKey).toBe(ticketConfirmationIdempotencyKey(orderId));
    expect(row!.idempotencyKey).toBe(`ampedup:ticket-confirmation:v1:${orderId}`);
    expect(row!.providerMessageId).toBeNull();
    expect(row!.payloadHash).toBe(await payloadHash(row!.payload));

    // The logical invariant is a database constraint, not a convention: a
    // second intent for the same order/message/version is refused outright.
    await expect(
      db
        .prepare(
          `insert into email_deliveries (id, order_id, message_type, version, recipient,
             state, attempt_count, idempotency_key, payload, payload_hash, created_at, updated_at)
           values ('eml_duplicate_intent', ?1, ?2, ?3, ?4, 'pending', 0, 'ampedup:duplicate',
             ?5, ?6, ?7, ?7)`,
        )
        .bind(row!.orderId, row!.messageType, row!.version, row!.recipient, row!.payload, row!.payloadHash, NOW.toISOString())
        .run(),
    ).rejects.toThrow();
  });

  it('creates exactly one intent across concurrent recovery workers', async () => {
    // Settle everything already eligible so this test observes only its own
    // target, then leave one completed order without an intent.
    const service = deliveries();
    await service.recoverMissingIntents();
    const orderId = await fulfilledOrder(2);
    expect(await deliveryCount(orderId)).toBe(0);

    const summaries = await Promise.all(
      Array.from({ length: 5 }, () => service.recoverMissingIntents()),
    );
    expect(summaries.reduce((total, summary) => total + summary.created, 0)).toBe(1);
    expect(await deliveryCount(orderId)).toBe(1);
    // Running the recovery again is a no-op.
    expect((await service.recoverMissingIntents()).created).toBe(0);
  });

  it('is indexed and bounded for the recovery scan and the due queue', async () => {
    const candidatePlan = await db
      .prepare(
        `explain query plan select o.id from orders o indexed by orders_email_intent_missing_idx
         where o.status = 'paid' and o.tickets_fulfilled_at is not null limit ?1`,
      )
      .bind(25)
      .all<{ detail: string }>();
    expect(
      candidatePlan.results.some((row) => row.detail.includes('orders_email_intent_missing_idx')),
    ).toBe(true);

    const duePlan = await db
      .prepare(
        `explain query plan select id from email_deliveries indexed by email_deliveries_due_idx
         where state in ('pending', 'retryable')
           and (next_retry_at is null or next_retry_at <= ?1) limit ?2`,
      )
      .bind(NOW.toISOString(), 25)
      .all<{ detail: string }>();
    expect(duePlan.results.some((row) => row.detail.includes('email_deliveries_due_idx'))).toBe(true);
  });

  it('refuses an intent for orders that are not admissibly paid', async () => {
    const service = deliveries();

    // Never paid: awaiting payment is not evidence of payment.
    const orders = createD1OrderMutations(db, () => NOW, (prefix) => `${prefix}_08c1_${++serial}`);
    const awaiting = await orders.createOrder({
      eventId: EVENT,
      items: [{ ticketTypeId: TYPE, quantity: 1 }],
      customerName: '08C1 Awaiting',
      customerEmail: `08c1-awaiting-${++serial}@example.invalid`,
      marketingOptIn: false,
    });
    expect((await service.ensureConfirmationIntent(awaiting.orderId, NOW)).outcome).toBe('not_eligible');

    // Refunded after fulfilment: no confirmation intent may be created.
    const refundedId = await fulfilledOrder(1);
    await db.prepare("update orders set status = 'refunded' where id = ?1").bind(refundedId).run();
    expect((await service.ensureConfirmationIntent(refundedId, NOW)).outcome).toBe('not_eligible');

    // Partially refunded is manual-review territory in 08B and inadmissible here.
    const partialId = await fulfilledOrder(1);
    await db.prepare("update orders set status = 'partially_refunded' where id = ?1").bind(partialId).run();
    expect((await service.ensureConfirmationIntent(partialId, NOW)).outcome).toBe('not_eligible');
  });

  it('refuses an intent until the ticket set is complete and credentialised', async () => {
    const service = deliveries();

    // Paid but not yet ticketed: the crash window 08A covers.
    const unfulfilledId = await paidOrder(2);
    expect((await service.ensureConfirmationIntent(unfulfilledId, NOW)).outcome).toBe('not_eligible');

    // Fulfilled marker set, but a durable unit is missing.
    const partialId = await fulfilledOrder(3);
    await db
      .prepare('delete from tickets where order_id = ?1 and unit_ordinal = 3')
      .bind(partialId)
      .run();
    expect((await service.ensureConfirmationIntent(partialId, NOW)).outcome).toBe('not_eligible');
    expect(await deliveryCount(partialId)).toBe(0);

    // Complete ticket set, but one ticket has no durable credential. The
    // accepted 08B recovery fills it, and only then does the intent appear.
    const missingCredentialId = await paidOrder(2);
    const item = await db
      .prepare('select id, quantity from order_items where order_id = ?1')
      .bind(missingCredentialId)
      .first<{ id: string; quantity: number }>();
    const reference = await db
      .prepare('select reference from orders where id = ?1')
      .bind(missingCredentialId)
      .first<{ reference: string }>();
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      await db
        .prepare(
          `insert into tickets (id, order_id, event_id, ticket_type_id, order_item_id,
             unit_ordinal, reference, status, is_guest_list, issued_at)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'issued', 0, ?8)`,
        )
        .bind(
          `tkt_${item!.id}_${ordinal}`,
          missingCredentialId,
          EVENT,
          TYPE,
          item!.id,
          ordinal,
          `${reference!.reference}-${ordinal}`,
          NOW.toISOString(),
        )
        .run();
    }
    await db
      .prepare('update orders set tickets_fulfilled_at = ?2 where id = ?1')
      .bind(missingCredentialId, NOW.toISOString())
      .run();
    expect((await service.ensureConfirmationIntent(missingCredentialId, NOW)).outcome).toBe('not_eligible');

    const created = await createD1TicketCredentials(db).ensureForOrder(missingCredentialId);
    expect(created).toBe(2);
    expect((await service.ensureConfirmationIntent(missingCredentialId, NOW)).outcome).toBe('created');
  });

  it('freezes the payload at creation: later event and venue edits change nothing', async () => {
    const orderId = await fulfilledOrder(2);
    const { id, service } = await intentFor(orderId);
    const before = (await service.getDelivery(id))!;

    const originalTitle = await db
      .prepare('select title from events where id = ?1')
      .bind(EVENT)
      .first<{ title: string }>();
    await db
      .prepare("update events set title = 'Edited After Freeze' where id = ?1")
      .bind(EVENT)
      .run();
    await db
      .prepare("update venues set name = 'Edited Venue' where id = 'ven_lomax'")
      .run();

    const after = (await service.getDelivery(id))!;
    expect(after.payload).toBe(before.payload);
    expect(after.payloadHash).toBe(before.payloadHash);
    const payload = JSON.parse(after.payload) as TicketConfirmationPayload;
    expect(payload.event.title).toBe(originalTitle!.title);
    expect(payload.venue.name).toBe('The Lomax Rooms');
    expect(after.payloadHash).toBe(await payloadHash(after.payload));

    // Re-ensuring is a no-op: the intent exists, so the edited world does not
    // mint a second or different one.
    const again = await service.ensureConfirmationIntent(orderId, new Date(NOW.getTime() + 60_000));
    expect(again.outcome).toBe('exists');
    expect((await service.getDelivery(again.deliveryId!))!.payload).toBe(before.payload);

    // The database enforces the same rule: identity and payload are immutable
    // and outbox rows are never deleted.
    await expect(
      db.prepare('update email_deliveries set payload = ?1 where id = ?2').bind('{}', id).run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.prepare("update email_deliveries set recipient = 'other@example.invalid' where id = ?1").bind(id).run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.prepare('delete from email_deliveries where id = ?1').bind(id).run(),
    ).rejects.toThrow(/durable/);

    // Restore the diary for the rest of the suite.
    await db
      .prepare('update events set title = ?2 where id = ?1')
      .bind(EVENT, originalTitle!.title)
      .run();
    await db
      .prepare("update venues set name = 'The Lomax Rooms' where id = 'ven_lomax'")
      .run();
  });

  it('allows exactly one owner in a claim race', async () => {
    const orderId = await fulfilledOrder(1);
    const { id, service } = await intentFor(orderId);

    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        service.claim(id, { token: `race_token_${index}`, now: NOW }),
      ),
    );
    const winners = claims.filter((claim): claim is NonNullable<typeof claim> => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.state).toBe('claimed');
    expect(winners[0]!.attemptCount).toBe(1);

    // The live lease locks everyone else out at the same instant.
    expect(await service.claim(id, { token: 'race_late_token', now: NOW })).toBeNull();
  });

  it('recovers an abandoned lease safely and fences the stale writer', async () => {
    const orderId = await fulfilledOrder(1);
    const { id, service } = await intentFor(orderId);

    const first = await service.claim(id, { token: 'lease_owner_a', now: NOW, leaseMs: 60_000 });
    expect(first).not.toBeNull();

    // Just before expiry the lease still stands.
    const beforeExpiry = new Date(NOW.getTime() + 30_000);
    expect(await service.claim(id, { token: 'lease_early_b', now: beforeExpiry })).toBeNull();

    // After expiry the delivery is recoverable, and the second owner gets it.
    const afterExpiry = new Date(NOW.getTime() + 120_000);
    const second = await service.claim(id, { token: 'lease_owner_b', now: afterExpiry, leaseMs: 60_000 });
    expect(second).not.toBeNull();
    expect(second!.claimToken).toBe('lease_owner_b');
    expect(second!.attemptCount).toBe(2);

    // The abandoned owner's late result is a no-op, not a corrupted state.
    expect(
      await service.recordResult(
        id,
        'lease_owner_a',
        { class: 'accepted', providerMessageId: 'stale_message' },
        { now: afterExpiry, providerName: 'test-provider' },
      ),
    ).toBe(false);
    expect((await service.getDelivery(id))!.state).toBe('claimed');

    // The current owner's result lands.
    expect(
      await service.recordResult(
        id,
        'lease_owner_b',
        { class: 'accepted', providerMessageId: 'pm_lease_b' },
        { now: afterExpiry, providerName: 'test-provider' },
      ),
    ).toBe(true);
    const settled = (await service.getDelivery(id))!;
    expect(settled.state).toBe('accepted');
    expect(settled.provider).toBe('test-provider');
    expect(settled.providerMessageId).toBe('pm_lease_b');
    expect(settled.acceptedAt).toBe(afterExpiry.toISOString());
    expect(settled.claimToken).toBeNull();
  });

  it('requeues abandoned leases as retryable and never churns them again', async () => {
    const orderId = await fulfilledOrder(1);
    const { id, service } = await intentFor(orderId);

    await service.claim(id, { token: 'requeue_owner', now: NOW, leaseMs: 60_000 });
    const later = new Date(NOW.getTime() + 90_000);
    expect(await service.requeueAbandonedLeases(later)).toBeGreaterThanOrEqual(1);

    const requeued = (await service.getDelivery(id))!;
    expect(requeued.state).toBe('retryable');
    expect(requeued.lastErrorClass).toBe('lease_expired');
    expect(requeued.nextRetryAt).toBe(later.toISOString());

    // Already requeued: a second pass finds nothing to recover.
    expect(await service.requeueAbandonedLeases(later)).toBe(0);
  });

  it('schedules retries with backoff instead of hammering every five minutes', async () => {
    const orderId = await fulfilledOrder(1);
    const { id, service } = await intentFor(orderId);

    await service.claim(id, { token: 'backoff_owner', now: NOW });
    expect(
      await service.recordResult(
        id,
        'backoff_owner',
        { class: 'retryable', errorCode: 'rate_limited' },
        { now: NOW, providerName: 'test-provider' },
      ),
    ).toBe(true);

    const retryable = (await service.getDelivery(id))!;
    expect(retryable.state).toBe('retryable');
    expect(retryable.lastErrorClass).toBe('retryable');
    expect(retryable.lastErrorCode).toBe('rate_limited');
    expect(retryable.nextRetryAt).toBe(new Date(NOW.getTime() + retryDelayMs(1)).toISOString());
    expect(retryDelayMs(1)).toBe(EMAIL_RETRY_BASE_MS);

    // Not due one minute later; due once the backoff elapses.
    expect(await service.listDueIds(new Date(NOW.getTime() + 60_000))).not.toContain(id);
    expect(await service.listDueIds(new Date(NOW.getTime() + EMAIL_RETRY_BASE_MS))).toContain(id);
  });

  it('performs zero external sends and zero attempts when no transport is configured', async () => {
    const orderId = await fulfilledOrder(1);
    const { id, service } = await intentFor(orderId);
    const before = (await service.getDelivery(id))!;

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const pass = createEmailDeliveryPass({ deliveries: service, tokens: () => tokens, transport: null });
    const first = await pass.run(NOW);
    const second = await pass.run(new Date(NOW.getTime() + 5 * 60_000));
    fetchSpy.mockRestore();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(first.transport, 'no transport may be configured in 08C1').toBeNull();
    expect(first.attempted).toBe(0);
    expect(first.accepted).toBe(0);
    expect(first.identified).toBeGreaterThanOrEqual(1);
    expect(second.attempted).toBe(0);

    // The unsendable row is identified, never churned: no attempt count, no
    // last-attempt timestamp, no state change.
    const after = (await service.getDelivery(id))!;
    expect(after.state).toBe(before.state);
    expect(after.attemptCount).toBe(0);
    expect(after.lastAttemptAt).toBeNull();
    expect(after.updatedAt).toBe(before.updatedAt);

    // Email never determines payment state.
    const order = await db
      .prepare('select status, tickets_fulfilled_at from orders where id = ?1')
      .bind(orderId)
      .first<{ status: string; tickets_fulfilled_at: string | null }>();
    expect(order?.status).toBe('paid');
    expect(order?.tickets_fulfilled_at).not.toBeNull();
  });

  it('delivers through an injected transport when one is configured, recording the result class', async () => {
    const orderId = await fulfilledOrder(1);
    const { id, service } = await intentFor(orderId);

    const sent: OutboundEmail[] = [];
    const transport = {
      name: 'test-provider',
      async send(message: OutboundEmail) {
        sent.push(message);
        // Like a real provider: one unique message id per accepted message.
        return {
          class: 'accepted' as const,
          providerMessageId: `pm_${message.idempotencyKey.split(':').pop()}`,
        };
      },
    };
    const pass = createEmailDeliveryPass({ deliveries: service, tokens: () => tokens, transport });
    const summary = await pass.run(NOW);

    expect(summary.transport).toBe('test-provider');
    expect(summary.attempted).toBeGreaterThanOrEqual(1);
    expect(summary.accepted).toBe(summary.attempted);

    const row = (await service.getDelivery(id))!;
    expect(row.state).toBe('accepted');
    expect(row.provider).toBe('test-provider');
    expect(row.providerMessageId).toBe(`pm_${orderId}`);
    expect(row.acceptedAt).toBe(NOW.toISOString());

    // The message handed over is the frozen rendering for this intent.
    const ours = sent.find(
      (message) => message.idempotencyKey === ticketConfirmationIdempotencyKey(orderId),
    );
    expect(ours).toBeDefined();
    expect(ours!.subject).toContain('The Glass Hearts');
    expect(ours!.attachments.length).toBeGreaterThanOrEqual(1);
    expect(ours!.to).toMatch(/@example\.invalid$/);
  });

  it('keeps the accepted scheduler order: credentials before intents, delivery last', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const scheduled = readFileSync(join(root, 'src', 'worker', 'scheduled.ts'), 'utf8');
    const credentials = scheduled.indexOf('getTicketCredentials().recoverMissing()');
    const email = scheduled.indexOf('getEmailDeliveryPass().run(now)');
    expect(credentials).toBeGreaterThan(-1);
    expect(email).toBeGreaterThan(credentials);

    const emailsOff = readFileSync(join(root, 'src', 'pages', 'admin', 'emails.astro'), 'utf8');
    expect(emailsOff).toContain('getEmailDeliveries');
  });
});
