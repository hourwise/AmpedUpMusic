/**
 * Cloudflare Access origin verification (AMPED-04A).
 *
 * This is the second boundary: Cloudflare Access challenges the browser in
 * front of the Worker, and the Worker independently verifies the Access
 * application token it is sent. Trusting the presence of the header - or
 * decoding it without verifying - would let anyone with network access forge
 * an administrator, so the token is verified with `jose` against the team's
 * published JWKS, its issuer, its audience and its temporal claims.
 *
 * Everything here is deliberate about failure: a missing token, a malformed
 * token, a bad signature, the wrong issuer or audience, an expired token, an
 * unverifiable key, or a token that carries no human identity all produce the
 * same opaque denial. Nothing about the reason is returned to the caller.
 *
 * The module is server-only. It reads no configuration at import time; the
 * middleware supplies it. Tests inject a local JWK set and a fixed clock, so
 * no real Access account or credential is ever required.
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Non-secret server configuration for one Access application. */
export interface AccessConfig {
  /** `https://<team-name>.cloudflareaccess.com`, no trailing slash. */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
}

/** The verified human operator, derived only from verified claims. */
export interface AccessOperator {
  email: string;
  sub: string;
  name?: string;
}

/** Raised for every verification failure. Carries no detail on purpose. */
export class AccessDeniedError extends Error {
  constructor() {
    super('Access denied.');
    this.name = 'AccessDeniedError';
  }
}

/**
 * The protected namespaces: `/admin`, `/admin/*`, `/api/admin`, `/api/admin/*`.
 *
 * Exact-boundary matching, never `startsWith('/admin')`, so `/administrator`
 * and `/api/administrator` stay public. The predicate covers future nested and
 * dynamic routes without being edited.
 */
export function isProtectedPath(pathname: string): boolean {
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/api/admin' ||
    pathname.startsWith('/api/admin/')
  );
}

/** Strip a trailing slash so `iss` comparison is exact. */
export function normalizeTeamDomain(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Read Access configuration from the runtime environment.
 * Returns null when either value is missing or blank: the caller fails closed.
 */
export function accessConfigFromEnv(
  env: { CF_ACCESS_TEAM_DOMAIN?: string; CF_ACCESS_AUD?: string } | undefined | null,
): AccessConfig | null {
  const teamDomain = env?.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env?.CF_ACCESS_AUD?.trim();
  if (!teamDomain || !audience) return null;
  return { teamDomain: normalizeTeamDomain(teamDomain), audience };
}

/**
 * Read Access configuration from the Worker runtime.
 *
 * The import is guarded for the same reason as src/services/index.ts: the
 * `cloudflare:workers` module only exists inside the Worker runtime, and a
 * static import would break the Node-based test suite. Public routes never
 * call this.
 */
export async function runtimeAccessConfig(): Promise<AccessConfig | null> {
  try {
    const runtime = (await import('cloudflare:workers')) as unknown as {
      env?: { CF_ACCESS_TEAM_DOMAIN?: string; CF_ACCESS_AUD?: string };
    };
    return accessConfigFromEnv(runtime.env);
  } catch {
    return null;
  }
}

export interface AccessVerifier {
  /** Resolve the operator from a token, or throw AccessDeniedError. */
  verify(token: string): Promise<AccessOperator>;
}

export interface AccessVerifierOptions {
  /**
   * Test seam. Production omits this and the team's remote JWK set is used,
   * which `jose` caches and revalidates - so Cloudflare's key rotation is
   * handled by the supported library rather than a pinned key.
   */
  keyResolver?: JWTVerifyGetKey;
  /** Test seam for deterministic temporal checks. */
  now?: () => Date;
}

/**
 * Build a verifier for one Access application.
 *
 * Signature, issuer, audience and expiry/not-before are all enforced by
 * `jwtVerify`; a token that verifies but carries no `email` or `sub` is
 * rejected rather than becoming an anonymous administrator.
 */
export function createAccessVerifier(
  config: AccessConfig,
  options: AccessVerifierOptions = {},
): AccessVerifier {
  const keys =
    options.keyResolver ??
    createRemoteJWKSet(new URL(`${config.teamDomain}/cdn-cgi/access/certs`));

  return {
    async verify(token: string): Promise<AccessOperator> {
      if (!token) throw new AccessDeniedError();

      let claims: Record<string, unknown>;
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: config.teamDomain,
          audience: config.audience,
          algorithms: ['RS256'],
          ...(options.now ? { currentDate: options.now() } : {}),
        });
        claims = payload as Record<string, unknown>;
      } catch {
        // Never surface the underlying reason (expired vs bad signature etc.).
        throw new AccessDeniedError();
      }

      const email = typeof claims.email === 'string' ? claims.email.trim() : '';
      const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
      if (!email || !sub) throw new AccessDeniedError();

      const name = typeof claims.name === 'string' && claims.name.trim().length > 0
        ? claims.name.trim()
        : undefined;

      return { email, sub, ...(name ? { name } : {}) };
    },
  };
}

export type AccessDecision =
  | { action: 'pass' }
  | { action: 'deny' }
  | { action: 'allow'; operator: AccessOperator };

/**
 * The single decision the middleware makes.
 *
 * A public path passes without looking at configuration or the request token,
 * so a missing Access configuration can never break the public site. A
 * protected path without a verifier or token is denied.
 */
export async function evaluateAccess(input: {
  pathname: string;
  token: string | null;
  verifier: AccessVerifier | null;
}): Promise<AccessDecision> {
  if (!isProtectedPath(input.pathname)) return { action: 'pass' };
  if (!input.verifier || !input.token) return { action: 'deny' };
  try {
    return { action: 'allow', operator: await input.verifier.verify(input.token) };
  } catch {
    return { action: 'deny' };
  }
}

/**
 * The single denial response. Plain, minimal and cache-free: no stack trace,
 * no token, no verification detail.
 */
/**
 * Cross-site request defence for admin mutations (AMPED-CF-00A).
 *
 * WHY THIS IS NEEDED AT ALL
 * Admin identity comes from the `cf-access-jwt-assertion` header that
 * Cloudflare Access injects once a browser holds a valid `CF_Authorization`
 * cookie. That is an ambient credential: the browser attaches it to ANY
 * request the browser is persuaded to make, including one triggered by a
 * hostile page. Whether such a request carries the cookie at all depends on
 * Cloudflare's own `SameSite` setting, which this application neither
 * controls nor can observe. Resting a financial state change on a third
 * party's cookie attribute is not a defence, so the application adds its own.
 *
 * THE RULE
 *  - Safe methods pass. Reading an admin page is not a state change, and
 *    every `/api/admin` route in this repository is a mutation anyway.
 *  - `Sec-Fetch-Site` is believed when present: only `same-origin` is allowed.
 *    Browsers set it themselves and script cannot forge it. `same-site` is
 *    rejected too - admin and the storefront share ONE hostname by design, so
 *    a sibling subdomain posting here is not a flow we have, and a compromised
 *    neighbour is exactly the attacker this guard exists for.
 *  - Otherwise `Origin` must equal the request's own origin. The comparison is
 *    derived from the request rather than a configured hostname, so it is
 *    correct on localhost, on *.workers.dev and on any custom domain without
 *    anybody remembering to update a list.
 *  - When BOTH are absent the request is allowed. This is the documented
 *    compatibility policy: a browser mounting a cross-origin POST always
 *    sends `Origin`, and every browser recent enough to matter also sends
 *    `Sec-Fetch-Site`. A request carrying neither is a server-to-server or
 *    command-line client, which cannot be a confused deputy because no
 *    ambient operator session exists to hijack.
 *
 * No CSRF token is introduced. One would add a session, a rotation story and
 * a failure mode, to defend a surface that fetch metadata already closes.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export type OriginDecision = 'allow' | 'reject-cross-site' | 'reject-foreign-origin';

/** Pure decision, so every branch is testable without a server. */
export function evaluateRequestOrigin(input: {
  method: string;
  url: string;
  secFetchSite: string | null;
  origin: string | null;
}): OriginDecision {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return 'allow';

  if (input.secFetchSite !== null) {
    return input.secFetchSite === 'same-origin' ? 'allow' : 'reject-cross-site';
  }

  if (input.origin !== null) {
    let expected: string;
    try {
      expected = new URL(input.url).origin;
    } catch {
      // An unparseable request URL cannot be proven same-origin.
      return 'reject-foreign-origin';
    }
    return input.origin === expected ? 'allow' : 'reject-foreign-origin';
  }

  return 'allow';
}

/**
 * The shared guard. Returns a denial to send, or null to continue.
 *
 * Deliberately one function covering the whole `/api/admin` namespace rather
 * than a check pasted into each route: there are 22 mutation routes today and
 * the twenty-third must be protected on the day it is written, not on the day
 * somebody remembers.
 */
export function guardAdminMutation(request: Request): Response | null {
  const { pathname } = new URL(request.url);
  if (!isProtectedPath(pathname)) return null;

  const decision = evaluateRequestOrigin({
    method: request.method,
    url: request.url,
    secFetchSite: request.headers.get('sec-fetch-site'),
    origin: request.headers.get('origin'),
  });

  return decision === 'allow' ? null : crossOriginDeniedResponse();
}

/** Indistinguishable from any other refusal: it reveals nothing. */
export function crossOriginDeniedResponse(): Response {
  return new Response('Forbidden', {
    status: 403,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function accessDeniedResponse(): Response {
  return new Response('Forbidden', {
    status: 403,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
