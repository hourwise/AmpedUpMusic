/**
 * POST /api/checkout/orders - create the order and the SumUp Hosted Checkout
 * (AMPED-06A, wired to the live provider in AMPED-07B).
 *
 * Public route (checkout is for customers, not operators, so it is not under
 * /api/admin). The body only identifies what the customer wants; prices, names,
 * totals, the reference and every state value are derived server-side from D1.
 * Unknown fields are rejected.
 *
 * MONEY AUTHORITY
 * The browser cannot influence what is charged. It sends ticket type ids,
 * quantities and contact details; the order service recomputes the total from
 * D1 and that recomputed total is what reaches SumUp. An `amount`, `total`,
 * `currency` or `checkoutReference` in the body is rejected outright by the
 * field allowlist rather than ignored.
 *
 * REDIRECT AUTHORITY
 * The hosted checkout URL returned here comes only from the server-side
 * provider result, and the return URL sent to SumUp is derived from this
 * request's own origin - never from anything the caller supplied.
 */

import type { APIRoute } from 'astro';
import { getCheckout } from '@/services/index.ts';
import { ValidationError } from '@/lib/validation.ts';
import { PaymentConfigurationError, SumUpError } from '@/services/payments/sumup/types.ts';
import { fail, fromError, json, readJson } from '../admin/gigs/_respond.ts';

/** The local, non-authoritative pending page the customer comes back to. */
const RETURN_PATH = '/checkout/return';

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
  // Derived from the server's own request URL, not from the JSON body: the
  // customer must not be able to choose where a payment session returns to.
  const returnUrl = new URL(RETURN_PATH, request.url).toString();

  try {
    const { orders, provider } = getCheckout();
    const created = await orders.createOrder(input);
    const begun = await orders.beginPayment(created.orderId, provider, returnUrl);

    // Defence in depth: the redirect handed to a browser is always the
    // provider's own https URL. If it is ever anything else, refuse rather
    // than forward - the order simply stays awaiting_payment and expires.
    if (!isHttpsProviderUrl(begun.redirectUrl)) {
      return fail(503, 'checkout-unavailable');
    }

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
    // Provider and configuration failures are flattened to one safe message.
    // SumUp's status code, error body and our credentials never reach a
    // customer; the categorised SumUpError stays server-side for 07D.
    if (error instanceof PaymentConfigurationError || error instanceof SumUpError) {
      return fail(503, 'checkout-unavailable');
    }
    return fromError(error);
  }
};

/** A hosted checkout URL must be absolute https before a browser follows it. */
function isHttpsProviderUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
