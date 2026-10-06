/**
 * AMPED-08C1: provider-independent rendering of the ticket confirmation.
 *
 * Proves the properties the frozen snapshot exists for:
 *  - repeated renders are semantically identical, byte-for-byte for the
 *    locally generated PNG attachments;
 *  - one message contains every durable ticket in the order;
 *  - a later event/venue edit cannot change an existing intent's rendering;
 *  - retrying never creates replacement tickets or credentials;
 *  - the QR PNGs are generated locally and are valid 1-bit greyscale PNGs
 *    that encode exactly the same matrix as the accepted 08B SVG QR;
 *  - nothing in the email slice performs a network call.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../../src/db/local.ts';
import { migrate } from '../../src/db/migrations.ts';
import { applySeed } from '../../src/db/seed.ts';
import { formatFullDate, formatTime } from '../../src/lib/dates.ts';
import { createD1OrderMutations } from '../../src/services/orders/service.ts';
import { createMockPaymentProvider } from '../../src/services/payments/mock.ts';
import { createD1TicketIssuance } from '../../src/services/tickets/issuance.ts';
import { createTicketTokenService, newCredentialId } from '../../src/services/tickets/token.ts';
import { createD1EmailDeliveries } from '../../src/services/email/deliveries.ts';
import { createEmailDeliveryPass } from '../../src/services/email/runner.ts';
import {
  qrAttachmentContentId,
  qrAttachmentFilename,
  renderTicketConfirmation,
  ticketConfirmationIdempotencyKey,
  type TicketConfirmationPayload,
} from '../../src/services/email/render.ts';
import {
  QR_PNG_PIXELS_PER_MODULE,
  QR_PNG_QUIET_ZONE_MODULES,
  renderTicketQrPng,
  ticketQrMatrix,
} from '../../src/services/email/qr-png.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-10-06T14:00:00.000Z');
const EVENT = 'evt_glass_hearts_nov';
const TYPE = 'tt_gh_ga';
const SECOND_TYPE = 'tt_08c1_vip';
const tokenSecret = newCredentialId(); // Ephemeral; never a staging secret.
const tokens = createTicketTokenService(tokenSecret);

describe('AMPED-08C1 ticket-confirmation rendering', () => {
  let ephemeral: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let serial = 0;

  beforeAll(async () => {
    ephemeral = await openEphemeralDatabase();
    db = ephemeral.db;
    await migrate(db);
    await applySeed(db);
    await db
      .prepare(
        `insert into ticket_types (id, event_id, name, price_in_pence, capacity,
           max_per_order, position, visibility)
         values (?1, ?2, 'VIP Presale', 2000, 10, 5, 100, 'public')`,
      )
      .bind(SECOND_TYPE, EVENT)
      .run();
  });

  afterAll(async () => ephemeral.dispose());

  /** A paid, fully fulfilled multi-ticket order with its frozen intent. */
  async function multiTicketDelivery() {
    const orders = createD1OrderMutations(db, () => NOW, (prefix) => `${prefix}_08c1r_${++serial}`);
    const created = await orders.createOrder({
      eventId: EVENT,
      items: [
        { ticketTypeId: TYPE, quantity: 2 },
        { ticketTypeId: SECOND_TYPE, quantity: 1 },
      ],
      customerName: '08C1 Render',
      customerEmail: `08c1-render-${++serial}@example.invalid`,
      marketingOptIn: false,
    });
    const provider = createMockPaymentProvider({ now: () => NOW, newId: () => `08c1r_${++serial}` });
    const checkout = await orders.beginPayment(created.orderId, provider, 'https://amped.test/checkout/return');
    await orders.confirmPayment(created.orderId, checkout.checkoutId, provider);
    await createD1TicketIssuance(db, () => NOW).issuePaidOrder(created.orderId);

    const service = createD1EmailDeliveries(db);
    const intent = await service.ensureConfirmationIntent(created.orderId, NOW);
    expect(intent.outcome).toBe('created');
    const delivery = (await service.getDelivery(intent.deliveryId!))!;
    return { orderId: created.orderId, service, delivery };
  }

  it('renders repeated times with identical content and byte-identical attachments', async () => {
    const { delivery } = await multiTicketDelivery();
    const payload = JSON.parse(delivery.payload) as TicketConfirmationPayload;

    const first = await renderTicketConfirmation(payload, tokens);
    const second = await renderTicketConfirmation(payload, tokens);
    expect(second).toEqual(first);

    expect(first.subject).toBeTruthy();
    expect(first.text.length).toBeGreaterThan(200);
    expect(first.html).toContain('<!doctype html>');
    expect(first.text).not.toContain('<');
    expect(first.attachments).toHaveLength(3);
    expect(new Set(first.attachments.map((attachment) => attachment.contentId)).size).toBe(3);
    expect(new Set(first.attachments.map((attachment) => attachment.filename)).size).toBe(3);
    for (const attachment of first.attachments) {
      expect(attachment.mimeType).toBe('image/png');
      expect(attachment.contentBase64.startsWith('iVBORw0KGgo')).toBe(true); // PNG magic in base64
    }
  });

  it('puts every durable ticket of the order into the one message', async () => {
    const { orderId, delivery } = await multiTicketDelivery();
    const payload = JSON.parse(delivery.payload) as TicketConfirmationPayload;
    const rendered = await renderTicketConfirmation(payload, tokens);

    expect(payload.tickets).toHaveLength(3);
    // Every frozen ticket is listed, with its purchased type name, and has
    // exactly one attachment whose deterministic id and filename derive from
    // its own reference.
    for (const ticket of payload.tickets) {
      expect(rendered.text).toContain(`${ticket.reference} - ${ticket.ticketTypeName}`);
      expect(rendered.html).toContain(ticket.reference);
      expect(rendered.html).toContain(`cid:${qrAttachmentContentId(ticket.reference)}`);
      const attachment = rendered.attachments.find(
        (candidate) => candidate.contentId === qrAttachmentContentId(ticket.reference),
      );
      expect(attachment?.filename).toBe(qrAttachmentFilename(ticket.reference));
    }
    expect(rendered.text).toContain('Your tickets (3):');

    // The frozen snapshot carries the durable ticket identities, not new ones.
    const durable = await db
      .prepare('select id, reference, credential_id from tickets where order_id = ?1 order by id')
      .bind(orderId)
      .all<{ id: string; reference: string; credential_id: string }>();
    expect(durable.results.map((row) => row.id).sort()).toEqual(
      payload.tickets.map((ticket) => ticket.ticketId).sort(),
    );
    expect(durable.results.map((row) => row.credential_id).sort()).toEqual(
      payload.tickets.map((ticket) => ticket.credentialId).sort(),
    );
    expect(rendered.html).toContain('General Admission');
    expect(rendered.html).toContain('VIP Presale');
  });

  it('includes only factual customer information from authoritative data', async () => {
    const { delivery } = await multiTicketDelivery();
    const payload = JSON.parse(delivery.payload) as TicketConfirmationPayload;
    const rendered = await renderTicketConfirmation(payload, tokens);
    const event = await db
      .prepare('select title, doors_at, starts_at from events where id = ?1')
      .bind(EVENT)
      .first<{ title: string; doors_at: string; starts_at: string }>();

    expect(rendered.subject).toContain(event!.title);
    expect(rendered.subject).toContain(payload.orderReference);
    expect(rendered.text).toContain(formatFullDate(event!.starts_at));
    expect(rendered.text).toContain(`doors ${formatTime(event!.doors_at)}`);
    expect(rendered.text).toContain('The Lomax Rooms');
    expect(rendered.text).toContain('14 Sedgewick Street');
    expect(rendered.text).toContain('Preston PR1 4AQ');
    expect(rendered.text).toContain(`Order reference: ${payload.orderReference}`);
    // Admission guidance comes from the recorded age restriction, not copy.
    expect(payload.event.ageRestriction).toBe('16-plus');
    expect(rendered.text).toContain('Admission: 16+');
    expect(rendered.text).toContain('tickets@ampedupmusicpromo.co.uk');
    expect(rendered.html).toContain('mailto:tickets@ampedupmusicpromo.co.uk');

    // No surrogate tickets and no signing material in the stored payload.
    expect(delivery.payload).not.toContain(tokenSecret);
    expect(delivery.payload).not.toContain('AUP1.');
    expect(delivery.payload).toContain(payload.recipient);
    expect(delivery.payload).toContain(payload.tickets[0]!.credentialId);
  });

  it('renders the frozen snapshot even after the event and venue are edited', async () => {
    const { orderId, service, delivery } = await multiTicketDelivery();
    const payload = JSON.parse(delivery.payload) as TicketConfirmationPayload;

    await db.prepare("update events set title = 'Rewritten After Freeze' where id = ?1").bind(EVENT).run();
    await db.prepare("update venues set name = 'Rewritten Venue' where id = 'ven_lomax'").run();
    try {
      const rendered = await renderTicketConfirmation(payload, tokens);
      expect(rendered.subject).toContain('The Glass Hearts');
      expect(rendered.subject).not.toContain('Rewritten');
      expect(rendered.text).toContain('The Lomax Rooms');
      expect(rendered.text).not.toContain('Rewritten Venue');

      // The delivery itself is untouched and cannot be re-minted.
      const again = await service.ensureConfirmationIntent(orderId, new Date(NOW.getTime() + 60_000));
      expect(again.outcome).toBe('exists');
      expect((await service.getDelivery(again.deliveryId!))!.payload).toBe(delivery.payload);
      expect((await service.getDelivery(again.deliveryId!))!.payloadHash).toBe(delivery.payloadHash);
    } finally {
      await db.prepare("update events set title = 'The Glass Hearts' where id = ?1").bind(EVENT).run();
      await db.prepare("update venues set name = 'The Lomax Rooms' where id = 'ven_lomax'").run();
    }
  });

  it('never creates replacement tickets or credentials across retries', async () => {
    const { orderId, service, delivery } = await multiTicketDelivery();
    const ticketState = async () =>
      (
        await db
          .prepare('select id, reference, credential_id, status from tickets where order_id = ?1 order by id')
          .bind(orderId)
          .all<{ id: string; reference: string; credential_id: string; status: string }>()
      ).results;
    const before = await ticketState();
    const first = await renderTicketConfirmation(
      JSON.parse(delivery.payload) as TicketConfirmationPayload,
      tokens,
    );

    // First attempt fails retryably; a later worker reclaims and renders again.
    await service.claim(delivery.id, { token: 'render_retry_a', now: NOW });
    await service.recordResult(
      delivery.id,
      'render_retry_a',
      { class: 'retryable', errorCode: 'gateway_timeout' },
      { now: NOW, providerName: 'test-provider' },
    );
    const reclaimed = await service.claim(delivery.id, {
      token: 'render_retry_b',
      now: new Date(NOW.getTime() + 10 * 60_000),
    });
    expect(reclaimed).not.toBeNull();

    const reloaded = (await service.getDelivery(delivery.id))!;
    expect(reloaded.payload).toBe(delivery.payload);
    expect(reloaded.payloadHash).toBe(delivery.payloadHash);
    const second = await renderTicketConfirmation(
      JSON.parse(reloaded.payload) as TicketConfirmationPayload,
      tokens,
    );
    expect(second).toEqual(first);

    expect(await ticketState()).toEqual(before);
    const count = await db
      .prepare('select count(*) as n from tickets where order_id = ?1')
      .bind(orderId)
      .first<{ n: number }>();
    expect(Number(count?.n)).toBe(before.length);
  });

  it('produces a valid local PNG that encodes exactly the accepted QR matrix', async () => {
    const { delivery } = await multiTicketDelivery();
    const payload = JSON.parse(delivery.payload) as TicketConfirmationPayload;
    const credentialId = payload.tickets[0]!.credentialId;
    const token = await tokens.sign(credentialId);

    const png = await renderTicketQrPng(token);
    const again = await renderTicketQrPng(token);
    expect(Buffer.from(png).equals(Buffer.from(again))).toBe(true);

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks = parsePngChunks(png);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);

    const ihdr = chunks[0]!.data;
    const view = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
    const { modules, size } = ticketQrMatrix(token);
    const side = (size + QR_PNG_QUIET_ZONE_MODULES * 2) * QR_PNG_PIXELS_PER_MODULE;
    expect(view.getUint32(0)).toBe(side);
    expect(view.getUint32(4)).toBe(side);
    expect(ihdr[8]).toBe(1); // bit depth
    expect(ihdr[9]).toBe(0); // greyscale

    const raw = await inflate(chunks[1]!.data);
    const rowBytes = Math.ceil(side / 8);
    expect(raw.length).toBe((rowBytes + 1) * side);

    let mismatches = 0;
    for (let y = 0; y < side; y += 1) {
      if (raw[y * (rowBytes + 1)] !== 0) mismatches += 1; // filter byte: None
      const moduleRow = Math.floor(y / QR_PNG_PIXELS_PER_MODULE) - QR_PNG_QUIET_ZONE_MODULES;
      for (let x = 0; x < side; x += 1) {
        const bit = (raw[y * (rowBytes + 1) + 1 + (x >> 3)]! >> (7 - (x & 7))) & 1;
        const moduleCol = Math.floor(x / QR_PNG_PIXELS_PER_MODULE) - QR_PNG_QUIET_ZONE_MODULES;
        const dark =
          moduleRow >= 0 && moduleRow < size && moduleCol >= 0 && moduleCol < size
            ? modules[moduleRow]![moduleCol]!
            : false;
        if (bit !== (dark ? 0 : 1)) mismatches += 1;
      }
    }
    expect(mismatches).toBe(0);

    // The attachment in the rendered message is exactly this PNG.
    const rendered = await renderTicketConfirmation(payload, tokens);
    const attachment = rendered.attachments.find(
      (candidate) => candidate.contentId === qrAttachmentContentId(payload.tickets[0]!.reference),
    );
    expect(attachment).toBeDefined();
    expect(Buffer.from(attachment!.contentBase64, 'base64').equals(Buffer.from(png))).toBe(true);

    // The QR carries only the opaque signed token: no PII, no order data.
    expect(token.startsWith('AUP1.')).toBe(true);
    expect(token).not.toContain('@');
    expect(token).not.toContain(payload.orderReference);
  });

  it('performs zero network calls while rendering and while the pass identifies work', async () => {
    const { service, delivery } = await multiTicketDelivery();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await renderTicketConfirmation(
      JSON.parse(delivery.payload) as TicketConfirmationPayload,
      tokens,
    );
    const summary = await createEmailDeliveryPass({
      deliveries: service,
      tokens: () => tokens,
      transport: null,
    }).run(NOW);
    fetchSpy.mockRestore();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(summary.transport).toBeNull();
    expect(summary.attempted).toBe(0);
    expect(summary.accepted).toBe(0);
  });

  it('contains no provider networking and resolves no email transport in this slice', () => {
    const emailDir = join(root, 'src', 'services', 'email');
    for (const file of readdirSync(emailDir)) {
      const source = readFileSync(join(emailDir, file), 'utf8');
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source.toLowerCase(), file).not.toContain('api.resend');
      expect(source.toLowerCase(), file).not.toContain('resend.com');
    }
    const index = readFileSync(join(root, 'src', 'services', 'index.ts'), 'utf8');
    expect(index).toMatch(/export function getEmailTransport\(\): EmailTransport \| null \{\s*return null;/);
    // The idempotency key shape is part of the contract.
    expect(ticketConfirmationIdempotencyKey('ord_x')).toBe('ampedup:ticket-confirmation:v1:ord_x');
  });
});

interface PngChunk {
  type: string;
  data: Uint8Array;
}

function parsePngChunks(bytes: Uint8Array): PngChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const storedCrc = view.getUint32(offset + 8 + length);
    expect(storedCrc).toBe(crc32(bytes.subarray(offset + 4, offset + 8 + length)));
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const decompressor = new DecompressionStream('deflate');
  const writer = decompressor.writable.getWriter();
  // Consume the reader concurrently with the write; awaiting the write first
  // deadlocks once the output outgrows the internal queue.
  const output = (async () => {
    const parts: Uint8Array[] = [];
    const reader = decompressor.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return joined;
  })();
  await writer.write(copy);
  await writer.close();
  return output;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
