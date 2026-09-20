/**
 * The admin authentication boundary (AMPED-04A).
 *
 * Cloudflare Access challenges the browser before the Worker is reached; this
 * middleware is the independent origin-side check that the request really
 * carries a valid Access application token. It protects `/admin`, `/admin/*`,
 * `/api/admin` and `/api/admin/*` - current and future routes alike, because
 * the predicate matches namespaces rather than a list of filenames.
 *
 * Public requests are passed straight through before any configuration or key
 * lookup, so the public site works with no Access configuration present.
 * Protected requests fail closed (403) for every failure mode. No local bypass
 * exists: a developer tests the admin through a development Access
 * application, not by disabling the gate.
 *
 * The verifier is built once per isolate and only when configuration is
 * present; the team's remote JWKS is cached and revalidated by `jose`, so key
 * rotation needs no code change.
 */

import { defineMiddleware } from 'astro:middleware';
import {
  accessDeniedResponse,
  createAccessVerifier,
  evaluateAccess,
  isProtectedPath,
  runtimeAccessConfig,
  type AccessVerifier,
} from '@/lib/access.ts';

let verifierPromise: Promise<AccessVerifier | null> | null = null;

/** Resolve (once) the verifier for this isolate, or null when unconfigured. */
function getVerifier(): Promise<AccessVerifier | null> {
  verifierPromise ??= runtimeAccessConfig().then((config) =>
    config ? createAccessVerifier(config) : null,
  );
  return verifierPromise;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  if (!isProtectedPath(pathname)) return next();

  const decision = await evaluateAccess({
    pathname,
    token: context.request.headers.get('cf-access-jwt-assertion'),
    verifier: await getVerifier(),
  });

  if (decision.action !== 'allow') return accessDeniedResponse();

  // Verified: hand the operator to the admin layout. Verified claims only.
  context.locals.operator = decision.operator;
  return next();
});
