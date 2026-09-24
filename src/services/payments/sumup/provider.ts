/**
 * SumUpPaymentProvider (AMPED-07A).
 *
 * Implements the accepted `PaymentProvider` contract exactly, so order code
 * needs no SumUp-specific branch and the mock remains swappable. This slice
 * makes no live call in tests and adds no order/DB behaviour - the wiring and
 * webhook flow belong to AMPED-07B/07C.
 *
 * Mapping decisions:
 *  - createCheckout -> POST /v0.1/checkouts with hosted_checkout.enabled=true;
 *    the hosted_checkout_url becomes `redirectUrl`. `expiresAt` uses SumUp's
 *    `valid_until`; when SumUp omits it (it is documented nullable) the
 *    documented 30-minute hosted-checkout lifetime is used, derived from the
 *    injected clock - this is the checkout window, never a payment timestamp.
 *  - confirm -> GET /v0.1/checkouts/{id}: PENDING -> pending, PAID -> paid,
 *    FAILED and EXPIRED -> failed (the accepted contract's definitive failure,
 *    which the order service turns into `expired`).
 *  - paidAt comes only from a SUCCESSFUL transaction's own timestamp; it is
 *    omitted rather than fabricated when SumUp does not supply one.
 *  - an unknown status or malformed payload raises a controlled protocol error
 *    instead of being classified as paid or failed, so an order can never be
 *    moved or have stock released on data we could not understand.
 *  - verifyWebhook parses the documented notification shape
 *    ({ event_type: 'CHECKOUT_STATUS_CHANGED', id }) and returns the checkout
 *    id. It does NOT claim cryptographic authenticity: current SumUp guidance
 *    treats webhooks as notifications and requires authoritative retrieval,
 *    which is exactly what `confirm()` does. Unknown event types return null.
 */

import type { PaymentProvider } from '../../contracts.ts';
import { createSumUpClient, type SumUpClient, type SumUpTransportOptions } from './client.ts';
import {
  SUMUP_HOSTED_CHECKOUT_MINUTES,
  SumUpError,
  type SumUpCheckoutPayload,
} from './types.ts';

export interface SumUpProviderOptions extends SumUpTransportOptions {
  apiKey: string;
  merchantCode: string;
  now?: () => Date;
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Map a retrieved checkout to the accepted contract result.
 * Unknown or malformed input raises rather than guessing.
 */
export function mapCheckoutToProviderResult(payload: SumUpCheckoutPayload): {
  status: 'paid' | 'pending' | 'failed';
  paidAt?: string;
} {
  const status = payload.status;
  if (typeof status !== 'string') {
    throw new SumUpError('protocol', 'SumUp did not report a checkout status.');
  }

  switch (status) {
    case 'PENDING':
      return { status: 'pending' };
    case 'FAILED':
    case 'EXPIRED':
      return { status: 'failed' };
    case 'PAID': {
      const paidAt = successfulTransactionTimestamp(payload);
      return paidAt ? { status: 'paid', paidAt } : { status: 'paid' };
    }
    default:
      // A future status must never be treated as paid or as a failure.
      throw new SumUpError('protocol', 'SumUp reported a status this application does not recognise.');
  }
}

/** The timestamp of a SUCCESSFUL transaction, when SumUp provides one. */
function successfulTransactionTimestamp(payload: SumUpCheckoutPayload): string | null {
  if (!Array.isArray(payload.transactions)) return null;
  for (const entry of payload.transactions) {
    if (entry === null || typeof entry !== 'object') continue;
    const transaction = entry as Record<string, unknown>;
    if (transaction.status !== 'SUCCESSFUL') continue;
    const timestamp = requiredString(transaction.timestamp);
    if (timestamp) return timestamp;
  }
  return null;
}

class SumUpPaymentProvider implements PaymentProvider {
  readonly name = 'sumup' as const;
  private readonly client: SumUpClient;
  private readonly now: () => Date;

  constructor(options: SumUpProviderOptions) {
    this.client = createSumUpClient(options);
    this.now = options.now ?? (() => new Date());
  }

  async createCheckout(input: {
    orderId: string;
    reference: string;
    amountInPence: number;
    currency: 'GBP';
    customerEmail: string;
    returnUrl: string;
  }): Promise<{ checkoutId: string; redirectUrl: string; expiresAt: string }> {
    const payload = await this.client.createCheckout({
      reference: input.reference,
      amountInPence: input.amountInPence,
      currency: input.currency,
      customerEmail: input.customerEmail,
      returnUrl: input.returnUrl,
    });

    const checkoutId = requiredString(payload.id);
    const redirectUrl = requiredString(payload.hosted_checkout_url);
    if (!checkoutId || !redirectUrl) {
      // Unreadable/unnamed creation is ambiguous: the checkout may exist.
      throw new SumUpError(
        'protocol',
        'SumUp did not return a usable hosted checkout.',
        undefined,
        true,
      );
    }

    const validUntil = requiredString(payload.valid_until);
    const expiresAt =
      validUntil ??
      new Date(this.now().getTime() + SUMUP_HOSTED_CHECKOUT_MINUTES * 60_000).toISOString();

    return { checkoutId, redirectUrl, expiresAt };
  }

  async confirm(checkoutId: string): Promise<{ status: 'paid' | 'pending' | 'failed'; paidAt?: string }> {
    return mapCheckoutToProviderResult(await this.client.getCheckout(checkoutId));
  }

  async verifyWebhook(request: Request): Promise<{ checkoutId: string } | null> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return null;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;

    const notification = body as Record<string, unknown>;
    // Only the documented checkout-status notification is understood; anything
    // else is ignored rather than guessed at. This is parsing, not proof of
    // authenticity - callers must confirm through the API (07C).
    if (notification.event_type !== 'CHECKOUT_STATUS_CHANGED') return null;
    const id = requiredString(notification.id);
    return id ? { checkoutId: id } : null;
  }
}

/** Build the SumUp provider against explicit server-side credentials. */
export function createSumUpPaymentProvider(options: SumUpProviderOptions): PaymentProvider {
  return new SumUpPaymentProvider(options);
}
