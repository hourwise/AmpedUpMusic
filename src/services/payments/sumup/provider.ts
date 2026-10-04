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
 *    the hosted_checkout_url becomes `redirectUrl`. The checkout lifetime is
 *    computed ONCE before the request (injected clock + 30 minutes), sent as
 *    `valid_until`, and reused verbatim as `expiresAt` when SumUp omits it
 *    from the response (it is documented nullable). When SumUp does return a
 *    `valid_until` that value is authoritative, even if it differs from the
 *    requested one. There is deliberately no post-response clock read: that
 *    would reintroduce a second expiry boundary offset by network latency.
 *    This is the checkout window, never a payment timestamp.
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
  /**
   * Public HTTPS webhook callback, sent as SumUp's `return_url` (AMPED-07C1).
   *
   * Configuration, not a per-request value: it is a property of this
   * deployment, never of a customer's checkout, and the generic
   * `PaymentProvider` contract is deliberately left unwidened because of it.
   * Unset means the field is omitted rather than guessed.
   */
  webhookUrl?: string;
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
  private readonly webhookUrl: string | undefined;

  constructor(options: SumUpProviderOptions) {
    this.client = createSumUpClient(options);
    this.now = options.now ?? (() => new Date());
    this.webhookUrl = options.webhookUrl;
  }

  async createCheckout(input: {
    orderId: string;
    reference: string;
    amountInPence: number;
    currency: 'GBP';
    customerEmail: string;
    returnUrl: string;
  }): Promise<{ checkoutId: string; redirectUrl: string; expiresAt: string }> {
    // ONE expiry clock (AMPED-07B). The checkout lifetime is decided HERE,
    // before the network request, and sent to SumUp as `valid_until`. The same
    // value is the fallback if SumUp omits it from the response, so network
    // latency can never produce a second, later boundary than the one the
    // provider was asked for. Nothing recomputes `now` after the POST returns.
    const requestedExpiresAt = new Date(
      this.now().getTime() + SUMUP_HOSTED_CHECKOUT_MINUTES * 60_000,
    ).toISOString();

    const payload = await this.client.createCheckout({
      reference: input.reference,
      amountInPence: input.amountInPence,
      currency: input.currency,
      customerEmail: input.customerEmail,
      returnUrl: input.returnUrl,
      validUntil: requestedExpiresAt,
      ...(this.webhookUrl === undefined ? {} : { webhookUrl: this.webhookUrl }),
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

    // SumUp's own answer wins when it gives one - even if it differs from what
    // we asked for - because the hosted session really does expire when SumUp
    // says it does, and the local reservation must match that, not our wish.
    const validUntil = requiredString(payload.valid_until);
    const expiresAt = validUntil ?? requestedExpiresAt;

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
