# AMPED-04A — Cloudflare Access setup

This slice adds the origin-side authentication boundary for the admin. It does
**not** create or configure any Cloudflare resource: the team domain and the
application audience (AUD) tag below must be created by the supervisor before
any authenticated remote testing or deployment.

> **Gate:** no AMPED-04B admin-write deployment may happen before real Access
> certification against a development Access application.

## A. What the supervisor must create

A Cloudflare Access **self-hosted application** protecting the admin paths on
the deployed origin, plus a policy allowing the human operators.

- The application must cover the admin namespace on the real origin:
  - `/admin`
  - `/admin/*`
  - `/api/admin`
  - `/api/admin/*`
- Application middleware is the second boundary; the remote Access policy is
  the first. Both are required. Configuring only the middleware leaves the
  admin reachable at the edge.

## B. Required configuration values

Set these as Worker variables (non-secret configuration) for the environment:

| Variable | Example shape | Notes |
| --- | --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | `https://<team-name>.cloudflareaccess.com` | The Zero Trust team domain. No trailing slash (one is stripped if present). |
| `CF_ACCESS_AUD` | `<application-audience-tag>` | From the Access application's **Additional settings → Application Audience (AUD) Tag**. |

Do not commit real values. In `wrangler.jsonc` the names are documented but
deliberately left unset; leaving them unset is safe (public routes unaffected,
admin fails closed).

The Worker verifies the `Cf-Access-Jwt-Assertion` request header against
`<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, checking signature, `iss`,
`aud`, `exp`/`nbf`, and requires verified `email` and `sub` claims.

## C. Access application paths

The Access policy must be attached to the production/development hostname and
cover the admin namespace above, not just the source middleware. If the
application only protects `/admin` but not `/api/admin`, admin API calls would
be unprotected at the edge (the Worker would still 403 them, but the edge
should challenge first).

## D. Identity policy

Human operators authenticate through the chosen Access identity provider
(one-time PIN, Google, etc.). The token must carry a verified email. V1 admin
is human-only: a valid token without `email`/`sub` is rejected at the origin,
so no anonymous administrator can exist.

## E. Local development

There is **no runtime bypass**. Locally:

- the public site works normally (`/`, `/gigs`, `/tickets`, …);
- `/admin` and `/api/admin` return `403` unless a valid Access assertion is
  present and the Access variables are configured.

To work on the admin in a browser, the supervisor should create a **development
Access application** and supply its team domain and AUD for the local
environment. Unit/integration tests do not need this: they generate an
ephemeral RSA key pair and a local JWK set and exercise the same verifier
(`tests/access.test.ts`).

## F. Verification checklist (after a development Access app exists)

1. Unauthenticated browser request to `/admin` → Access challenge/block at the
   edge, before the Worker.
2. Authenticated browser request → admin loads.
3. Request the origin directly with **no** or an **invalid**
   `Cf-Access-Jwt-Assertion` → `403 Forbidden` (origin independently validates).
4. Request with a valid assertion → admin renders with the verified operator
   email shown in the header.
5. Public routes (`/`, `/gigs`, `/tickets`) remain reachable without Access.

## G. Production gate

**No AMPED-04B admin-write deployment before real Access certification.**

Until then this branch must not be deployed: the D1-backed admin contains
orders, enquiries and mailing-list data, and robots.txt / `noindex` are not
security controls.
