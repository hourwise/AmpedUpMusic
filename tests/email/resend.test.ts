/**
 * AMPED-08C2: the Resend transport adapter.
 *
 * The ordinary suite must never contact Resend, and it never does: every
 * provider request in this file goes through an injected fetch boundary and
 * every response is fabricated. No test needs — or may use — a real API key.
 *
 * Two layers are proved here:
 *
 *  1. The adapter itself: the exact request Resend would receive, and the
 *     translation from every provider outcome to the four result classes.
 *  2. The integration with the accepted 08C1 outbox: frozen snapshot content,
 *     deterministic attachments/CIDs, the durable idempotency key, lease
 *     fencing around real transport calls, terminal states never re-sending,
 *     and Retry-After being observed.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../../src/db/local.ts';
import { migrate } from '../../src/db/migrations.ts';
import { applySeed } from '../../src/db/seed.ts';
import { createD1OrderMutations } from '../../src/services/orders/service.ts';
import { createMockPaymentProvider } from '../../src/services/payments/mock.ts';
import { createD1TicketIssuance } from '../../src/services/tickets/issuance.ts';
import { createTicketTokenService, newCredentialId } from '../../src/services/tickets/token.ts';
import { createD1EmailDeliveries, type EmailDeliveryService } from '../../src/services/email/deliveries.ts';
import { createEmailDeliveryPass } from '../../src/services/email/runner.ts';
import {
  qrAttachmentContentId,
  qrAttachmentFilename,
  renderTicketConfirmation,
  type TicketConfirmationPayload,
} from '../../src/services/email/render.ts';
import { renderTicketQrPng } from '../../src/services/email/qr-png.ts';
import { RESEND_ENDPOINT, createResendTransport } from '../../src/services/email/resend.ts';
import { resolveEmailTransport } from '../../src/services/email/transport-config.ts';
import type { OutboundEmail, TransportResult } from '../../src/services/email/transport.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-10-07T09:00:00.000Z');
const EVENT = 'evt_glass_hearts_nov';
const TYPE = 'tt_gh_ga';
const FROM = 'Amped Up Music Promotions <tickets@ampedupmusicpromo.co.uk>';
const TEST_KEY = 're_test_key_never_real'; // fabricated; no provider ever sees it
const tokenSecret = newCredentialId(); // Ephemeral; never a staging secret.
const tokens = createTicketTokenService(tokenSecret);

// ---------------------------------------------------------------------------
// Fake HTTP boundary
// ---------------------------------------------------------------------------

interface ResendRequestBody {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  reply_to?: string;
  attachments?: Array<{
    filename: string;
    content: string;
    content_type: string;
    content_id: string;
  }>;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  body: ResendRequestBody;
}

type Responder = (call: CapturedCall) => Response | Promise<Response>;

interface FakeFetch {
  calls: CapturedCall[];
  impl: typeof fetch;
}

/** Responders are used in order; the last one answers any further calls. */
function fakeFetch(...responders: Responder[]): FakeFetch {
  const calls: CapturedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: CapturedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as ResendRequestBody,
    };
    calls.push(call);
    const responder = responders[calls.length - 1] ?? responders[responders.length - 1];
    if (!responder) throw new Error('fakeFetch has no responder');
    return responder(call);
  }) as typeof fetch;
  return { calls, impl };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function transportWith(fake: FakeFetch) {
  return createResendTransport({ apiKey: TEST_KEY, from: FROM, fetchImpl: fake.impl });
}

function unitMessage(overrides: Partial<OutboundEmail> = {}): OutboundEmail {
  return {
    to: 'buyer@example.invalid',
    subject: 'Your tickets for Example',
    text: 'plain text body',
    html: '<p>html body</p><img src="cid:qr-amp-1@ampedupmusicpromo.co.uk" />',
    attachments: [
      {
        filename: 'qr-amp-1.png',
        contentId: 'qr-amp-1@ampedupmusicpromo.co.uk',
        mimeType: 'image/png',
        contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      },
    ],
    idempotencyKey: 'ampedup:ticket-confirmation:v1:ord_unit',
    ...overrides,
  };
}

describe('AMPED-08C2 transport selection', () => {
  it('selects no transport when nothing is configured, or console/none is explicit', () => {
    for (const provider of [undefined, '', '  ', 'console', 'CONSOLE', 'none']) {
      const selection = resolveEmailTransport({
        EMAIL_PROVIDER: provider,
        RESEND_API_KEY: 're_test',
        EMAIL_FROM: FROM,
      });
      expect(selection).toEqual({ transport: null, issue: null });
    }
  });

  it('selects the Resend adapter only with an explicit provider, key and sender', () => {
    const selection = resolveEmailTransport({
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: TEST_KEY,
      EMAIL_FROM: FROM,
      EMAIL_REPLY_TO: 'tickets@ampedupmusicpromo.co.uk',
    });
    expect(selection.issue).toBeNull();
    expect(selection.transport?.name).toBe('resend');
  });

  it('fails closed for a requested-but-incomplete Resend configuration and never falls back', () => {
    for (const settings of [
      { EMAIL_PROVIDER: 'resend', EMAIL_FROM: FROM },
      { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: TEST_KEY },
      { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: '   ', EMAIL_FROM: FROM },
      { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: TEST_KEY, EMAIL_FROM: 'not-an-address' },
      { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: TEST_KEY, EMAIL_FROM: 'tickets@\ninvalid' },
    ]) {
      const selection = resolveEmailTransport(settings);
      expect(selection.transport, JSON.stringify(settings)).toBeNull();
      expect(selection.issue).toBe('resend_incomplete_config');
    }
  });

  it('fails closed and names an unknown provider request', () => {
    const selection = resolveEmailTransport({
      EMAIL_PROVIDER: 'sendgrid',
      RESEND_API_KEY: 're_test',
      EMAIL_FROM: FROM,
    });
    expect(selection.transport).toBeNull();
    expect(selection.issue).toBe('unknown_provider:sendgrid');
  });
});

describe('AMPED-08C2 exact Resend request', () => {
  it('maps the frozen message verbatim to the documented endpoint', async () => {
    const fake = fakeFetch(() => json({ id: 'msg_123' }));
    const transport = transportWith(fake);
    const message = unitMessage();

    const result = await transport.send(message);
    expect(transport.name).toBe('resend');
    expect(result).toEqual({ class: 'accepted', providerMessageId: 'msg_123' });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toBe(RESEND_ENDPOINT);
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.headers.get('idempotency-key')).toBe(message.idempotencyKey);

    expect(call.body.from).toBe(FROM);
    expect(call.body.to).toEqual(['buyer@example.invalid']);
    expect(call.body.subject).toBe(message.subject);
    expect(call.body.text).toBe(message.text);
    expect(call.body.html).toBe(message.html);
    expect(call.body.reply_to).toBeUndefined();
    expect(call.body.attachments).toEqual([
      {
        filename: 'qr-amp-1.png',
        content: message.attachments[0]!.contentBase64,
        content_type: 'image/png',
        content_id: 'qr-amp-1@ampedupmusicpromo.co.uk',
      },
    ]);
  });

  it('includes Reply-To only when it is configured', async () => {
    const fake = fakeFetch(() => json({ id: 'msg_1' }), () => json({ id: 'msg_2' }));
    const withReply = createResendTransport({
      apiKey: TEST_KEY,
      from: FROM,
      replyTo: 'tickets@ampedupmusicpromo.co.uk',
      fetchImpl: fake.impl,
    });
    await withReply.send(unitMessage());
    expect(fake.calls[0]!.body.reply_to).toBe('tickets@ampedupmusicpromo.co.uk');
  });

  it('reuses the durable idempotency key across attempts of the same intent, never per attempt', async () => {
    const fake = fakeFetch(() => json({}, 500), () => json({}, 500), () => json({ id: 'msg_3' }));
    const transport = transportWith(fake);
    const message = unitMessage();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await transport.send(message);
    }
    const keys = fake.calls.map((call) => call.headers.get('idempotency-key'));
    expect(keys).toEqual([message.idempotencyKey, message.idempotencyKey, message.idempotencyKey]);
    expect(new Set(keys).size).toBe(1);

    // A different logical intent uses a different key.
    await transport.send(unitMessage({ idempotencyKey: 'ampedup:ticket-confirmation:v1:ord_other' }));
    expect(fake.calls[3]!.headers.get('idempotency-key')).toBe(
      'ampedup:ticket-confirmation:v1:ord_other',
    );
  });

  it('never touches the global fetch when the boundary is injected', async () => {
    const fake = fakeFetch(() => json({ id: 'msg_1' }));
    const transport = transportWith(fake);
    const globalSpy = vi.spyOn(globalThis, 'fetch');
    await transport.send(unitMessage());
    globalSpy.mockRestore();
    expect(globalSpy).not.toHaveBeenCalled();
  });
});

describe('AMPED-08C2 provider outcome classification', () => {
  interface ClassificationCase {
    name: string;
    respond: Responder;
    expected: TransportResult;
  }

  const cases: ClassificationCase[] = [
    {
      name: 'successful acceptance with a provider message id (200)',
      respond: () => json({ id: 'pm_alpha' }),
      expected: { class: 'accepted', providerMessageId: 'pm_alpha' },
    },
    {
      name: 'successful acceptance with a provider message id (201)',
      respond: () => json({ id: 'pm_beta' }, 201),
      expected: { class: 'accepted', providerMessageId: 'pm_beta' },
    },
    {
      name: 'successful acceptance with a provider message id (202)',
      respond: () => json({ id: 'pm_gamma' }, 202),
      expected: { class: 'accepted', providerMessageId: 'pm_gamma' },
    },
    {
      name: 'success status without a readable message id',
      respond: () => new Response('<html>accepted?</html>', { status: 200 }),
      expected: {
        class: 'ambiguous',
        errorCode: 'resend_uninterpretable_response',
      },
    },
    {
      name: 'success status with a non-string id',
      respond: () => json({ object: 'email' }),
      expected: { class: 'ambiguous', errorCode: 'resend_uninterpretable_response' },
    },
    {
      name: 'malformed request (400)',
      respond: () => json({ name: 'validation_error', message: 'SECRET_ECHO' }, 400),
      expected: { class: 'permanent_failure', errorCode: 'resend_validation_error' },
    },
    {
      name: 'authentication failure (401)',
      respond: () => json({ name: 'invalid_api_key' }, 401),
      expected: { class: 'permanent_failure', errorCode: 'resend_invalid_api_key' },
    },
    {
      name: 'forbidden (403)',
      respond: () => json({}, 403),
      expected: { class: 'permanent_failure', errorCode: 'resend_auth_failed' },
    },
    {
      name: 'unknown endpoint (404)',
      respond: () => json({}, 404),
      expected: { class: 'permanent_failure', errorCode: 'resend_http_404' },
    },
    {
      name: 'gateway timeout (408)',
      respond: () => json({}, 408),
      expected: { class: 'ambiguous', errorCode: 'resend_timeout' },
    },
    {
      name: 'idempotency key reused with different content (409 invalid_idempotent_request)',
      respond: () =>
        json({ name: 'invalid_idempotent_request', message: 'SECRET_ECHO' }, 409),
      expected: { class: 'permanent_failure', errorCode: 'resend_invalid_idempotent_request' },
    },
    {
      name: 'concurrent request for the same idempotency key (409 concurrent_idempotent_requests)',
      respond: () => json({ name: 'concurrent_idempotent_requests' }, 409),
      expected: { class: 'retryable', errorCode: 'resend_concurrent_idempotent_requests' },
    },
    {
      name: 'concurrent idempotent request honouring Retry-After (409)',
      respond: () =>
        json({ name: 'concurrent_idempotent_requests' }, 409, { 'retry-after': '45' }),
      expected: {
        class: 'retryable',
        errorCode: 'resend_concurrent_idempotent_requests',
        retryAfterMs: 45_000,
      },
    },
    {
      name: 'unknown 409 error code',
      respond: () => json({ name: 'some_other_conflict' }, 409),
      expected: { class: 'ambiguous', errorCode: 'resend_conflict' },
    },
    {
      name: '409 without an error code',
      respond: () => json({}, 409),
      expected: { class: 'ambiguous', errorCode: 'resend_conflict' },
    },
    {
      name: 'malformed 409 response body',
      respond: () => new Response('<html>conflict</html>', { status: 409 }),
      expected: { class: 'ambiguous', errorCode: 'resend_conflict' },
    },
    {
      name: 'payload too large (413)',
      respond: () => json({}, 413),
      expected: { class: 'permanent_failure', errorCode: 'resend_payload_too_large' },
    },
    {
      name: 'validation failure (422)',
      respond: () => json({ name: 'validation_error', message: 'SECRET_ECHO' }, 422),
      expected: { class: 'permanent_failure', errorCode: 'resend_validation_error' },
    },
    {
      name: 'rate limited with Retry-After (429)',
      respond: () => json({ name: 'rate_limit_exceeded' }, 429, { 'retry-after': '120' }),
      expected: { class: 'retryable', errorCode: 'resend_rate_limit_exceeded', retryAfterMs: 120_000 },
    },
    {
      name: 'rate limited without a parseable Retry-After (429)',
      respond: () => json({}, 429, { 'retry-after': 'not-a-date' }),
      expected: { class: 'retryable', errorCode: 'resend_rate_limited' },
    },
    {
      name: 'transient server failure (500)',
      respond: () => json({}, 500),
      expected: { class: 'retryable', errorCode: 'resend_server_error' },
    },
    {
      name: 'transient server failure (502)',
      respond: () => json({}, 502),
      expected: { class: 'retryable', errorCode: 'resend_server_error' },
    },
    {
      name: 'transient server failure with Retry-After (503)',
      respond: () => json({}, 503, { 'retry-after': '300' }),
      expected: { class: 'retryable', errorCode: 'resend_server_error', retryAfterMs: 300_000 },
    },
    {
      name: 'transient server failure (504)',
      respond: () => json({}, 504),
      expected: { class: 'retryable', errorCode: 'resend_server_error' },
    },
    {
      name: 'unexpected redirect (302)',
      respond: () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid' } }),
      expected: { class: 'ambiguous', errorCode: 'resend_unexpected_status' },
    },
    {
      name: 'unexpected status (501)',
      respond: () => json({}, 501),
      expected: { class: 'ambiguous', errorCode: 'resend_unexpected_status' },
    },
  ];

  it.each(cases)('$name', async ({ respond, expected }) => {
    const fake = fakeFetch(respond);
    const transport = transportWith(fake);
    const result = await transport.send(unitMessage());

    expect(result.class).toBe(expected.class);
    expect(result.errorCode).toBe(expected.errorCode);
    if (expected.class === 'accepted') {
      expect(result.providerMessageId).toBe(expected.providerMessageId);
    } else {
      // A provider message id may only be recorded after a response
      // establishes one.
      expect(result.providerMessageId).toBeUndefined();
    }
    if (expected.retryAfterMs !== undefined) {
      expect(result.retryAfterMs).toBe(expected.retryAfterMs);
    } else {
      expect(result.retryAfterMs).toBeUndefined();
    }
    // Provider error bodies are never echoed into stored evidence.
    expect(result.errorMessage ?? '').not.toContain('SECRET_ECHO');
  });

  it('treats a timeout as ambiguous because acceptance cannot be established', async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const fake = fakeFetch(() => {
        throw new DOMException('timed out', name);
      });
      const result = await transportWith(fake).send(unitMessage());
      expect(result.class).toBe('ambiguous');
      expect(result.errorCode).toBe('resend_timeout');
      expect(result.providerMessageId).toBeUndefined();
    }
  });

  it('retries only failures that provably never reached the provider', async () => {
    const refused = fakeFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    const refusedResult = await transportWith(refused).send(unitMessage());
    expect(refusedResult.class).toBe('retryable');
    expect(refusedResult.errorCode).toBe('resend_network_unreachable');

    const dns = fakeFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    });
    const dnsResult = await transportWith(dns).send(unitMessage());
    expect(dnsResult.class).toBe('retryable');
    expect(dnsResult.errorCode).toBe('resend_network_unreachable');
  });

  it('treats an uncategorised network failure as ambiguous, not retryable', async () => {
    const fake = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const result = await transportWith(fake).send(unitMessage());
    expect(result.class).toBe('ambiguous');
    expect(result.errorCode).toBe('resend_network_uncertain');
  });

  it('treats a response lost mid-read as ambiguous', async () => {
    const fake = fakeFetch(
      () =>
        ({
          status: 200,
          headers: new Headers(),
          text: () => Promise.reject(new Error('connection lost mid-body')),
        }) as unknown as Response,
    );
    const result = await transportWith(fake).send(unitMessage());
    expect(result.class).toBe('ambiguous');
    expect(result.errorCode).toBe('resend_response_lost');
  });
});

// ---------------------------------------------------------------------------
// Integration with the accepted 08C1 outbox
// ---------------------------------------------------------------------------

describe('AMPED-08C2 delivery through the durable outbox', () => {
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

  function deliveries(): EmailDeliveryService {
    return createD1EmailDeliveries(db);
  }

  async function fulfilledOrder(quantity = 2) {
    const orders = createD1OrderMutations(db, () => NOW, (prefix) => `${prefix}_08c2_${++serial}`);
    const created = await orders.createOrder({
      eventId: EVENT,
      items: [{ ticketTypeId: TYPE, quantity }],
      customerName: '08C2 Buyer',
      customerEmail: `08c2-${++serial}@example.invalid`,
      marketingOptIn: false,
    });
    const provider = createMockPaymentProvider({ now: () => NOW, newId: () => `08c2_${++serial}` });
    const checkout = await orders.beginPayment(created.orderId, provider, 'https://amped.test/checkout/return');
    await orders.confirmPayment(created.orderId, checkout.checkoutId, provider);
    await createD1TicketIssuance(db, () => NOW).issuePaidOrder(created.orderId);
    return created.orderId;
  }

  async function intentFor(orderId: string) {
    const service = deliveries();
    const created = await service.ensureConfirmationIntent(orderId, NOW);
    expect(created.outcome).toBe('created');
    return { orderId, service, delivery: (await service.getDelivery(created.deliveryId!))! };
  }

  function passFor(service: EmailDeliveryService, transport: ReturnType<typeof transportWith>) {
    return createEmailDeliveryPass({ deliveries: service, tokens: () => tokens, transport });
  }

  it('sends the frozen snapshot verbatim: recipients, bodies, QR attachments and durable key', async () => {
    const { orderId, service, delivery } = await intentFor(await fulfilledOrder(2));
    const fake = fakeFetch(() => json({ id: 'pm_resend_frozen' }));
    const transport = transportWith(fake);

    const globalSpy = vi.spyOn(globalThis, 'fetch');
    const summary = await passFor(service, transport).run(NOW);
    globalSpy.mockRestore();

    expect(globalSpy).not.toHaveBeenCalled();
    expect(summary.transport).toBe('resend');
    expect(summary.attempted).toBe(1);
    expect(summary.accepted).toBe(1);
    expect(fake.calls).toHaveLength(1);

    const accepted = (await service.getDelivery(delivery.id))!;
    expect(accepted.state).toBe('accepted');
    expect(accepted.provider).toBe('resend');
    expect(accepted.providerMessageId).toBe('pm_resend_frozen');
    expect(accepted.acceptedAt).toBe(NOW.toISOString());

    // The request body is exactly the frozen 08C1 rendering — not a re-read.
    const payload = JSON.parse(delivery.payload) as TicketConfirmationPayload;
    const rendered = await renderTicketConfirmation(payload, tokens);
    const call = fake.calls[0]!;
    expect(call.url).toBe(RESEND_ENDPOINT);
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(call.headers.get('idempotency-key')).toBe(delivery.idempotencyKey);
    expect(delivery.idempotencyKey).toBe(`ampedup:ticket-confirmation:v1:${orderId}`);
    expect(call.body.from).toBe(FROM);
    expect(call.body.to).toEqual([delivery.recipient]);
    expect(call.body.subject).toBe(rendered.subject);
    expect(call.body.text).toBe(rendered.text);
    expect(call.body.html).toBe(rendered.html);

    // One QR PNG per durable ticket: deterministic filename, MIME type,
    // content id matching the HTML cid: references exactly, and the exact
    // bytes the deterministic renderer produced from the existing credential.
    const attachments = call.body.attachments ?? [];
    expect(attachments).toHaveLength(payload.tickets.length);
    const cidRefs = [...rendered.html.matchAll(/cid:([A-Za-z0-9._@-]+)/g)]
      .map((match) => match[1]!)
      .sort();
    expect(attachments.map((attachment) => attachment.content_id).sort()).toEqual(cidRefs);
    for (const ticket of payload.tickets) {
      const attachment = attachments.find(
        (candidate) => candidate.content_id === qrAttachmentContentId(ticket.reference),
      );
      expect(attachment).toBeDefined();
      expect(attachment!.filename).toBe(qrAttachmentFilename(ticket.reference));
      expect(attachment!.content_type).toBe('image/png');
      const expectedPng = await renderTicketQrPng(await tokens.sign(ticket.credentialId));
      expect(Buffer.from(attachment!.content, 'base64').equals(Buffer.from(expectedPng))).toBe(true);
    }

    // Email never decides payment or ticket state.
    const order = await db
      .prepare('select status, tickets_fulfilled_at from orders where id = ?1')
      .bind(orderId)
      .first<{ status: string; tickets_fulfilled_at: string | null }>();
    expect(order?.status).toBe('paid');
    expect(order?.tickets_fulfilled_at).not.toBeNull();

    // Accepted is terminal: a later pass sends nothing more.
    const later = await passFor(service, transport).run(new Date(NOW.getTime() + 30 * 60_000));
    expect(later.attempted).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });

  it('keeps lease fencing authoritative once real transport calls exist', async () => {
    const { service, delivery } = await intentFor(await fulfilledOrder(1));
    const fake = fakeFetch(() => json({ id: 'pm_never' }));
    const transport = transportWith(fake);

    // Another worker already holds a live lease on this delivery.
    const held = await service.claim(delivery.id, { token: 'holder_a', now: NOW, leaseMs: 300_000 });
    expect(held).not.toBeNull();

    // A concurrent pass cannot perform a parallel send.
    const blocked = await passFor(service, transport).run(new Date(NOW.getTime() + 1_000));
    expect(blocked.attempted).toBe(0);
    expect(fake.calls).toHaveLength(0);

    // A stale writer cannot record a result for a lease it does not hold.
    expect(
      await service.recordResult(
        delivery.id,
        'stale_writer_b',
        { class: 'accepted', providerMessageId: 'pm_stale' },
        { now: NOW, providerName: 'resend' },
      ),
    ).toBe(false);
    expect((await service.getDelivery(delivery.id))!.state).toBe('claimed');

    // The current holder can record the provider result.
    expect(
      await service.recordResult(
        delivery.id,
        'holder_a',
        { class: 'accepted', providerMessageId: 'pm_holder' },
        { now: NOW, providerName: 'resend' },
      ),
    ).toBe(true);
    const settled = (await service.getDelivery(delivery.id))!;
    expect(settled.state).toBe('accepted');
    expect(settled.providerMessageId).toBe('pm_holder');
    expect(settled.id).toBe(delivery.id); // local identity, never the provider id

    await passFor(service, transport).run(new Date(NOW.getTime() + 60 * 60_000));
    expect(fake.calls).toHaveLength(0);
  });

  it('never automatically re-sends an ambiguous outcome', async () => {
    const { service, delivery } = await intentFor(await fulfilledOrder(1));
    const fake = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid' } }),
    );
    const transport = transportWith(fake);

    const summary = await passFor(service, transport).run(NOW);
    expect(summary.ambiguous).toBe(1);
    const row = (await service.getDelivery(delivery.id))!;
    expect(row.state).toBe('ambiguous');
    expect(row.lastErrorCode).toBe('resend_unexpected_status');
    expect(row.providerMessageId).toBeNull();

    await passFor(service, transport).run(new Date(NOW.getTime() + 6 * 60 * 60_000));
    expect(fake.calls).toHaveLength(1);
  });

  it('never automatically re-sends a permanent failure', async () => {
    const { service, delivery } = await intentFor(await fulfilledOrder(1));
    const fake = fakeFetch(() => json({ name: 'invalid_api_key' }, 401));
    const transport = transportWith(fake);

    const summary = await passFor(service, transport).run(NOW);
    expect(summary.permanentFailures).toBe(1);
    const row = (await service.getDelivery(delivery.id))!;
    expect(row.state).toBe('permanent_failure');
    expect(row.lastErrorCode).toBe('resend_invalid_api_key');
    expect(row.providerMessageId).toBeNull();

    await passFor(service, transport).run(new Date(NOW.getTime() + 6 * 60 * 60_000));
    expect(fake.calls).toHaveLength(1);
  });

  it('observes Retry-After, reuses the same provider idempotency key, and stops on acceptance', async () => {
    const { service, delivery } = await intentFor(await fulfilledOrder(1));
    const fake = fakeFetch(
      () => json({ name: 'rate_limit_exceeded' }, 429, { 'retry-after': '120' }),
      () => json({ id: 'pm_after_retry' }),
    );
    const transport = transportWith(fake);

    const first = await passFor(service, transport).run(NOW);
    expect(first.retryable).toBe(1);
    const retryable = (await service.getDelivery(delivery.id))!;
    expect(retryable.state).toBe('retryable');
    expect(retryable.nextRetryAt).toBe(new Date(NOW.getTime() + 120_000).toISOString());
    expect(retryable.lastErrorCode).toBe('resend_rate_limit_exceeded');

    // Not due yet: the backoff is observed, not churned.
    await passFor(service, transport).run(new Date(NOW.getTime() + 60_000));
    expect(fake.calls).toHaveLength(1);

    const second = await passFor(service, transport).run(new Date(NOW.getTime() + 121_000));
    expect(second.accepted).toBe(1);
    expect(fake.calls).toHaveLength(2);
    // Same logical email, same provider idempotency key — never per attempt.
    expect(fake.calls[0]!.headers.get('idempotency-key')).toBe(delivery.idempotencyKey);
    expect(fake.calls[1]!.headers.get('idempotency-key')).toBe(delivery.idempotencyKey);

    const accepted = (await service.getDelivery(delivery.id))!;
    expect(accepted.state).toBe('accepted');
    expect(accepted.attemptCount).toBe(2);
    expect(accepted.providerMessageId).toBe('pm_after_retry');
  });

  it('treats a reused-content idempotency conflict as a permanent local defect, never persisted or logged', async () => {
    const { service, delivery } = await intentFor(await fulfilledOrder(1));
    const providerBodySecret = 'PROVIDER_BODY_SECRET_MUST_NEVER_BE_STORED';
    const fake = fakeFetch(() =>
      json({ name: 'invalid_idempotent_request', message: providerBodySecret }, 409),
    );
    const transport = transportWith(fake);

    const warnSpy = vi.spyOn(console, 'warn');
    const errorSpy = vi.spyOn(console, 'error');
    const logSpy = vi.spyOn(console, 'log');
    const summary = await passFor(service, transport).run(NOW);
    const logged = [...warnSpy.mock.calls, ...errorSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map(String)
      .join(' ');
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();

    expect(summary.permanentFailures).toBe(1);
    const row = (await service.getDelivery(delivery.id))!;
    expect(row.state).toBe('permanent_failure');
    expect(row.lastErrorCode).toBe('resend_invalid_idempotent_request');
    expect(row.providerMessageId).toBeNull();
    // The provider's response text is neither persisted on the row nor
    // written to any operational log.
    expect(JSON.stringify(row)).not.toContain(providerBodySecret);
    expect(logged).not.toContain(providerBodySecret);

    // A permanent local defect is never automatically retried.
    await passFor(service, transport).run(new Date(NOW.getTime() + 6 * 60 * 60_000));
    expect(fake.calls).toHaveLength(1);
  });

  it('retries a concurrent idempotency conflict later with the same durable key and frozen payload, then accepts', async () => {
    const { service, delivery } = await intentFor(await fulfilledOrder(2));
    const fake = fakeFetch(
      () => json({ name: 'concurrent_idempotent_requests' }, 409, { 'retry-after': '90' }),
      () => json({ id: 'pm_after_concurrent' }),
    );
    const transport = transportWith(fake);

    const first = await passFor(service, transport).run(NOW);
    expect(first.retryable).toBe(1);
    const retryable = (await service.getDelivery(delivery.id))!;
    expect(retryable.state).toBe('retryable');
    expect(retryable.lastErrorCode).toBe('resend_concurrent_idempotent_requests');
    expect(retryable.nextRetryAt).toBe(new Date(NOW.getTime() + 90_000).toISOString());

    // Not due yet: the bounded retry schedule is observed, not churned.
    await passFor(service, transport).run(new Date(NOW.getTime() + 30_000));
    expect(fake.calls).toHaveLength(1);

    // Due: the same durable intent retries with the SAME idempotency key and
    // a byte-identical frozen request payload, and this time is accepted.
    const second = await passFor(service, transport).run(new Date(NOW.getTime() + 91_000));
    expect(second.accepted).toBe(1);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.headers.get('idempotency-key')).toBe(delivery.idempotencyKey);
    expect(fake.calls[1]!.headers.get('idempotency-key')).toBe(delivery.idempotencyKey);
    expect(fake.calls[1]!.body).toEqual(fake.calls[0]!.body);

    const accepted = (await service.getDelivery(delivery.id))!;
    expect(accepted.state).toBe('accepted');
    expect(accepted.providerMessageId).toBe('pm_after_concurrent');
    expect(accepted.acceptedAt).toBe(new Date(NOW.getTime() + 91_000).toISOString());

    // Terminal: no further automatic sends.
    await passFor(service, transport).run(new Date(NOW.getTime() + 24 * 60 * 60_000));
    expect(fake.calls).toHaveLength(2);
  });

  it('sends nothing when Resend is requested but the configuration fails closed', async () => {
    const selection = resolveEmailTransport({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: FROM });
    expect(selection.transport).toBeNull();
    expect(selection.issue).toBe('resend_incomplete_config');

    const { service, delivery } = await intentFor(await fulfilledOrder(1));
    const globalSpy = vi.spyOn(globalThis, 'fetch');
    const summary = await createEmailDeliveryPass({
      deliveries: service,
      tokens: () => tokens,
      transport: selection.transport,
    }).run(NOW);
    globalSpy.mockRestore();

    expect(globalSpy).not.toHaveBeenCalled();
    expect(summary.attempted).toBe(0);
    expect(summary.accepted).toBe(0);
    expect((await service.getDelivery(delivery.id))!.state).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Runtime compatibility
// ---------------------------------------------------------------------------

describe('AMPED-08C2 worker-runtime compatibility', () => {
  it('keeps the email slice free of Node-only imports and provider SDKs', () => {
    const emailDir = join(root, 'src', 'services', 'email');
    for (const file of readdirSync(emailDir)) {
      const source = readFileSync(join(emailDir, file), 'utf8');
      expect(source, file).not.toMatch(/\bfrom ['"]node:/);
      expect(source, file).not.toMatch(/\brequire\s*\(/);
    }
    const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
    expect(packageJson).not.toContain('"resend"');
  });

  it('reaches the provider only through the injected fetch boundary', () => {
    const adapter = readFileSync(join(root, 'src', 'services', 'email', 'resend.ts'), 'utf8');
    expect(adapter).toContain('config.fetchImpl ?? fetch');
    expect(adapter).not.toMatch(/XMLHttpRequest|axios|node:https/);
  });
});
