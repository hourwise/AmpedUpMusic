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

  // --- Secrets. Server-side only; never referenced from client code. -------
  // AMPED-07 - SumUp Hosted Checkout
  SUMUP_API_KEY?: string;
  SUMUP_MERCHANT_CODE?: string;
  SUMUP_WEBHOOK_SECRET?: string;
  // AMPED-08C - transactional email
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  // AMPED-08B - QR admission credential signing
  TICKET_TOKEN_SECRET?: string;
  // AMPED-10A - Turnstile. The site key is public; the secret key is not.
  TURNSTILE_SECRET_KEY?: string;
}

declare namespace App {
  interface Locals {
    /**
     * The signed-in operator, populated from the Cloudflare Access JWT by the
     * middleware added in AMPED-04A. Undefined during AMPED-01.
     */
    operator?: {
      email: string;
      name?: string;
    };
  }
}
