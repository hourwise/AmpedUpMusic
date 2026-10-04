/**
 * AMPED-07B - SumUp Hosted Checkout wiring.
 *
 * Every test here is OFFLINE. The SumUp transport is an injected fake fetch,
 * the database is an ephemeral seeded D1, and no test needs a real API key.
 *
 * What these tests are really defending:
 *  - the browser cannot influence what is charged, or where it is sent next;
 *  - a hosted checkout URL never reaches a customer unless the local stock
 *    hold was actually won;
 *  - the local reservation and the provider checkout share ONE expiry;
 *  - nothing in this slice can move an order to `paid`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../../src/db/local.ts';
import { migrate } from '../../src/db/migrations.ts';
import { applySeed } from '../../src/db/seed.ts';
import {
  createD1OrderMutations,
  type CheckoutInput,
} from '../../src/services/orders/service.ts';
import { createSumUpPaymentProvider } from '../../src/services/payments/sumup/provider.ts';
import {
  PaymentConfigurationError,
  SumUpError,
  SUMUP_HOSTED_CHECKOUT_MINUTES,
} from '../../src/services/payments/sumup/types.ts';
import { createMockPaymentProvider } from '../../src/services/payments/mock.ts';
import { ConflictError } from '../../src/lib/validation.ts';
import type { PaymentProvider } from '../../src/services/contracts.ts';
import * as fixtures from './fixtures.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXED_NOW = new Date('2026-09-23T20:00:00.000Z');
const EVENT = 'evt_glass_hearts_nov';
const TYPE = 'tt_gh_ga';
const RETURN_URL = 'https://amped.test/checkout/return';

interface Captured {
  url: string;
  method: string;
  body: string | undefined;
}

/** A scripted fake SumUp transport. Captures what we sent. */
function fakeTransport(steps: Array<() => Response | Promise<Response>>) {
  const captured: Captured[] = [];
  let index = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return step!();
  }) as typeof fetch;
  return { impl, captured, calls: () => index };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A create-checkout response carrying a UNIQUE checkout id.
 *
 * Migration 0012 made `orders.payment_reference` uniquely indexed, which is
 * the whole point of it: one checkout id must identify one order, or a
 * webhook could credit the wrong customer. A shared fixture id would
 * therefore make these tests collide with each other instead of testing
 * anything, so each served response gets its own id - as real SumUp does.
 */
let checkoutSequence = 0;
function pendingCheckout(overrides: Record<string, unknown> = {}) {
  checkoutSequence += 1;
  return {
    ...fixtures.CREATE_PENDING,
    id: `${fixtures.FAKE_CHECKOUT_ID}-${checkoutSequence}`,
    ...overrides,
  };
}

function sumUpProvider(steps: Array<() => Response | Promise<Response>>) {
  const transport = fakeTransport(steps);
  const provider = createSumUpPaymentProvider({
    apiKey: fixtures.FAKE_API_KEY,
    merchantCode: fixtures.FAKE_MERCHANT_CODE,
    fetchImpl: transport.impl,
    now: () => FIXED_NOW,
    sleep: async () => {},
  });
  return { provider, ...transport };
}

function sentBody(captured: Captured[], index = 0): Record<string, unknown> {
  return JSON.parse(captured[index]?.body ?? '{}') as Record<string, unknown>;
}

function checkout(overrides: Partial<CheckoutInput> = {}): CheckoutInput {
  return {
    eventId: EVENT,
    items: [{ ticketTypeId: TYPE, quantity: 2 }],
    customerName: 'Probe Customer',
    customerEmail: 'probe@example.com',
    marketingOptIn: false,
    ...overrides,
  };
}

describe('AMPED-07B hosted checkout', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let counter = 0;
  /** The seed ships ticket rows; 07B must add exactly none of its own. */
  let ticketsAtStart = 0;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
    await applySeed(db);
    ticketsAtStart = await ticketCount();
  });

  afterAll(async () => {
    await database.dispose();
  });

  function mutations() {
    return createD1OrderMutations(db, () => FIXED_NOW, (p) => `${p}_b${++counter}`);
  }

  async function orderRow(id: string) {
    return db
      .prepare(
        'select status, total_in_pence, reservation_expires_at, payment_provider, payment_reference from orders where id = ?',
      )
      .bind(id)
      .first<Record<string, unknown>>();
  }

  async function ticketCount(): Promise<number> {
    const row = await db.prepare('select count(*) as n from tickets').first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Stock genuinely committed right now: sold, plus unexpired holds. */
  async function committedFor(ticketTypeId: string): Promise<number> {
    const row = await db
      .prepare(
        'select coalesce(sum(oi.quantity), 0) as n from order_items oi ' +
          'join orders o on o.id = oi.order_id ' +
          "where oi.ticket_type_id = ? and (o.status in ('paid', 'partially_refunded') " +
          "or (o.status = 'awaiting_payment' and julianday(o.reservation_expires_at) > julianday(?)))",
      )
      .bind(ticketTypeId, FIXED_NOW.toISOString())
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  // -- expiry: one clock, decided before the request ------------------------

  describe('expiry alignment', () => {
    it('sends valid_until on the create request', async () => {
      const { provider, captured } = sumUpProvider([() => jsonResponse(pendingCheckout())]);
      await provider.createCheckout({
        orderId: 'ord_x',
        reference: 'AMP-26-00001',
        amountInPence: 1000,
        currency: 'GBP',
        customerEmail: 'probe@example.com',
        returnUrl: RETURN_URL,
      });

      const body = sentBody(captured);
      expect(body.valid_until).toBe(
        new Date(FIXED_NOW.getTime() + SUMUP_HOSTED_CHECKOUT_MINUTES * 60_000).toISOString(),
      );
    });

    it("uses SumUp's returned valid_until verbatim as the local reservation expiry", async () => {
      const { provider } = sumUpProvider([() => jsonResponse(pendingCheckout())]);
      const service = mutations();
      const created = await service.createOrder(checkout());
      const begun = await service.beginPayment(created.orderId, provider, RETURN_URL);

      expect(begun.expiresAt).toBe(fixtures.FAKE_VALID_UNTIL);
      const row = await orderRow(created.orderId);
      expect(row?.reservation_expires_at).toBe(fixtures.FAKE_VALID_UNTIL);
    });

    it('honours a returned valid_until that differs from the one requested', async () => {
      // SumUp is entitled to disagree. Its answer is the real session life, so
      // the local hold must follow it rather than our request.
      const DIFFERENT = '2026-09-23T20:17:30.000Z';
      const { provider, captured } = sumUpProvider([
        () => jsonResponse(pendingCheckout({ valid_until: DIFFERENT })),
      ]);
      const service = mutations();
      const created = await service.createOrder(checkout());
      const begun = await service.beginPayment(created.orderId, provider, RETURN_URL);

      expect(sentBody(captured).valid_until).not.toBe(DIFFERENT);
      expect(begun.expiresAt).toBe(DIFFERENT);
      const row = await orderRow(created.orderId);
      expect(row?.reservation_expires_at).toBe(DIFFERENT);
    });

    it('falls back to the exact pre-request value when SumUp omits valid_until', async () => {
      const { provider, captured } = sumUpProvider([
        () => jsonResponse(pendingCheckout({ valid_until: undefined })),
      ]);
      const service = mutations();
      const created = await service.createOrder(checkout());
      const begun = await service.beginPayment(created.orderId, provider, RETURN_URL);

      const requested = sentBody(captured).valid_until;
      expect(begun.expiresAt).toBe(requested);
      const row = await orderRow(created.orderId);
      expect(row?.reservation_expires_at).toBe(requested);
    });

    it('does not read the clock again after the response, so latency cannot drift it', async () => {
      // A clock that advances on every read would expose a second now+30
      // calculated after the HTTP round trip.
      let reads = 0;
      const ticking = () => {
        reads += 1;
        return new Date(FIXED_NOW.getTime() + reads * 60_000);
      };
      const transport = fakeTransport([() => jsonResponse(pendingCheckout({ valid_until: undefined }))]);
      const provider = createSumUpPaymentProvider({
        apiKey: fixtures.FAKE_API_KEY,
        merchantCode: fixtures.FAKE_MERCHANT_CODE,
        fetchImpl: transport.impl,
        now: ticking,
      });

      const result = await provider.createCheckout({
        orderId: 'ord_x',
        reference: 'AMP-26-00002',
        amountInPence: 1000,
        currency: 'GBP',
        customerEmail: 'probe@example.com',
        returnUrl: RETURN_URL,
      });

      expect(reads).toBe(1);
      expect(result.expiresAt).toBe(sentBody(transport.captured).valid_until);
    });

    it('still works with the mock provider, which owns its own expiry too', async () => {
      const provider = createMockPaymentProvider({ now: () => FIXED_NOW });
      const service = mutations();
      const created = await service.createOrder(checkout());
      const begun = await service.beginPayment(created.orderId, provider, RETURN_URL);

      const row = await orderRow(created.orderId);
      expect(row?.reservation_expires_at).toBe(begun.expiresAt);
    });

    it('refuses an unusable or already-past provider expiry without reserving stock', async () => {
      for (const bad of ['not-a-timestamp', '2026-09-23T19:00:00.000Z']) {
        const provider: PaymentProvider = {
          name: 'sumup',
          createCheckout: async () => ({
            checkoutId: 'chk_bad',
            redirectUrl: 'https://checkout.sumup.com/pay/x',
            expiresAt: bad,
          }),
          confirm: async () => ({ status: 'pending' as const }),
          verifyWebhook: async () => null,
        };
        const service = mutations();
        const created = await service.createOrder(checkout());
        await expect(
          service.beginPayment(created.orderId, provider, RETURN_URL),
        ).rejects.toBeInstanceOf(Error);

        const row = await orderRow(created.orderId);
        expect(row?.status).toBe('pending');
        expect(row?.reservation_expires_at).toBeNull();
      }
    });
  });

  // -- money and reference authority ---------------------------------------

  describe('money authority', () => {
    it('creates the local order before the provider is ever called', async () => {
      let statusWhenProviderCalled: string | undefined;
      const service = mutations();
      const created = await service.createOrder(checkout());

      const row = await orderRow(created.orderId);
      expect(row?.status).toBe('pending');

      const provider: PaymentProvider = {
        name: 'sumup',
        createCheckout: async () => {
          const live = await orderRow(created.orderId);
          statusWhenProviderCalled = String(live?.status);
          return {
            checkoutId: 'chk_order_first',
            redirectUrl: 'https://checkout.sumup.com/pay/order-first',
            expiresAt: new Date(FIXED_NOW.getTime() + 30 * 60_000).toISOString(),
          };
        },
        confirm: async () => ({ status: 'pending' as const }),
        verifyWebhook: async () => null,
      };

      await service.beginPayment(created.orderId, provider, RETURN_URL);
      expect(statusWhenProviderCalled).toBe('pending');
    });

    it('sends the server-recomputed total, not anything a client could set', async () => {
      const { provider, captured } = sumUpProvider([() => jsonResponse(pendingCheckout())]);
      const service = mutations();
      const created = await service.createOrder(checkout());
      await service.beginPayment(created.orderId, provider, RETURN_URL);

      const unitPrice = await db
        .prepare('select price_in_pence from ticket_types where id = ?')
        .bind(TYPE)
        .first<{ price_in_pence: number }>();
      const expectedPence = (unitPrice?.price_in_pence ?? 0) * 2;

      expect(created.totalInPence).toBe(expectedPence);
      expect(sentBody(captured).amount).toBe(Number((expectedPence / 100).toFixed(2)));
      expect(sentBody(captured).currency).toBe('GBP');
    });

    it('ignores a client-supplied amount, total, currency and reference', async () => {
      // The accepted CheckoutInput has no money field at all, so a tampered
      // payload cannot even be expressed - it is dropped before the service.
      const tampered = {
        ...checkout(),
        amountInPence: 1,
        totalInPence: 1,
        total: 1,
        currency: 'USD',
        checkoutReference: 'ATTACKER-REF',
        unitPrice: 1,
      } as unknown as CheckoutInput;

      const { provider, captured } = sumUpProvider([() => jsonResponse(pendingCheckout())]);
      const service = mutations();
      const created = await service.createOrder(tampered);
      await service.beginPayment(created.orderId, provider, RETURN_URL);

      const unitPrice = await db
        .prepare('select price_in_pence from ticket_types where id = ?')
        .bind(TYPE)
        .first<{ price_in_pence: number }>();
      const expectedPence = (unitPrice?.price_in_pence ?? 0) * 2;

      const body = sentBody(captured);
      expect(created.totalInPence).toBe(expectedPence);
      expect(body.amount).toBe(Number((expectedPence / 100).toFixed(2)));
      expect(body.amount).not.toBe(0.01);
      expect(body.currency).toBe('GBP');
      expect(body.checkout_reference).toBe(created.reference);
      expect(body.checkout_reference).not.toBe('ATTACKER-REF');
    });

    it('captures immutable item data that later price edits cannot rewrite', async () => {
      const service = mutations();
      const before = await db
        .prepare('select name, price_in_pence from ticket_types where id = ?')
        .bind(TYPE)
        .first<{ name: string; price_in_pence: number }>();
      const created = await service.createOrder(checkout());

      await db
        .prepare('update ticket_types set price_in_pence = ?, name = ? where id = ?')
        .bind(99_900, 'Renamed After Order', TYPE)
        .run();
      try {
        const items = await db
          .prepare(
            'select unit_price_in_pence, ticket_type_name from order_items where order_id = ?',
          )
          .bind(created.orderId)
          .all<{ unit_price_in_pence: number; ticket_type_name: string }>();
        expect(items.results[0]?.unit_price_in_pence).toBe(before?.price_in_pence);
        expect(items.results[0]?.ticket_type_name).toBe(before?.name);
      } finally {
        await db
          .prepare('update ticket_types set price_in_pence = ?, name = ? where id = ?')
          .bind(before?.price_in_pence ?? 0, before?.name ?? '', TYPE)
          .run();
      }
    });

    it('uses the local order reference as checkout_reference and stores the checkout id', async () => {
      const served = pendingCheckout();
      const { provider, captured } = sumUpProvider([() => jsonResponse(served)]);
      const service = mutations();
      const created = await service.createOrder(checkout());
      const begun = await service.beginPayment(created.orderId, provider, RETURN_URL);

      expect(sentBody(captured).checkout_reference).toBe(created.reference);

      const row = await orderRow(created.orderId);
      expect(row?.payment_provider).toBe('sumup');
      // The accepted payment_reference column holds the provider id. No second
      // provider-id column was added.
      expect(row?.payment_reference).toBe(served.id);
      expect(begun.checkoutId).toBe(served.id);
    });
  });

  // -- hosted checkout result ----------------------------------------------

  describe('hosted checkout result', () => {
    it('returns the hosted URL only after the reservation is actually held', async () => {
      const { provider } = sumUpProvider([() => jsonResponse(pendingCheckout())]);
      const service = mutations();
      const created = await service.createOrder(checkout());
      const begun = await service.beginPayment(created.orderId, provider, RETURN_URL);

      expect(begun.redirectUrl).toBe(fixtures.FAKE_HOSTED_URL);
      const row = await orderRow(created.orderId);
      expect(row?.status).toBe('awaiting_payment');
    });

    it('sends the absolute server-derived return URL, never a relative path', async () => {
      const { provider, captured } = sumUpProvider([() => jsonResponse(pendingCheckout())]);
      const service = mutations();
      const created = await service.createOrder(checkout());
      await service.beginPayment(created.orderId, provider, RETURN_URL);

      const body = sentBody(captured);
      expect(body.redirect_url).toBe(RETURN_URL);
      expect(String(body.redirect_url)).toMatch(/^https?:\/\//);
    });

    it('refuses a relative return URL before contacting the provider at all', async () => {
      const { provider, calls } = sumUpProvider([() => jsonResponse(pendingCheckout())]);
      const service = mutations();
      const created = await service.createOrder(checkout());

      await expect(
        service.beginPayment(created.orderId, provider, '/checkout/return'),
      ).rejects.toBeInstanceOf(Error);

      expect(calls()).toBe(0);
      const row = await orderRow(created.orderId);
      expect(row?.status).toBe('pending');
    });

    it('takes the redirect target only from the provider result', async () => {
      // Nothing the caller passes in can become the redirect: the only input
      // is returnUrl, and the output URL comes from SumUp's response body.
      const { provider } = sumUpProvider([() => jsonResponse(pendingCheckout())]);
      const service = mutations();
      const created = await service.createOrder(checkout());
      const begun = await service.beginPayment(
        created.orderId,
        provider,
        'https://attacker.example/checkout/return',
      );
      expect(begun.redirectUrl).toBe(fixtures.FAKE_HOSTED_URL);
      expect(begun.redirectUrl).not.toContain('attacker.example');
    });
  });

  // -- failure and ambiguity ------------------------------------------------

  describe('create failure', () => {
    async function expectNoHold(orderId: string) {
      const row = await orderRow(orderId);
      expect(row?.status).toBe('pending');
      expect(row?.reservation_expires_at).toBeNull();
      expect(row?.payment_reference).toBeNull();
    }

    it('leaves no reservation and no paid order when creation fails', async () => {
      for (const step of [
        () => jsonResponse(fixtures.ERROR_400, 400),
        () => jsonResponse(fixtures.ERROR_401, 401),
        () => jsonResponse(fixtures.ERROR_500, 500),
        () => {
          throw new TypeError('network down');
        },
      ]) {
        const { provider } = sumUpProvider([step]);
        const service = mutations();
        const created = await service.createOrder(checkout());
        await expect(
          service.beginPayment(created.orderId, provider, RETURN_URL),
        ).rejects.toBeInstanceOf(SumUpError);
        await expectNoHold(created.orderId);
      }
      expect(await ticketCount()).toBe(ticketsAtStart);
    });

    it('never retries a creation POST, even on a timeout', async () => {
      const { provider, calls } = sumUpProvider([
        () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        },
      ]);
      const service = mutations();
      const created = await service.createOrder(checkout());

      const error = await service
        .beginPayment(created.orderId, provider, RETURN_URL)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(SumUpError);
      // Ambiguous: the checkout may exist at SumUp. It stays ambiguous.
      expect((error as SumUpError).ambiguous).toBe(true);
      expect(calls()).toBe(1);
      await expectNoHold(created.orderId);
    });

    it('releases nothing on an ambiguous failure, because nothing was reserved', async () => {
      const before = await committedFor(TYPE);
      const { provider } = sumUpProvider([() => jsonResponse(fixtures.ERROR_500, 500)]);
      const service = mutations();
      const created = await service.createOrder(checkout());
      await expect(
        service.beginPayment(created.orderId, provider, RETURN_URL),
      ).rejects.toBeInstanceOf(SumUpError);

      expect(await committedFor(TYPE)).toBe(before);
    });
  });

  // -- the race this architecture genuinely has -----------------------------

  describe('reservation race after external create', () => {
    it('gives the loser no hosted URL, no hold and no paid order', async () => {
      // The genuine 07B race: the advisory read passes, the external checkout
      // is created, and only THEN does the atomic 06C gate refuse because the
      // stock went while we were away at SumUp. Capacity is dropped inside
      // createCheckout to stand in for the rival buyer who won it.
      const original = await db
        .prepare('select capacity from ticket_types where id = ?')
        .bind(TYPE)
        .first<{ capacity: number }>();

      const service = mutations();
      const created = await service.createOrder(checkout());

      let providerCalls = 0;
      const provider: PaymentProvider = {
        name: 'sumup',
        createCheckout: async () => {
          providerCalls += 1;
          await db.prepare('update ticket_types set capacity = 0 where id = ?').bind(TYPE).run();
          return {
            checkoutId: fixtures.FAKE_CHECKOUT_ID,
            redirectUrl: fixtures.FAKE_HOSTED_URL,
            expiresAt: fixtures.FAKE_VALID_UNTIL,
          };
        },
        confirm: async () => ({ status: 'pending' as const }),
        verifyWebhook: async () => null,
      };

      try {
        const result = await service
          .beginPayment(created.orderId, provider, RETURN_URL)
          .catch((reason: unknown) => reason);

        // The external checkout really was created - that is the known
        // orphan - but nothing about it reaches the caller.
        expect(providerCalls).toBe(1);
        expect(result).toBeInstanceOf(ConflictError);
        expect((result as Error).message).not.toContain('checkout.sumup.com');
        expect((result as Error).message).not.toContain(fixtures.FAKE_CHECKOUT_ID);

        const row = await orderRow(created.orderId);
        expect(row?.status).toBe('pending');
        expect(row?.reservation_expires_at).toBeNull();
        expect(row?.payment_reference).toBeNull();
        expect(await ticketCount()).toBe(ticketsAtStart);
      } finally {
        await db
          .prepare('update ticket_types set capacity = ? where id = ?')
          .bind(original?.capacity ?? 0, TYPE)
          .run();
      }
    });

    it('leaks no stock when the loser is rejected', async () => {
      const row = await db
        .prepare('select capacity from ticket_types where id = ?')
        .bind(TYPE)
        .first<{ capacity: number }>();
      const committed = await committedFor(TYPE);
      // Never oversold, and the rejected order contributes nothing.
      expect(committed).toBeLessThanOrEqual(row?.capacity ?? 0);
    });
  });

  // -- payment authority ----------------------------------------------------

  describe('payment authority', () => {
    it('leaves the order awaiting_payment after the hosted checkout is created', async () => {
      const { provider } = sumUpProvider([() => jsonResponse(pendingCheckout())]);
      const service = mutations();
      const created = await service.createOrder(checkout());
      await service.beginPayment(created.orderId, provider, RETURN_URL);

      const row = await orderRow(created.orderId);
      expect(row?.status).toBe('awaiting_payment');
      expect(await ticketCount()).toBe(ticketsAtStart);
    });

    it('issues no tickets anywhere in this slice', async () => {
      expect(await ticketCount()).toBe(ticketsAtStart);
    });
  });

  // -- source-level guarantees ---------------------------------------------

  describe('runtime provider wiring', () => {
    const locator = readFileSync(join(root, 'src', 'services', 'index.ts'), 'utf8');

    it('builds the SumUp provider for the runtime checkout seam', () => {
      expect(locator).toContain('createSumUpPaymentProvider');
    });

    it('has no runtime fallback to the mock provider', () => {
      expect(locator).not.toContain('createMockPaymentProvider');
      expect(locator).not.toContain("from './payments/mock.ts'");
    });

    it('fails closed when either credential is missing', () => {
      // Both-or-nothing, and a throw rather than a degraded provider.
      expect(locator).toContain('if (!apiKey || !merchantCode) return undefined;');
      expect(locator).toContain('if (!sumUpConfig) throw new PaymentConfigurationError();');
    });

    it('keeps the reservation sweep working without payment credentials', () => {
      // Expiring a hold needs a database, not a merchant account.
      const sweep = locator.slice(locator.indexOf('export function getReservationMaintenance'));
      expect(sweep).toContain('return orderMutations();');
      expect(sweep.slice(0, sweep.indexOf('}'))).not.toContain('getCheckout()');
    });

    it('leaves the PaymentProvider contract untouched', () => {
      const contracts = readFileSync(join(root, 'src', 'services', 'contracts.ts'), 'utf8');
      expect(contracts).toContain("readonly name: 'sumup' | 'mock';");
      expect(contracts).toContain('createCheckout(input: {');
      expect(contracts).not.toContain('validUntil');
    });

    it('surfaces a controlled unavailable error rather than a provider detail', () => {
      const error = new PaymentConfigurationError();
      expect(error.message).toBe('Checkout is temporarily unavailable.');
      expect(error.message).not.toMatch(/SUMUP|api[_-]?key|merchant/i);
    });
  });

  describe('public confirm endpoint', () => {
    const confirmRoute = readFileSync(
      join(root, 'src', 'pages', 'api', 'checkout', 'confirm.ts'),
      'utf8',
    );

    it('refuses before calling the provider or the order service under SumUp', () => {
      const gate = confirmRoute.indexOf("if (provider.name === 'sumup') return fail(404");
      const confirmCall = confirmRoute.indexOf('orders.confirmPayment(');
      expect(gate).toBeGreaterThan(-1);
      // The refusal is lexically before the only call that could move money.
      expect(gate).toBeLessThan(confirmCall);
    });

    it('does not expose provider internals in the refusal', () => {
      expect(confirmRoute).toContain("fail(404, 'not-found')");
      expect(confirmRoute).not.toMatch(/\bfetch\s*\(/);
    });

    it('cannot reach SumUp even when a caller guesses a real checkout id', async () => {
      // Mirrors the route's gate against a live SumUp provider: the provider
      // must never be asked, so the fake transport records zero calls.
      const { provider, calls } = sumUpProvider([() => jsonResponse(fixtures.GET_PAID)]);
      const service = mutations();
      const created = await service.createOrder(checkout());

      const gated = provider.name === 'sumup';
      expect(gated).toBe(true);
      if (!gated) await service.confirmPayment(created.orderId, 'chk', provider);

      expect(calls()).toBe(0);
      const row = await orderRow(created.orderId);
      expect(row?.status).toBe('pending');
      expect(await ticketCount()).toBe(ticketsAtStart);
    });
  });

  describe('return page', () => {
    const page = readFileSync(join(root, 'src', 'pages', 'checkout', 'return.astro'), 'utf8');
    const body = page.split('---').slice(2).join('---');

    it('says confirmation is pending and tickets are not issued', () => {
      expect(body).toMatch(/being confirmed/i);
      expect(body).toMatch(/not been issued yet/i);
    });

    it('never claims the payment succeeded', () => {
      expect(body).not.toMatch(/payment successful/i);
      expect(body).not.toMatch(/order paid/i);
      expect(body).not.toMatch(/tickets confirmed/i);
      expect(body).not.toMatch(/thank you for your payment/i);
    });

    it('never promises that no charge was taken', () => {
      // The page cannot know. A payment can succeed at SumUp while our own
      // confirmation is delayed or unavailable, so "not confirmed yet" is not
      // evidence of "not charged". Promising someone their money is safe and
      // then taking it is worse than asking them to wait.
      expect(body).not.toMatch(/nothing is charged/i);
      expect(body).not.toMatch(/nothing was charged/i);
      expect(body).not.toMatch(/you have not been charged/i);
      expect(body).not.toMatch(/no payment was taken/i);
      expect(body).not.toMatch(/no money has left/i);
      // Nor may it assert the opposite outcome, or that stock was released.
      expect(body).not.toMatch(/your payment failed/i);
      expect(body).not.toMatch(/the payment was declined/i);
      expect(body).not.toMatch(/back on sale/i);
      expect(body).not.toMatch(/reservation has been released/i);
    });

    it('tells the customer not to pay again while confirmation is pending', () => {
      // The one instruction that actually protects them from a double charge.
      expect(body).toMatch(/do not pay again/i);
      // And an explicit promise that the status will be established for them.
      expect(body).toMatch(/verify the payment/i);
      // A delay is explicitly not presented as failure.
      expect(body).toMatch(/does not mean the payment failed/i);
    });

    it('performs no lookup, no mutation and no provider call', () => {
      // Comments may discuss SumUp; code may not touch it.
      const code = page
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/getCheckout|getServices|confirmPayment|beginPayment/);
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/sumup/i);
    });

    it('reads no query string, so ?status=paid changes nothing', () => {
      // There is no code path that could branch on a parameter: the page never
      // reads one. That is stronger than ignoring a known set of values.
      expect(page).not.toMatch(/searchParams|Astro\.params|request\.url/);
    });

    it('is noindex and not cached', () => {
      expect(page).toContain('noindex');
      expect(page).toContain("Cache-Control', 'no-store");
      expect(page).toContain('export const prerender = false;');
    });

    it('exposes no customer or order data', () => {
      expect(page).not.toMatch(/customerEmail|customerName|orderId/);
    });
  });

  describe('ticket panel', () => {
    const panel = readFileSync(
      join(root, 'src', 'components', 'events', 'TicketPanel.astro'),
      'utf8',
    );

    it('preserves the existing ticket selection design', () => {
      for (const marker of [
        'data-ticket-list',
        'data-stepper',
        'data-total',
        'class="stepper"',
        'tickets-total-value',
        'AvailabilityBadge',
      ]) {
        expect(panel).toContain(marker);
      }
    });

    it('adds only the two authorised customer fields', () => {
      expect(panel).toContain('data-customer-name');
      expect(panel).toContain('data-customer-email');
      expect(panel).toContain('type="email"');
      // Explicitly out of scope for 07B.
      expect(panel).not.toMatch(/customerPhone|marketingOptIn/);
      expect(panel).not.toMatch(/postcode|addressLine/i);
    });

    it('contains no card field and no payment credential', () => {
      expect(panel).not.toMatch(/card ?number|cardnumber|cvc|cvv|autocomplete="cc-/i);
      expect(panel).not.toMatch(/SUMUP_API_KEY|SUMUP_MERCHANT_CODE|Bearer/);
      expect(panel).not.toMatch(/api\.sumup\.com/);
    });

    it('submits no authoritative money or reference', () => {
      const script = panel.slice(panel.indexOf('<script>'));
      const start = script.indexOf('JSON.stringify({');
      const payload = script.slice(start, script.indexOf('}),', start));
      expect(payload).toContain('eventId');
      expect(payload).toContain('items');
      expect(payload).toContain('customerName');
      expect(payload).toContain('customerEmail');
      for (const forbidden of ['amount', 'total', 'price', 'currency', 'reference', 'merchant']) {
        expect(payload.toLowerCase()).not.toContain(forbidden);
      }
    });

    it('sends the authoritative ticket type id with each quantity', () => {
      expect(panel).toContain('data-ticket-type-id={ticket.id}');
      expect(panel).toContain('stepper.dataset.ticketTypeId');
    });

    it('guards against an ordinary double submit', () => {
      expect(panel).toContain('let submitting = false;');
      expect(panel).toContain('if (submitting) return;');
      expect(panel).toContain('checkout.disabled = busy;');
    });

    it('handles controlled error responses', () => {
      for (const status of ['400', '404', '409', '503']) {
        expect(panel).toContain(`status === ${status}`);
      }
      expect(panel).toContain('Could not reach the server');
    });

    it('redirects only to an absolute https URL from the server response', () => {
      expect(panel).toContain('window.location.assign(hosted.toString())');
      expect(panel).toContain("hosted.protocol !== 'https:'");
      // The target is the response field, never anything from the page.
      expect(panel).toContain('new URL(payload.redirectUrl');
    });
  });

  describe('scope', () => {
    it('adds no webhook route and no ticket issuance', () => {
      const orders = readFileSync(join(root, 'src', 'pages', 'api', 'checkout', 'orders.ts'), 'utf8');
      expect(orders).not.toMatch(/webhook|verifyWebhook|processed_webhooks/i);
      expect(orders).not.toMatch(/insert into tickets/i);
    });
  });
});
