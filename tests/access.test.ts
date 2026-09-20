/**
 * AMPED-04A - the Cloudflare Access origin boundary.
 *
 * Every JWT here is generated at runtime with an ephemeral RSA key pair and a
 * local JWK set, so no real Cloudflare Access account, team domain, AUD tag or
 * signing key is required. The verifier under test is the same one production
 * uses; only its key resolver and clock are injected.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  accessConfigFromEnv,
  accessDeniedResponse,
  createAccessVerifier,
  evaluateAccess,
  isProtectedPath,
  normalizeTeamDomain,
  runtimeAccessConfig,
} from '../src/lib/access.ts';

vi.setConfig({ testTimeout: 30_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG = {
  teamDomain: 'https://ampedup-test.cloudflareaccess.com',
  audience: 'test-application-aud-tag',
};
const KID = 'test-signing-key-1';
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

function epoch(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const keyPair = await generateKeyPair('RS256');
  privateKey = keyPair.privateKey;
  const publicJwk = await exportJWK(keyPair.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] });

  const other = await generateKeyPair('RS256');
  otherPrivateKey = other.privateKey;
});

interface TokenOverrides {
  issuer?: string;
  audience?: string;
  kid?: string;
  key?: CryptoKey;
  exp?: number;
  nbf?: number;
}

async function signToken(
  claims: Record<string, unknown>,
  overrides: TokenOverrides = {},
): Promise<string> {
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: overrides.kid ?? KID })
    .setIssuer(overrides.issuer ?? CONFIG.teamDomain)
    .setAudience(overrides.audience ?? CONFIG.audience)
    .setIssuedAt(epoch(FIXED_NOW))
    .setExpirationTime(overrides.exp ?? epoch(new Date(FIXED_NOW.getTime() + 3_600_000)));

  if (overrides.nbf !== undefined) builder.setNotBefore(overrides.nbf);
  return builder.sign(overrides.key ?? privateKey);
}

function verifier() {
  return createAccessVerifier(CONFIG, { keyResolver: jwks, now: () => FIXED_NOW });
}

const VALID_CLAIMS = {
  email: 'anya@ampedupmusicpromo.co.uk',
  sub: 'access-subject-1',
  name: 'Anya',
};

describe('protected path predicate', () => {
  it('protects the exact admin namespaces', () => {
    for (const path of [
      '/admin',
      '/admin/',
      '/admin/gigs',
      '/admin/gigs/new',
      '/admin/door/evt_123',
      '/api/admin',
      '/api/admin/',
      '/api/admin/orders',
    ]) {
      expect(isProtectedPath(path), path).toBe(true);
    }
  });

  it('does not capture lookalike or public paths', () => {
    for (const path of [
      '/',
      '/gigs',
      '/tickets',
      '/artists/the-glass-hearts',
      '/administrator',
      '/administrators',
      '/api/administrator',
      '/api/checkout',
      '/api/webhooks/sumup',
    ]) {
      expect(isProtectedPath(path), path).toBe(false);
    }
  });

  it('covers representative future nested paths', () => {
    for (const path of [
      '/admin/settings/team/roles',
      '/admin/gigs/evt_1/edit',
      '/api/admin/v2/reports',
      '/api/admin/gigs/evt_1/publish',
    ]) {
      expect(isProtectedPath(path), path).toBe(true);
    }
  });
});

describe('configuration', () => {
  it('is absent unless both values are present and non-blank', () => {
    expect(accessConfigFromEnv(undefined)).toBeNull();
    expect(accessConfigFromEnv({})).toBeNull();
    expect(accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: CONFIG.teamDomain })).toBeNull();
    expect(accessConfigFromEnv({ CF_ACCESS_AUD: CONFIG.audience })).toBeNull();
    expect(
      accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: '  ', CF_ACCESS_AUD: '  ' }),
    ).toBeNull();
  });

  it('normalises the team domain and keeps the audience', () => {
    expect(
      accessConfigFromEnv({
        CF_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com/',
        CF_ACCESS_AUD: 'aud-1',
      }),
    ).toEqual({ teamDomain: 'https://team.cloudflareaccess.com', audience: 'aud-1' });
    expect(normalizeTeamDomain('https://team.cloudflareaccess.com///')).toBe(
      'https://team.cloudflareaccess.com',
    );
  });

  it('reports no runtime config under Vitest (no Worker binding)', async () => {
    // Public routes must still work in this situation.
    expect(await runtimeAccessConfig()).toBeNull();
  });
});

describe('access decisions', () => {
  it('passes a public route with no configuration or token', async () => {
    for (const pathname of ['/', '/gigs', '/tickets', '/api/checkout']) {
      expect(await evaluateAccess({ pathname, token: null, verifier: null })).toEqual({
        action: 'pass',
      });
    }
  });

  it('denies a protected route with no verifier configured', async () => {
    expect(await evaluateAccess({ pathname: '/admin', token: 'anything', verifier: null })).toEqual(
      { action: 'deny' },
    );
    expect(
      await evaluateAccess({ pathname: '/api/admin/orders', token: 'anything', verifier: null }),
    ).toEqual({ action: 'deny' });
  });

  it('denies a protected route with no assertion header', async () => {
    for (const pathname of ['/admin', '/admin/foo', '/api/admin', '/api/admin/foo']) {
      expect(await evaluateAccess({ pathname, token: null, verifier: verifier() })).toEqual({
        action: 'deny',
      });
    }
  });

  it('denies a malformed token', async () => {
    for (const token of ['not-a-jwt', 'a.b.c', '']) {
      expect(await evaluateAccess({ pathname: '/admin', token, verifier: verifier() })).toEqual({
        action: 'deny',
      });
    }
  });

  it('denies a token signed by the wrong key', async () => {
    const token = await signToken(VALID_CLAIMS, { key: otherPrivateKey });
    expect(await evaluateAccess({ pathname: '/admin', token, verifier: verifier() })).toEqual({
      action: 'deny',
    });
  });

  it('denies a token with the wrong issuer', async () => {
    const token = await signToken(VALID_CLAIMS, {
      issuer: 'https://attacker.cloudflareaccess.com',
    });
    expect(await evaluateAccess({ pathname: '/admin', token, verifier: verifier() })).toEqual({
      action: 'deny',
    });
  });

  it('denies a token for the wrong application audience', async () => {
    const token = await signToken(VALID_CLAIMS, { audience: 'some-other-application' });
    expect(await evaluateAccess({ pathname: '/admin', token, verifier: verifier() })).toEqual({
      action: 'deny',
    });
  });

  it('denies an expired token', async () => {
    const token = await signToken(VALID_CLAIMS, { exp: epoch(FIXED_NOW) - 60 });
    expect(await evaluateAccess({ pathname: '/admin', token, verifier: verifier() })).toEqual({
      action: 'deny',
    });
  });

  it('denies a token that is not valid yet', async () => {
    const token = await signToken(VALID_CLAIMS, {
      nbf: epoch(FIXED_NOW) + 60,
      exp: epoch(new Date(FIXED_NOW.getTime() + 3_600_000)),
    });
    expect(await evaluateAccess({ pathname: '/admin', token, verifier: verifier() })).toEqual({
      action: 'deny',
    });
  });

  it('denies a verified token that carries no human identity', async () => {
    const noEmail = await signToken({ sub: 'access-subject-1' });
    const noSub = await signToken({ email: 'anya@ampedupmusicpromo.co.uk' });

    expect(await evaluateAccess({ pathname: '/admin', token: noEmail, verifier: verifier() })).toEqual(
      { action: 'deny' },
    );
    expect(await evaluateAccess({ pathname: '/admin', token: noSub, verifier: verifier() })).toEqual(
      { action: 'deny' },
    );
  });

  it('allows a valid token and builds the operator from verified claims only', async () => {
    const token = await signToken(VALID_CLAIMS);
    const decision = await evaluateAccess({ pathname: '/admin/gigs', token, verifier: verifier() });

    expect(decision).toEqual({
      action: 'allow',
      operator: {
        email: 'anya@ampedupmusicpromo.co.uk',
        sub: 'access-subject-1',
        name: 'Anya',
      },
    });
    // Identity comes from the signed token, not from any request header value.
    expect((decision as { operator: { email: string } }).operator.email).toBe(
      VALID_CLAIMS.email,
    );
  });

  it('never lets an unsigned/forged claim become an operator', async () => {
    // A token with the right claims but the wrong signature is the forgery an
    // unverified decode would accept.
    const forged = await signToken(VALID_CLAIMS, { key: otherPrivateKey });
    const decision = await evaluateAccess({ pathname: '/admin', token: forged, verifier: verifier() });
    expect(decision).toEqual({ action: 'deny' });
    expect('operator' in decision).toBe(false);
  });
});

describe('denial response', () => {
  it('is minimal and leaks nothing', async () => {
    const response = accessDeniedResponse();
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toBe('Forbidden');
    expect(body).not.toMatch(/eyJ|jwt|signature|issuer|aud|expired|stack|Error|Access/i);
  });
});

describe('route coverage', () => {
  function routeFiles(dir: string): string[] {
    if (!statSync(dir, { throwIfNoEntry: false })) return [];
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return routeFiles(full);
      return entry.endsWith('.astro') ? [full] : [];
    });
  }

  function toRoutePath(file: string): string {
    const relative = file
      .slice(join(root, 'src', 'pages').length)
      .replace(/\\/g, '/')
      .replace(/\.astro$/, '');
    const withoutIndex = relative.replace(/\/index$/, '').replace(/^\/index$/, '/');
    return withoutIndex.replace(/\[([^\]]+)\]/g, ':$1') || '/';
  }

  it('maps every existing admin page into the protected namespace', () => {
    const files = routeFiles(join(root, 'src', 'pages', 'admin'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const route = toRoutePath(file);
      expect(isProtectedPath(route), `${file} -> ${route}`).toBe(true);
    }
  });

  it('maps every existing admin API route into the protected namespace', () => {
    const files = routeFiles(join(root, 'src', 'pages', 'api', 'admin'));
    for (const file of files) {
      const route = toRoutePath(file);
      expect(isProtectedPath(route), `${file} -> ${route}`).toBe(true);
    }
    // There are no admin API routes yet; the predicate already covers them.
    expect(isProtectedPath('/api/admin/anything')).toBe(true);
  });
});

describe('server-only boundary', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|astro)$/.test(entry) ? [full] : [];
    });
  }

  it('keeps jose and the Access module out of anything client-facing', () => {
    const joseImporters: string[] = [];
    const accessImporters: string[] = [];

    for (const file of sourceFiles(join(root, 'src'))) {
      const source = readFileSync(file, 'utf8');
      const relative = file.slice(root.length + 1).replace(/\\/g, '/');
      if (/from\s+['"]jose['"]/.test(source)) joseImporters.push(relative);
      if (/from\s+['"]@\/lib\/access\.ts['"]/.test(source)) accessImporters.push(relative);
    }

    expect(joseImporters).toEqual(['src/lib/access.ts']);
    expect(accessImporters).toEqual(['src/middleware.ts']);
  });
});
