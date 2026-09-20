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
export function accessDeniedResponse(): Response {
  return new Response('Forbidden', {
    status: 403,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
