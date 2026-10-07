/// <reference types="astro/client" />

/**
 * Cloudflare bindings and secrets.
 *
 * AMPED-01 declares the shape only. None of these resources exist yet and
 * nothing in the scaffold reads them: `getServices()` currently returns
 * fixture repositories and touches no binding at all.
 *
 * ACCESS PATTERN (Astro 7 / @astrojs/cloudflare 14)
 * `Astro.locals.runtime.env` has been removed. Bindings are read inside
 * server-only modules with `import { env } from 'cloudflare:workers'`, so
 * src/services/index.ts is the single place that will ever touch them.
 *
 * Once real bindings exist, `npx wrangler types` generates a
 * worker-configuration.d.ts from wrangler.jsonc and this hand-written Env can
 * be replaced by it. Until then this file documents the intended surface and
 * which slice creates each entry.
 */
interface Env {
  /** Static assets binding, created by the adapter. */
  ASSETS: Fetcher;
  /** "development" | "staging" | "production" */
  AMPED_ENV: string;

  // AMPED-02A - Cloudflare D1.
  // Required, not optional: once the binding exists, a missing one is a
  // misconfiguration rather than a supported "no database" mode. Nothing in
  // the application reads it yet - the fixture services still serve every
  // page - but from AMPED-02B onwards a feature that needs the database must
  // fail loudly rather than quietly fall back to fixtures.
  DB: D1Database;
  // AMPED-05A - Cloudflare R2 for posters, heroes and galleries
  MEDIA?: R2Bucket;
  // AMPED-06B - short-lived ticket reservations
  RESERVATIONS?: KVNamespace;

  // AMPED-04A - Cloudflare Access origin verification. Non-secret config,
  // supplied by the supervisor once a development Access application exists.
  // Leaving either unset is safe: public routes are unaffected and the protected
  // namespaces fail closed.
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;

  // --- Secrets. Server-side only; never referenced from client code. -------
  // AMPED-07 - SumUp Hosted Checkout
  SUMUP_API_KEY?: string;
  SUMUP_MERCHANT_CODE?: string;
  // AMPED-07C1 - public HTTPS callback sent to SumUp as `return_url`.
  // NOT a secret: it is a URL, and it is listed here only because the service
  // locator reads it alongside the credentials. Unset means `return_url` is
  // omitted from checkout creation entirely.
  //
  // There is deliberately no SUMUP_WEBHOOK_SECRET. The original build plan
  // assumed a signed webhook; SumUp documents no signature, HMAC, shared
  // secret, timestamp or delivery id for Online Payments notifications, and
  // instructs integrators to verify by retrieving the checkout over the
  // authenticated API instead. Keeping an unused secret here would have
  // implied a verification mechanism this application does not - and cannot -
  // perform.
  SUMUP_WEBHOOK_URL?: string;
  // AMPED-08C - transactional email.
  // `EMAIL_PROVIDER` selects the transport: unset, blank, `console` or `none`
  // means no external transport (deliveries are recorded and wait). `resend`
  // selects the Resend adapter and requires RESEND_API_KEY and EMAIL_FROM; a
  // requested-but-incomplete configuration fails closed with no transport —
  // there is never a silent fallback to a console or mock transport.
  // Selecting `resend` does not verify the sender domain: DNS/SPF/DKIM
  // verification is an external operator step the application cannot observe.
  EMAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  // Optional Reply-To for ticket email; blank or absent omits the header.
  EMAIL_REPLY_TO?: string;
  // AMPED-08B - QR admission credential signing
  TICKET_TOKEN_SECRET?: string;
  // AMPED-10A - Turnstile. The site key is public; the secret key is not.
  TURNSTILE_SECRET_KEY?: string;
}

declare namespace App {
  interface Locals {
    /**
     * The verified operator, populated by the AMPED-04A middleware from the
     * cryptographically verified Cloudflare Access JWT. Undefined on public
     * routes and whenever verification has not happened.
     */
    operator?: {
      email: string;
      /** Stable Access subject, retained for future audit-log writes. */
      sub: string;
      name?: string;
    };
  }
}
