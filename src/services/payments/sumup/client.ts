/**
 * Minimal SumUp REST client (AMPED-07A).
 *
 * Platform fetch only - no SDK, no dependency. The API key is held privately
 * and only ever sent as `Authorization: Bearer ...`; it never appears in a URL,
 * a body, a thrown message or a return value.
 *
 * Safety rules:
 *  - every request has an explicit timeout via AbortController;
 *  - GET retrieval may retry bounded transient failures (network, 429, 5xx);
 *  - creation POSTs are NEVER retried automatically: a timeout after sending
 *    one is an ambiguous outcome, so it surfaces as an ambiguous transport
 *    failure for later reconciliation instead of risking a duplicate checkout;
 *  - 400/401/403/404 are definitive and never retried.
 */

import {
  SUMUP_API_BASE,
  SUMUP_MAX_GET_RETRIES,
  SUMUP_TIMEOUT_MS,
  SumUpError,
  type SumUpCheckoutPayload,
} from './types.ts';

export interface SumUpTransportOptions {
  /** Injection seam for tests; production uses the platform fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxGetRetries?: number;
  /** Injection seam so tests never sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Internal-only base URL override (tests); never environment-driven. */
  apiBase?: string;
}

export interface SumUpClientOptions extends SumUpTransportOptions {
  apiKey: string;
  merchantCode: string;
}

export interface CreateCheckoutRequest {
  reference: string;
  amountInPence: number;
  currency: 'GBP';
  customerEmail: string;
  returnUrl: string;
  /**
   * The checkout lifetime, decided by the caller BEFORE this request is sent
   * (AMPED-07B). It is transmitted as `valid_until` so that SumUp's session
   * and the local reservation share one boundary rather than two independent
   * 30-minute clocks separated by network latency.
   */
  validUntil: string;
  /**
   * The BACKEND webhook callback, sent as `return_url` (AMPED-07C1).
   *
   * Omitted entirely when not configured. SumUp treats `return_url` as the
   * notification subscription, so sending a wrong one is worse than sending
   * none: it would point status updates at a page that cannot process them.
   */
  webhookUrl?: string;
}

export interface SumUpClient {
  createCheckout(input: CreateCheckoutRequest): Promise<SumUpCheckoutPayload>;
  getCheckout(checkoutId: string): Promise<SumUpCheckoutPayload>;
}

/** 1 pence -> 0.01 major units; input must be a safe non-negative integer. */
export function penceToMajorUnits(pence: number): number {
  if (!Number.isSafeInteger(pence) || pence < 0) {
    throw new SumUpError('protocol', 'The amount to charge was not valid.');
  }
  return Number((pence / 100).toFixed(2));
}

class SumUpRestClient implements SumUpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxGetRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly apiBase: string;

  constructor(
    private readonly apiKey: string,
    private readonly merchantCode: string,
    options: SumUpTransportOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? SUMUP_TIMEOUT_MS;
    this.maxGetRetries = options.maxGetRetries ?? SUMUP_MAX_GET_RETRIES;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.apiBase = options.apiBase ?? SUMUP_API_BASE;
  }

  async createCheckout(input: CreateCheckoutRequest): Promise<SumUpCheckoutPayload> {
    const body = {
      checkout_reference: input.reference,
      amount: penceToMajorUnits(input.amountInPence),
      currency: input.currency,
      merchant_code: this.merchantCode,
      // The two URLs are DIFFERENT things and AMPED-07B had them inverted by
      // sending the customer return page as both. Per the current API
      // reference: `redirect_url` is "URL where the payer should be sent",
      // `return_url` is the "backend callback URL used by SumUp to notify
      // your platform". Giving the browser destination to both subscribed
      // our customer-facing return page as the webhook endpoint.
      redirect_url: input.returnUrl,
      ...(input.webhookUrl === undefined ? {} : { return_url: input.webhookUrl }),
      valid_until: input.validUntil,
      hosted_checkout: { enabled: true },
    };

    const response = await this.request('POST', '/v0.1/checkouts', body);
    try {
      return await this.readJson(response, 'SumUp did not return a usable checkout response.');
    } catch (error) {
      // The checkout may exist even though its response was unreadable.
      if (error instanceof SumUpError && error.kind === 'protocol') {
        throw new SumUpError('protocol', error.message, undefined, true);
      }
      throw error;
    }
  }

  async getCheckout(checkoutId: string): Promise<SumUpCheckoutPayload> {
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.request('GET', `/v0.1/checkouts/${encodeURIComponent(checkoutId)}`);
        return this.readJson(response, 'SumUp did not return a usable checkout response.');
      } catch (error) {
        if (attempt >= this.maxGetRetries || !isTransient(error)) throw error;
        const delay = error instanceof SumUpError && error.status === 429 ? 0 : 250 * 2 ** attempt;
        attempt += 1;
        if (delay > 0) await this.sleep(delay);
      }
    }
  }

  /** One HTTP exchange with explicit timeout and controlled failures. */
  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const creating = method === 'POST';

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      // A creation POST that timed out may still have reached SumUp.
      throw new SumUpError(
        aborted ? 'timeout' : 'transport',
        aborted ? 'SumUp did not respond in time.' : 'SumUp could not be reached.',
        undefined,
        creating,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const transient = response.status === 429 || response.status >= 500;
      throw new SumUpError(
        'http',
        `SumUp rejected the request (HTTP ${response.status}).`,
        response.status,
        consumingAmbiguous(creating, transient),
      );
    }
    return response;
  }

  private async readJson(response: Response, message: string): Promise<SumUpCheckoutPayload> {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new SumUpError('protocol', message);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SumUpError('protocol', message);
    }
    return parsed as SumUpCheckoutPayload;
  }
}

/** A creation POST that failed transiently may still have created a checkout. */
function consumingAmbiguous(creating: boolean, transient: boolean): boolean {
  return creating && transient;
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof SumUpError)) return false;
  if (error.kind === 'transport' || error.kind === 'timeout') return true;
  return error.status === 429 || (error.status !== undefined && error.status >= 500);
}

/** Build a SumUp client for one merchant's API key. */
export function createSumUpClient(options: SumUpClientOptions): SumUpClient {
  return new SumUpRestClient(options.apiKey, options.merchantCode, options);
}
