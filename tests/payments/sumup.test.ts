/**
 * AMPED-07A - SumUp adapter tests.
 *
 * Every request is served by an injected fake fetch: no DNS, no network, no
 * credentials beyond obviously fake test values. The adapter is exercised
 * through the accepted PaymentProvider contract, including its error, timeout,
 * retry and malformed-response behaviour.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createSumUpPaymentProvider,
} from '../../src/services/payments/sumup/provider.ts';
import { penceToMajorUnits } from '../../src/services/payments/sumup/client.ts';
import {
  isAmbiguousProviderError,
  SumUpError,
  SUMUP_API_BASE,
  SUMUP_HOSTED_CHECKOUT_MINUTES,
} from '../../src/services/payments/sumup/types.ts';
import { createMockPaymentProvider } from '../../src/services/payments/mock.ts';
import type { PaymentProvider } from '../../src/services/contracts.ts';
import * as fixtures from './fixtures.ts';

vi.setConfig({ testTimeout: 30_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-09-24T12:30:00.000Z');

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Scripted fake fetch: captures requests and answers with the given steps. */
function fakeFetch(steps: Array<(captured: Captured) => Response | Promise<Response>>) {
  const captured: Captured[] = [];
  let index = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
    const entry: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    captured.push(entry);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return step!(entry);
  }) as typeof fetch;
  return { impl, captured, calls: () => index };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function providerWith(steps: Array<(captured: Captured) => Response | Promise<Response>>) {
  const { impl, captured, calls } = fakeFetch(steps);
  const provider = createSumUpPaymentProvider({
    apiKey: fixtures.FAKE_API_KEY,
    merchantCode: fixtures.FAKE_MERCHANT_CODE,
    fetchImpl: impl,
    now: () => NOW,
    sleep: async () => {},
  });
  return { provider, captured, calls };
}

const checkoutInput = {
  orderId: 'ord_test_1',
  reference: 'AMP-26-00001',
  amountInPence: 1000,
  currency: 'GBP' as const,
  customerEmail: 'buyer@example.com',
  returnUrl: 'https://example.com/checkout/return',
};

describe('AMPED-07A contract parity', () => {
  it('both providers satisfy the accepted PaymentProvider surface', () => {
    const mock: PaymentProvider = createMockPaymentProvider();
    const sumup: PaymentProvider = createSumUpPaymentProvider({
      apiKey: fixtures.FAKE_API_KEY,
      merchantCode: fixtures.FAKE_MERCHANT_CODE,
      fetchImpl: (async () => jsonResponse(fixtures.GET_PENDING)) as typeof fetch,
    });

    for (const provider of [mock, sumup]) {
      expect(typeof provider.createCheckout).toBe('function');
      expect(typeof provider.confirm).toBe('function');
      expect(typeof provider.verifyWebhook).toBe('function');
    }
    expect(mock.name).toBe('mock');
    expect(sumup.name).toBe('sumup');
  });

  it('keeps the payment contract independent of the later QR dependency', () => {
    const contracts = readFileSync(join(root, 'src', 'services', 'contracts.ts'), 'utf8');
    expect(contracts).toContain("readonly name: 'sumup' | 'mock';");
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@astrojs/cloudflare', 'astro', 'jose', 'qrcode-svg']);
  });
});

describe('AMPED-07A create checkout', () => {
  it('posts to the documented endpoint with bearer auth and hosted checkout', async () => {
    const { provider, captured } = providerWith([() => jsonResponse(fixtures.CREATE_PENDING)]);
    const result = await provider.createCheckout(checkoutInput);

    const request = captured[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${SUMUP_API_BASE}/v0.1/checkouts`);
    expect(request.headers.authorization).toBe(`Bearer ${fixtures.FAKE_API_KEY}`);
    expect(request.headers.accept).toBe('application/json');
    expect(request.headers['content-type']).toBe('application/json');

    const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
    expect(body.checkout_reference).toBe('AMP-26-00001');
    expect(body.amount).toBe(10);
    expect(body.currency).toBe('GBP');
    expect(body.merchant_code).toBe(fixtures.FAKE_MERCHANT_CODE);
    expect(body.hosted_checkout).toEqual({ enabled: true });
    // AMPED-07C1 separated these. `redirect_url` is where the PAYER's browser
    // goes; `return_url` is SumUp's BACKEND notification callback. AMPED-07A
    // sent the customer return page as both, which silently subscribed that
    // page as our webhook endpoint. With no webhook URL configured the field
    // is omitted entirely rather than defaulted to something that cannot
    // receive notifications.
    expect(body.redirect_url).toBe(checkoutInput.returnUrl);
    expect(body).not.toHaveProperty('return_url');

    // The key is never in the URL or the body.
    expect(request.url).not.toContain(fixtures.FAKE_API_KEY);
    expect(request.body ?? '').not.toContain(fixtures.FAKE_API_KEY);

    // Response mapping, tolerating SumUp's unknown extra field.
    expect(result.checkoutId).toBe(fixtures.FAKE_CHECKOUT_ID);
    expect(result.redirectUrl).toBe(fixtures.FAKE_HOSTED_URL);
    expect(result.expiresAt).toBe(fixtures.FAKE_VALID_UNTIL);
    expect(JSON.stringify(result)).not.toContain(fixtures.FAKE_API_KEY);
  });

  it('sends the configured webhook URL as return_url, separate from redirect_url', async () => {
    const { impl, captured } = fakeFetch([() => jsonResponse(fixtures.CREATE_PENDING)]);
    const provider = createSumUpPaymentProvider({
      apiKey: fixtures.FAKE_API_KEY,
      merchantCode: fixtures.FAKE_MERCHANT_CODE,
      fetchImpl: impl,
      now: () => NOW,
      webhookUrl: 'https://amped.test/api/webhooks/sumup',
    });
    await provider.createCheckout(checkoutInput);

    const body = JSON.parse(captured[0]!.body ?? '{}') as Record<string, unknown>;
    expect(body.return_url).toBe('https://amped.test/api/webhooks/sumup');
    expect(body.redirect_url).toBe(checkoutInput.returnUrl);
    expect(body.return_url).not.toBe(body.redirect_url);
  });

  it('converts pence to major units exactly', async () => {
    expect(penceToMajorUnits(1)).toBe(0.01);
    expect(penceToMajorUnits(10)).toBe(0.1);
    expect(penceToMajorUnits(101)).toBe(1.01);
    expect(penceToMajorUnits(1000)).toBe(10);

    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => penceToMajorUnits(bad)).toThrow(SumUpError);
    }

    const { provider, captured } = providerWith([() => jsonResponse(fixtures.CREATE_PENDING)]);
    await provider.createCheckout({ ...checkoutInput, amountInPence: 101 });
    const body = JSON.parse(captured[0]!.body ?? '{}') as { amount: number };
    expect(body.amount).toBe(1.01);
  });

  it('uses the documented hosted-checkout window when valid_until is absent', async () => {
    const { provider } = providerWith([() => jsonResponse(fixtures.CREATE_PENDING_NO_VALID_UNTIL)]);
    const result = await provider.createCheckout(checkoutInput);
    expect(result.expiresAt).toBe(
      new Date(NOW.getTime() + SUMUP_HOSTED_CHECKOUT_MINUTES * 60_000).toISOString(),
    );
  });

  it('rejects unusable creation responses without inventing a checkout', async () => {
    for (const fixture of [
      fixtures.CREATE_MISSING_ID,
      fixtures.CREATE_MISSING_URL,
      fixtures.CREATE_BAD_URL_TYPE,
    ]) {
      const { provider } = providerWith([() => jsonResponse(fixture)]);
      await expect(provider.createCheckout(checkoutInput)).rejects.toBeInstanceOf(SumUpError);
    }

    const { provider } = providerWith([() => jsonResponse(fixtures.BAD_JSON, 200)]);
    const error = await provider.createCheckout(checkoutInput).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SumUpError);
    expect(isAmbiguousProviderError(error)).toBe(true);
  });
});

describe('AMPED-07A confirm retrieval', () => {
  it.each([
    ['PENDING', 'pending', undefined],
    ['PAID', 'paid', fixtures.FAKE_PAID_AT],
    ['FAILED', 'failed', undefined],
    ['EXPIRED', 'failed', undefined],
  ] as const)('maps %s to %s', async (fixtureName, expectedStatus, expectedPaidAt) => {
    const fixture =
      fixtureName === 'PENDING'
        ? fixtures.GET_PENDING
        : fixtureName === 'PAID'
          ? fixtures.GET_PAID
          : fixtureName === 'FAILED'
            ? fixtures.GET_FAILED
            : fixtures.GET_EXPIRED;

    const { provider, captured } = providerWith([() => jsonResponse(fixture)]);
    const result = await provider.confirm(fixtures.FAKE_CHECKOUT_ID);

    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.url).toBe(`${SUMUP_API_BASE}/v0.1/checkouts/${fixtures.FAKE_CHECKOUT_ID}`);
    expect(captured[0]!.headers.authorization).toBe(`Bearer ${fixtures.FAKE_API_KEY}`);
    expect(result.status).toBe(expectedStatus);
    if (expectedPaidAt) expect(result.paidAt).toBe(expectedPaidAt);
    else expect(result).not.toHaveProperty('paidAt');
  });

  it('never maps an unknown or malformed status to paid or failed', async () => {
    for (const fixture of [
      fixtures.GET_UNKNOWN_STATUS,
      fixtures.GET_MISSING_STATUS,
      fixtures.GET_STATUS_NOT_STRING,
    ]) {
      const { provider } = providerWith([() => jsonResponse(fixture)]);
      const error = await provider.confirm(fixtures.FAKE_CHECKOUT_ID).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(SumUpError);
      expect((error as SumUpError).kind).toBe('protocol');
    }

    const { provider } = providerWith([() => jsonResponse(fixtures.BAD_JSON, 200)]);
    await expect(provider.confirm(fixtures.FAKE_CHECKOUT_ID)).rejects.toBeInstanceOf(SumUpError);
  });
});

describe('AMPED-07A HTTP errors, timeout and retries', () => {
  it('does not retry definitive errors', async () => {
    for (const [status, body] of [
      [400, fixtures.ERROR_400],
      [401, fixtures.ERROR_401],
      [404, fixtures.ERROR_404],
      [409, fixtures.ERROR_409],
    ] as const) {
      const { provider, calls } = providerWith([() => jsonResponse(body, status)]);
      await expect(provider.confirm(fixtures.FAKE_CHECKOUT_ID)).rejects.toBeInstanceOf(SumUpError);
      expect(calls(), `status ${status}`).toBe(1);
    }
  });

  it('retries transient GET failures boundedly and then succeeds', async () => {
    const { provider, calls } = providerWith([
      () => jsonResponse(fixtures.ERROR_429, 429),
      () => jsonResponse(fixtures.ERROR_500, 500),
      () => jsonResponse(fixtures.GET_PAID),
    ]);
    const result = await provider.confirm(fixtures.FAKE_CHECKOUT_ID);
    expect(result.status).toBe('paid');
    expect(calls()).toBe(3);
  });

  it('stops after the bounded retry budget', async () => {
    const { provider, calls } = providerWith([() => jsonResponse(fixtures.ERROR_500, 500)]);
    await expect(provider.confirm(fixtures.FAKE_CHECKOUT_ID)).rejects.toBeInstanceOf(SumUpError);
    // first attempt + two retries
    expect(calls()).toBe(3);

    const network = providerWith([
      () => {
        throw new TypeError('network down');
      },
    ]);
    await expect(network.provider.confirm(fixtures.FAKE_CHECKOUT_ID)).rejects.toMatchObject({
      kind: 'transport',
    });
    expect(network.calls()).toBe(3);
  });

  it('times out explicitly', async () => {
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as typeof fetch;

    const provider = createSumUpPaymentProvider({
      apiKey: fixtures.FAKE_API_KEY,
      merchantCode: fixtures.FAKE_MERCHANT_CODE,
      fetchImpl: hanging,
      timeoutMs: 5,
      sleep: async () => {},
    });
    await expect(provider.confirm(fixtures.FAKE_CHECKOUT_ID)).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('never blindly retries a timed-out creation POST', async () => {
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as typeof fetch;
    let calls = 0;
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return hanging(input, init);
    }) as typeof fetch;

    const provider = createSumUpPaymentProvider({
      apiKey: fixtures.FAKE_API_KEY,
      merchantCode: fixtures.FAKE_MERCHANT_CODE,
      fetchImpl: counting,
      timeoutMs: 5,
      sleep: async () => {},
    });
    const error = await provider.createCheckout(checkoutInput).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SumUpError);
    expect(isAmbiguousProviderError(error)).toBe(true);
    expect(calls).toBe(1);
  });

  it('does not retry a creation POST that failed with a transient status', async () => {
    const { provider, calls } = providerWith([() => jsonResponse(fixtures.ERROR_500, 500)]);
    await expect(provider.createCheckout(checkoutInput)).rejects.toBeInstanceOf(SumUpError);
    expect(calls()).toBe(1);
  });
});

describe('AMPED-07A webhook contract', () => {
  const provider = () =>
    createSumUpPaymentProvider({
      apiKey: fixtures.FAKE_API_KEY,
      merchantCode: fixtures.FAKE_MERCHANT_CODE,
      fetchImpl: (async () => jsonResponse({})) as typeof fetch,
    });

  it('parses only the documented checkout-status notification', async () => {
    const request = new Request('https://example.com/hooks/sumup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'CHECKOUT_STATUS_CHANGED', id: fixtures.FAKE_CHECKOUT_ID }),
    });
    expect(await provider().verifyWebhook(request)).toEqual({
      checkoutId: fixtures.FAKE_CHECKOUT_ID,
    });
  });

  it('tolerates unknown, malformed and unrelated notifications', async () => {
    const cases = [
      { event_type: 'SOMETHING_ELSE', id: fixtures.FAKE_CHECKOUT_ID },
      { event_type: 'CHECKOUT_STATUS_CHANGED' },
      { event_type: 'CHECKOUT_STATUS_CHANGED', id: 42 },
      [1, 2, 3],
    ];
    for (const body of cases) {
      const request = new Request('https://example.com/hooks/sumup', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      expect(await provider().verifyWebhook(request)).toBeNull();
    }

    const malformed = new Request('https://example.com/hooks/sumup', {
      method: 'POST',
      body: '{not json',
    });
    expect(await provider().verifyWebhook(malformed)).toBeNull();
  });

  it('implements no undocumented signature scheme', () => {
    const dir = join(root, 'src', 'services', 'payments', 'sumup');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/createHmac|X-SumUp-Signature|sumup-signature/i);
    }
  });
});

describe('AMPED-07A secret boundary', () => {
  it('keeps SumUp environment names out of the adapter and client code', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|astro|mjs|js)$/.test(entry)) files.push(full);
      }
    };
    walk(join(root, 'src'));

    // The env declaration and the service locator are the ONLY two files that
    // may name the secret variables. AMPED-07B added the locator, which reads
    // them once and hands them to the adapter as constructor input; every
    // component, page and client script still has no way to reach them, and
    // the adapter itself still takes credentials as arguments.
    const readers = files.filter((file) =>
      /SUMUP_API_KEY|SUMUP_MERCHANT_CODE/.test(readFileSync(file, 'utf8')),
    );
    expect(readers.map((file) => file.replaceAll('\\', '/').split('/src/')[1]).sort()).toEqual([
      'env.d.ts',
      'services/index.ts',
    ]);
  });

  it('documents placeholders only in .dev.vars.example', () => {
    const example = readFileSync(join(root, '.dev.vars.example'), 'utf8');
    expect(example).toContain('SUMUP_API_KEY=replace-with-development-sumup-api-key');
    expect(example).toContain('SUMUP_MERCHANT_CODE=replace-with-development-merchant-code');
    expect(example).not.toMatch(/sup_sk_[A-Za-z0-9]{10,}/);
  });
});
