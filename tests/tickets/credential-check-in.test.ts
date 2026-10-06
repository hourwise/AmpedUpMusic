import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openEphemeralDatabase } from '../../src/db/local.ts';
import { migrate } from '../../src/db/migrations.ts';
import { applySeed } from '../../src/db/seed.ts';
import { createD1OrderMutations } from '../../src/services/orders/service.ts';
import { createMockPaymentProvider } from '../../src/services/payments/mock.ts';
import { createD1TicketIssuance } from '../../src/services/tickets/issuance.ts';
import { createD1TicketCredentials } from '../../src/services/tickets/credentials.ts';
import { createD1TicketCheckIn, admissionOrderPolicy } from '../../src/services/tickets/check-in.ts';
import { createTicketTokenService, newCredentialId } from '../../src/services/tickets/token.ts';
import { renderTicketQrSvg } from '../../src/services/tickets/qr.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NOW = new Date('2026-09-23T20:00:00.000Z');
const EVENT = 'evt_glass_hearts_nov';
const TYPE = 'tt_gh_ga';
const secret = newCredentialId(); // Ephemeral, never a staging or fixture secret.
const tokens = createTicketTokenService(secret);

describe('AMPED-08B signed admission credentials', () => {
  let ephemeral: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let serial = 0;

  beforeAll(async () => {
    ephemeral = await openEphemeralDatabase();
    db = ephemeral.db;
    await migrate(db);
    await applySeed(db);
  });
  afterAll(async () => ephemeral.dispose());

  async function paidTicket() {
    const orders = createD1OrderMutations(db, () => NOW, (prefix) => `${prefix}_08b_${++serial}`);
    const created = await orders.createOrder({
      eventId: EVENT, items: [{ ticketTypeId: TYPE, quantity: 1 }],
      customerName: '08B Buyer', customerEmail: `08b-${++serial}@example.invalid`, marketingOptIn: false,
    });
    const provider = createMockPaymentProvider({ now: () => NOW, newId: () => `08b_${++serial}` });
    const checkout = await orders.beginPayment(created.orderId, provider, 'https://amped.test/checkout/return');
    await orders.confirmPayment(created.orderId, checkout.checkoutId, provider);
    await createD1TicketIssuance(db, () => NOW).issuePaidOrder(created.orderId);
    const row = await db.prepare('select id, credential_id from tickets where order_id = ?1')
      .bind(created.orderId).first<{ id: string; credential_id: string }>();
    return { orderId: created.orderId, ticketId: row!.id, credentialId: row!.credential_id,
      token: await tokens.sign(row!.credential_id) };
  }

  async function evidence(ticketId: string) {
    const ticket = await db.prepare('select status, checked_in_at, credential_id from tickets where id = ?1')
      .bind(ticketId).first<{ status: string; checked_in_at: string | null; credential_id: string }>();
    const checkins = await db.prepare('select count(*) as n from checkins where ticket_id = ?1')
      .bind(ticketId).first<{ n: number }>();
    const audits = await db.prepare("select count(*) as n from audit_log where entity_type = 'ticket' and entity_id = ?1 and action = 'ticket.checked_in'")
      .bind(ticketId).first<{ n: number }>();
    return { ticket, checkins: checkins?.n ?? 0, audits: audits?.n ?? 0 };
  }

  it('rejects missing/weak secrets and verifies only the signing environment', async () => {
    expect(() => createTicketTokenService(undefined)).toThrow(/TICKET_TOKEN_SECRET/);
    expect(() => createTicketTokenService('weak')).toThrow(/TICKET_TOKEN_SECRET/);
    const id = newCredentialId();
    const token = await tokens.sign(id);
    expect(await tokens.verify(token)).toEqual({ outcome: 'valid', credentialId: id });
    expect((await createTicketTokenService(newCredentialId()).verify(token)).outcome).toBe('invalid_signature');
  });

  it('rejects tampering, version changes, bad encoding, and cross-ticket signature swaps', async () => {
    const a = await tokens.sign(newCredentialId());
    const b = await tokens.sign(newCredentialId());
    const [version, id, mac] = a.split('.');
    const [, otherId] = b.split('.');
    expect((await tokens.verify(`AUP2.${id}.${mac}`)).outcome).toBe('unsupported_version');
    expect((await tokens.verify(`${version}.${otherId}.${mac}`)).outcome).toBe('invalid_signature');
    expect((await tokens.verify(`${version}.${id}.${mac![0] === 'A' ? 'B' : 'A'}${mac!.slice(1)}`)).outcome).toBe('invalid_signature');
    for (const bad of ['', `${version}.${id}`, `${version}..${mac}`, `${version}.${id}.${mac}.x`, `${version}.!${id!.slice(1)}.${mac}`]) {
      expect((await tokens.verify(bad)).outcome).toBe('malformed');
    }
    expect(a).not.toContain('08B Buyer');
    expect(a).not.toContain('@example.invalid');
    expect(a).not.toContain('AMP-');
    expect(renderTicketQrSvg(a)).toContain('<svg');
    expect(renderTicketQrSvg(a)).toBe(renderTicketQrSvg(a));
  });

  it('gives an existing 08A ticket one credential under 20 concurrent attempts', async () => {
    const row = await db.prepare(`select t.id from tickets t join orders o on o.id = t.order_id
      where o.status = 'paid' and t.status = 'issued' and t.credential_id is null limit 1`)
      .first<{ id: string }>();
    const service = createD1TicketCredentials(db);
    const ids = await Promise.all(Array.from({ length: 20 }, () => service.ensureTicketCredential(row!.id)));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await db.prepare('select count(*) as n from tickets where id = ?1').bind(row!.id).first<{ n: number }>())?.n).toBe(1);
    expect(await service.ensureTicketCredential(row!.id)).toBe(ids[0]);
  });

  it('recovers older paid tickets through the bounded missing-credential index', async () => {
    const plan = await db.prepare(`explain query plan select t.id from tickets t indexed by tickets_missing_credential_idx
      join orders o on o.id = t.order_id where t.credential_id is null
        and t.status in ('issued', 'checked_in') and o.status = 'paid'
      order by t.issued_at, t.id limit ?1`).bind(25).all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes('tickets_missing_credential_idx'))).toBe(true);
    const service = createD1TicketCredentials(db);
    const first = await service.recoverMissing(1);
    expect(first).toEqual({ examined: 1, created: 1, failures: 0 });
    const second = await service.recoverMissing(1);
    expect(second).toEqual({ examined: 1, created: 1, failures: 0 });
  });

  it('credentials new issuance immediately and check-in is exactly once under 20 scans', async () => {
    const issued = await paidTicket();
    expect(issued.credentialId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const scanner = createD1TicketCheckIn(db, tokens, () => NOW);
    const results = await Promise.all(Array.from({ length: 20 }, () => scanner.scan(issued.token, EVENT, 'door@example.invalid')));
    expect(results.filter((result) => result.outcome === 'admitted')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'already_checked_in')).toHaveLength(19);
    const proof = await evidence(issued.ticketId);
    expect(proof.ticket?.status).toBe('checked_in');
    expect(proof.ticket?.checked_in_at).toBe(NOW.toISOString());
    expect(proof.checkins).toBe(1);
    expect(proof.audits).toBe(1);
    expect((await scanner.scan(issued.token, EVENT, 'second@example.invalid')).outcome).toBe('already_checked_in');
    expect((await evidence(issued.ticketId)).ticket?.checked_in_at).toBe(NOW.toISOString());
  });

  it('rejects wrong-event and unknown signed credentials without mutation', async () => {
    const issued = await paidTicket();
    const scanner = createD1TicketCheckIn(db, tokens, () => NOW);
    expect((await scanner.scan(issued.token, 'evt_not_this_show', 'door@example.invalid')).outcome).toBe('wrong_event');
    expect((await scanner.scan(await tokens.sign(newCredentialId()), EVENT, 'door@example.invalid')).outcome).toBe('invalid_ticket');
    expect((await scanner.scan(issued.token.replace('AUP1', 'AUP2'), EVENT, 'door@example.invalid')).outcome).toBe('invalid_ticket');
    expect((await evidence(issued.ticketId)).checkins).toBe(0);
    expect((await evidence(issued.ticketId)).audits).toBe(0);
  });

  it('rejects a cancelled event even when the order remains paid', async () => {
    const issued = await paidTicket();
    const before = await db.prepare('select status, status_message from events where id = ?1').bind(EVENT)
      .first<{ status: string; status_message: string | null }>();
    try {
      await db.prepare("update events set status = 'cancelled', status_message = 'Cancelled for this test' where id = ?1").bind(EVENT).run();
      expect((await createD1TicketCheckIn(db, tokens, () => NOW).scan(issued.token, EVENT, 'door@example.invalid')).outcome)
        .toBe('not_eligible');
      expect((await evidence(issued.ticketId)).checkins).toBe(0);
    } finally {
      await db.prepare('update events set status = ?1, status_message = ?2 where id = ?3')
        .bind(before!.status, before!.status_message, EVENT).run();
    }
  });

  it('requires manual review for partial refund, including concurrent scans, without changing the credential', async () => {
    const issued = await paidTicket();
    await db.prepare("update orders set status = 'partially_refunded' where id = ?1").bind(issued.orderId).run();
    const scanner = createD1TicketCheckIn(db, tokens, () => NOW);
    const results = await Promise.all(Array.from({ length: 20 }, () => scanner.scan(issued.token, EVENT, 'door@example.invalid')));
    expect(results.every((result) => result.outcome === 'manual_review_required')).toBe(true);
    expect((await scanner.scan(issued.token, EVENT, 'door@example.invalid')).outcome).toBe('manual_review_required');
    const before = await evidence(issued.ticketId);
    expect(before).toMatchObject({ ticket: { status: 'issued', checked_in_at: null, credential_id: issued.credentialId }, checkins: 0, audits: 0 });
    await db.prepare("update orders set status = 'paid' where id = ?1").bind(issued.orderId).run();
    expect((await scanner.scan(issued.token, EVENT, 'door@example.invalid')).outcome).toBe('admitted');
    expect((await evidence(issued.ticketId)).ticket?.credential_id).toBe(issued.credentialId);
  });

  it('fails closed for refunded and every other non-paid or future order state', async () => {
    const scanner = createD1TicketCheckIn(db, tokens, () => NOW);
    for (const status of ['refunded', 'cancelled', 'expired', 'pending', 'awaiting_payment']) {
      const issued = await paidTicket();
      await db.prepare('update orders set status = ?1 where id = ?2').bind(status, issued.orderId).run();
      expect((await scanner.scan(issued.token, EVENT, 'door@example.invalid')).outcome).toBe('not_eligible');
      expect((await evidence(issued.ticketId)).checkins).toBe(0);
      expect((await evidence(issued.ticketId)).audits).toBe(0);
    }
    expect(admissionOrderPolicy('future_unknown')).toBe('not_eligible');
    expect(admissionOrderPolicy('paid')).toBe('eligible');
    expect(admissionOrderPolicy('partially_refunded')).toBe('manual_review_required');
  });
});
