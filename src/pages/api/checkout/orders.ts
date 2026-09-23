/**
 * POST /api/checkout/orders - start a mock checkout (AMPED-06A).
 *
 * Public route (checkout is for customers, not operators, so it is not under
 * /api/admin). The body only identifies what the customer wants; prices, names,
 * totals, the reference and every state value are derived server-side from D1.
 * Unknown fields are rejected.
 *
 * The response includes the mock provider's checkout details. No real payment
 * network, credential or SumUp code is involved.
 */

import type { APIRoute } from 'astro';
import { getCheckout } from '@/services/index.ts';
import { ValidationError } from '@/lib/validation.ts';
import { fail, fromError, json, readJson } from '../admin/gigs/_respond.ts';

const ALLOWED = ['eventId', 'items', 'customerName', 'customerEmail', 'customerPhone', 'marketingOptIn'];

interface ParsedOrderRequest {
  eventId: string;
  items: Array<{ ticketTypeId: string; quantity: number }>;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  marketingOptIn: boolean;
}

function parse(
  body: Record<string, unknown>,
): { ok: true; value: ParsedOrderRequest } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  for (const key of Object.keys(body)) {
    if (!ALLOWED.includes(key)) fields[key] = 'Unsupported field.';
  }

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
  if (!eventId) fields.eventId = 'Choose a gig.';

  const customerName = typeof body.customerName === 'string' ? body.customerName.trim() : '';
  if (customerName.length < 2) fields.customerName = 'Enter your name.';

  const customerEmail = typeof body.customerEmail === 'string' ? body.customerEmail.trim() : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) fields.customerEmail = 'Enter a valid email address.';

  if (!Array.isArray(body.items) || body.items.length === 0) {
    fields.items = 'Choose at least one ticket.';
  }
  const items = Array.isArray(body.items)
    ? body.items.map((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>;
        for (const key of Object.keys(item)) {
          if (key !== 'ticketTypeId' && key !== 'quantity') fields.items = 'Unsupported ticket field.';
        }
        return {
          ticketTypeId: typeof item.ticketTypeId === 'string' ? item.ticketTypeId : '',
          quantity: typeof item.quantity === 'number' ? item.quantity : Number.NaN,
        };
      })
    : [];

  if (Object.values(fields).some(Boolean)) return { ok: false, fields };

  const customerPhone = typeof body.customerPhone === 'string' ? body.customerPhone.trim() : '';
  return {
    ok: true,
    value: {
      eventId,
      items,
      customerName,
      customerEmail,
      ...(customerPhone ? { customerPhone } : {}),
      marketingOptIn: body.marketingOptIn === true,
    },
  };
}

export const POST: APIRoute = async ({ request }) => {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const parsed = parse(body);
  if (!parsed.ok) return fail(400, 'invalid', parsed.fields);

  const input = parsed.value;
  try {
    const { orders, provider } = getCheckout();
    const created = await orders.createOrder(input);
    const begun = await orders.beginPayment(created.orderId, provider);
    return json(
      {
        ok: true,
        orderId: created.orderId,
        reference: created.reference,
        totalInPence: created.totalInPence,
        checkoutId: begun.checkoutId,
        redirectUrl: begun.redirectUrl,
        expiresAt: begun.expiresAt,
      },
      201,
    );
  } catch (error) {
    if (error instanceof ValidationError) return fail(400, 'invalid', error.fields);
    return fromError(error);
  }
};
