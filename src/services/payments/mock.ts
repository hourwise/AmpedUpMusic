/**
 * MockPaymentProvider (AMPED-06A).
 *
 * Implements the accepted `PaymentProvider` contract exactly, so the SumUp
 * adapter in AMPED-07A can replace it without touching callers. It makes no
 * network calls, needs no credentials, and is fully deterministic: the outcome
 * is configured per instance, and "slow" is represented by an injected gate
 * promise rather than a wall-clock sleep, so tests never wait on real time.
 *
 * The contract's `confirm()` is the only authority that can report `paid` -
 * exactly as the real provider will be.
 */

import type { PaymentProvider } from '../contracts.ts';

export type MockOutcome = 'paid' | 'pending' | 'failed';

export interface MockPaymentProviderOptions {
  /** Fixed outcome, or a function so tests can change it between calls. */
  outcome?: MockOutcome | (() => MockOutcome);
  /** Optional gate: `confirm()` waits for this before answering. */
  gate?: Promise<void>;
  /** Clock seam for `paidAt` and checkout expiry. */
  now?: () => Date;
  /** Id seam so checkout ids are deterministic in tests. */
  newId?: () => string;
  /** Simulated webhook verification result; null (invalid) by default. */
  webhook?: (request: Request) => Promise<{ checkoutId: string } | null>;
}

/** Hosted checkout sessions last 30 minutes, matching the reservation design. */
export const CHECKOUT_WINDOW_MINUTES = 30;

export function createMockPaymentProvider(
  options: MockPaymentProviderOptions = {},
): PaymentProvider {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  let counter = 0;

  const outcomeFor = (): MockOutcome => {
    const outcome = options.outcome ?? 'paid';
    return typeof outcome === 'function' ? outcome() : outcome;
  };

  return {
    name: 'mock',

    async createCheckout(input) {
      const expiresAt = new Date(now().getTime() + CHECKOUT_WINDOW_MINUTES * 60_000).toISOString();
      counter += 1;
      const checkoutId = `mock_${newId()}_${counter}`;
      // A real provider returns an external URL; the mock returns a local path
      // so nothing ever leaves the site.
      const redirectUrl = `/checkout/mock?checkout=${encodeURIComponent(checkoutId)}&order=${encodeURIComponent(input.reference)}`;
      return { checkoutId, redirectUrl, expiresAt };
    },

    async confirm(checkoutId) {
      if (!checkoutId) return { status: 'failed' as const };
      if (options.gate) await options.gate;
      const outcome = outcomeFor();
      if (outcome === 'paid') return { status: 'paid', paidAt: now().toISOString() };
      return { status: outcome };
    },

    async verifyWebhook(request) {
      return options.webhook ? options.webhook(request) : null;
    },
  };
}
