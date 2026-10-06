/**
 * Provider-independent ticket-confirmation rendering (AMPED-08C1).
 *
 * The payload snapshot is the contract. It is built once, when the delivery
 * intent is created, from the data current at that moment — the event and
 * venue details are frozen AT CONFIRMATION CREATION TIME, not at purchase:
 * the order schema never captured them at purchase, so calling them
 * purchase-time facts would be a lie. Every retry renders the same stored
 * payload, so a later edit to a gig or a venue cannot silently rewrite a
 * queued message.
 *
 * Rendering is a pure function of (payload, signing keys). It performs no I/O,
 * calls no provider, reads no clock and uses no randomness, so re-rendering
 * the same intent produces semantically identical content.
 *
 * The QR PNGs are generated locally (see ./qr-png.ts) from the already-issued
 * 08B credentials. This module signs with the existing ticket token service;
 * it never creates a credential and never touches the signing secret beyond
 * handing it to that service.
 */

import { formatFullDate, formatTime } from '@/lib/dates.ts';
import { AGE_RESTRICTION_LABEL } from '@/lib/text.ts';
import { SITE } from '@/lib/site.ts';
import type { AgeRestriction } from '@/types/domain.ts';
import type { TicketTokenService } from '../tickets/token.ts';
import { bytesToBase64, renderTicketQrPng } from './qr-png.ts';

export const TICKET_CONFIRMATION_MESSAGE_TYPE = 'ticket-confirmation';
export const TICKET_CONFIRMATION_VERSION = 1;
export const TICKET_CONFIRMATION_TEMPLATE = 'ticket-confirmation.v1';

/**
 * The ticket contact address frozen into every payload. Read from the single
 * site constant so the queue can never drift from the published address.
 */
export const TICKET_CONFIRMATION_CONTACT_EMAIL = SITE.ticketsEmail;

/** `ampedup:ticket-confirmation:v1:<order-id>` (AMPED-08C1 requirement 10). */
export function ticketConfirmationIdempotencyKey(orderId: string): string {
  return `ampedup:${TICKET_CONFIRMATION_MESSAGE_TYPE}:v${TICKET_CONFIRMATION_VERSION}:${orderId}`;
}

/** The frozen attachment-time snapshot of one ticket in the message. */
export interface TicketConfirmationTicket {
  ticketId: string;
  reference: string;
  /** The immutable purchased name where available, from the order item. */
  ticketTypeName: string;
  credentialId: string;
}

export interface TicketConfirmationPayload {
  messageType: typeof TICKET_CONFIRMATION_MESSAGE_TYPE;
  version: typeof TICKET_CONFIRMATION_VERSION;
  template: typeof TICKET_CONFIRMATION_TEMPLATE;
  orderReference: string;
  recipient: string;
  event: {
    title: string;
    doorsAt: string;
    startsAt: string;
    ageRestriction: AgeRestriction;
    /** The presentation basis: all times are formatted in this zone. */
    timeZone: 'Europe/London';
  };
  venue: {
    name: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    postcode: string;
  };
  /** Every durable ticket in the order, in stable order. */
  tickets: TicketConfirmationTicket[];
  /** Frozen too: a later site-config change must not alter a queued message. */
  contactEmail: string;
}

/** Canonical JSON for storage and hashing. Key order is construction order. */
export function canonicalPayloadJson(payload: TicketConfirmationPayload): string {
  return JSON.stringify(payload);
}

/** SHA-256 of the exact stored payload text, lowercase hex. */
export async function payloadHash(payloadJson: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payloadJson));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Shape check for a payload read back from the outbox. */
export function isTicketConfirmationPayload(value: unknown): value is TicketConfirmationPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Partial<TicketConfirmationPayload>;
  if (
    payload.messageType !== TICKET_CONFIRMATION_MESSAGE_TYPE ||
    payload.version !== TICKET_CONFIRMATION_VERSION ||
    typeof payload.orderReference !== 'string' ||
    typeof payload.recipient !== 'string' ||
    typeof payload.event?.title !== 'string' ||
    typeof payload.event?.startsAt !== 'string' ||
    typeof payload.event?.doorsAt !== 'string' ||
    typeof payload.venue?.name !== 'string' ||
    typeof payload.contactEmail !== 'string' ||
    !Array.isArray(payload.tickets) ||
    payload.tickets.length === 0
  ) {
    return false;
  }
  return payload.tickets.every(
    (ticket) =>
      typeof ticket?.ticketId === 'string' &&
      typeof ticket?.reference === 'string' &&
      typeof ticket?.credentialId === 'string' &&
      typeof ticket?.ticketTypeName === 'string',
  );
}

export interface RenderedEmailAttachment {
  filename: string;
  /** RFC 2392 content id without angle brackets; HTML uses `cid:<id>`. */
  contentId: string;
  mimeType: 'image/png';
  contentBase64: string;
}

export interface RenderedTicketConfirmation {
  subject: string;
  text: string;
  html: string;
  attachments: RenderedEmailAttachment[];
}

/** Deterministic filename for a ticket's QR attachment. */
export function qrAttachmentFilename(reference: string): string {
  return `qr-${reference.toLowerCase()}.png`;
}

/** Deterministic RFC 2392 content id for a ticket's QR attachment. */
export function qrAttachmentContentId(reference: string): string {
  return `qr-${reference.toLowerCase()}@${SITE.url.replace(/^https?:\/\//, '')}`;
}

export async function renderTicketConfirmation(
  payload: TicketConfirmationPayload,
  tokens: TicketTokenService,
): Promise<RenderedTicketConfirmation> {
  const dateLabel = formatFullDate(payload.event.startsAt);
  const doorsLabel = formatTime(payload.event.doorsAt);
  const startsLabel = formatTime(payload.event.startsAt);
  const venueAddressLines = venueAddress(payload);
  const admission =
    payload.event.ageRestriction === 'all-ages'
      ? null
      : `Admission: ${AGE_RESTRICTION_LABEL[payload.event.ageRestriction]}`;

  const attachments: RenderedEmailAttachment[] = [];
  for (const ticket of payload.tickets) {
    // Reuse the accepted 08B signer. The credential already exists; this
    // step must never create or replace one.
    const token = await tokens.sign(ticket.credentialId);
    const png = await renderTicketQrPng(token);
    attachments.push({
      filename: qrAttachmentFilename(ticket.reference),
      contentId: qrAttachmentContentId(ticket.reference),
      mimeType: 'image/png',
      contentBase64: bytesToBase64(png),
    });
  }

  const subject = `Your tickets for ${payload.event.title} (order ${payload.orderReference})`;

  const ticketLines = payload.tickets.map(
    (ticket, index) =>
      `  ${index + 1}. ${ticket.reference} - ${ticket.ticketTypeName} (attached: ${qrAttachmentFilename(ticket.reference)})`,
  );

  const text = [
    'Amped Up Music Promotions',
    '',
    'Thanks - your tickets are below, and each QR code is attached to this email.',
    '',
    payload.event.title,
    `${dateLabel}, doors ${doorsLabel}, live music from ${startsLabel}.`,
    payload.venue.name,
    ...venueAddressLines,
    ...(admission ? ['', admission] : []),
    '',
    `Order reference: ${payload.orderReference}`,
    '',
    `Your tickets (${payload.tickets.length}):`,
    ...ticketLines,
    '',
    'Show the QR codes on your phone or print them out.',
    'If a QR code will not scan, the door can find your order by name, email address',
    'or the order reference above.',
    '',
    `Questions? Contact ${payload.contactEmail}.`,
    '',
  ].join('\n');

  const htmlTicketItems = payload.tickets
    .map((ticket) =>
      [
        '        <li>',
        `          <p>${escapeHtml(ticket.reference)} - ${escapeHtml(ticket.ticketTypeName)}</p>`,
        `          <img src="cid:${escapeHtml(qrAttachmentContentId(ticket.reference))}" alt="QR code for ticket ${escapeHtml(ticket.reference)}" width="200" height="200" />`,
        '        </li>',
      ].join('\n'),
    )
    .join('\n');

  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    `    <title>${escapeHtml(subject)}</title>`,
    '  </head>',
    '  <body>',
    '    <p>Amped Up Music Promotions</p>',
    `    <h1>Your tickets for ${escapeHtml(payload.event.title)}</h1>`,
    '    <p>Thanks - your tickets are below, and each QR code is attached to this email.</p>',
    `    <p><strong>${escapeHtml(dateLabel)}</strong><br />Doors ${escapeHtml(doorsLabel)}, live music from ${escapeHtml(startsLabel)}.</p>`,
    `    <p><strong>${escapeHtml(payload.venue.name)}</strong><br />${venueAddressLines.map(escapeHtml).join('<br />')}</p>`,
    ...(admission ? [`    <p>${escapeHtml(admission)}</p>`] : []),
    `    <p>Order reference: <strong>${escapeHtml(payload.orderReference)}</strong></p>`,
    `    <ul>`,
    htmlTicketItems,
    `    </ul>`,
    '    <p>Show the QR codes on your phone or print them out. If a QR code will not scan, the door can find your order by name, email address or the order reference above.</p>',
    `    <p>Questions? Contact <a href="mailto:${escapeHtml(payload.contactEmail)}">${escapeHtml(payload.contactEmail)}</a>.</p>`,
    '  </body>',
    '</html>',
  ].join('\n');

  return { subject, text, html, attachments };
}

function venueAddress(payload: TicketConfirmationPayload): string[] {
  const { addressLine1, addressLine2, city, postcode } = payload.venue;
  return [addressLine1, addressLine2, `${city} ${postcode}`.trim()].filter(
    (line): line is string => typeof line === 'string' && line.length > 0,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
