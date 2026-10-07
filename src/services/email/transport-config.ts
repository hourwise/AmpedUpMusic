/**
 * Email transport selection (AMPED-08C2).
 *
 * The runtime chooses its transport from explicit configuration and nothing
 * else. There is deliberately no silent fallback: a runtime that requested
 * Resend but lacks a usable key or sender does NOT quietly switch to a
 * console or mock transport — it selects no transport at all. The scheduled
 * pass then identifies work and sends nothing, the deliveries stay pending,
 * and one structured warning names the problem. Fixing the configuration is
 * what makes sending possible again; nothing already recorded is corrupted.
 *
 * PROVIDER VALUES
 *  - unset / empty      no external transport (the 08C1 identify-only mode)
 *  - `console` or `none` the same, stated explicitly for local development
 *  - `resend`           the Resend adapter; requires RESEND_API_KEY and a
 *                       plausible EMAIL_FROM, otherwise fail closed
 *  - anything else      fail closed and warn; never a guess
 *
 * Selecting `resend` does NOT assert that the sender domain is verified with
 * the provider. Domain verification (DNS/SPF/DKIM) is an external,
 * operator-controlled state this application cannot observe; the adapter's
 * classification reports what the provider actually answers.
 */

import { createResendTransport } from './resend.ts';
import type { EmailTransport } from './transport.ts';

/** The environment variables that decide how ticket email leaves the Worker. */
export interface EmailSettings {
  EMAIL_PROVIDER?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  EMAIL_FROM?: string | undefined;
  EMAIL_REPLY_TO?: string | undefined;
}

export interface EmailTransportSelection {
  transport: EmailTransport | null;
  /**
   * Non-null only when a provider was requested and the configuration is
   * unsafe. Safe to log: it contains no secrets.
   */
  issue: string | null;
}

export interface EmailTransportOptions {
  /** Injected HTTP boundary for the adapter; tests always supply one. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function resolveEmailTransport(
  settings: EmailSettings,
  options: EmailTransportOptions = {},
): EmailTransportSelection {
  const provider = settings.EMAIL_PROVIDER?.trim().toLowerCase() ?? '';

  if (provider === '' || provider === 'console' || provider === 'none') {
    return { transport: null, issue: null };
  }

  if (provider !== 'resend') {
    return { transport: null, issue: `unknown_provider:${provider.slice(0, 40)}` };
  }

  const apiKey = settings.RESEND_API_KEY?.trim() ?? '';
  const from = settings.EMAIL_FROM?.trim() ?? '';
  if (!apiKey || !isPlausibleSender(from)) {
    return { transport: null, issue: 'resend_incomplete_config' };
  }

  const replyTo = settings.EMAIL_REPLY_TO?.trim();
  return {
    transport: createResendTransport({
      apiKey,
      from,
      ...(replyTo ? { replyTo } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }),
    issue: null,
  };
}

/** Conservative sanity check; does not attempt to validate RFC 5322. */
function isPlausibleSender(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 320 &&
    value.includes('@') &&
    !value.includes('\n') &&
    !value.includes('\r')
  );
}
