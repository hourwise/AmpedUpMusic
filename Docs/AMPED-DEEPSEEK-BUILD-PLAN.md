# Amped Up V1 — DeepSeek Worker Build Plan

**Produced by:** AMPED-01 (Claude Opus)
**Supervisor:** ChatGPT (acceptance agent)
**Worker:** DeepSeek
**Baseline:** branch `claude/amped-01-visual-scaffold`
**Slices:** 30, across 11 phases
**Governing document:** `Docs/Amped Up Music Promotions — V1 Build Plan.md` — authoritative over this file
**Companion:** `Docs/AMPED-01-ARCHITECTURE-NOTES.md` — risks referenced below as R1…R16

---

## Part A — Governance

### A1. What DeepSeek may do

- Implement exactly the assigned slice, inside its **Allowed scope** only.
- Add the tests the slice requires.
- Make small local refactors **within the allowed scope** where the slice genuinely needs them.
- Add dependencies **only** where the slice explicitly names one.

### A2. What DeepSeek may not do

- Redesign the architecture, the layering, or the service-contract seam.
- Substitute a major dependency (framework, adapter, test runner, payment provider, email provider).
- Broaden product scope, or implement a later slice "while I am in here".
- Alter payment semantics in any way.
- Weaken authentication, authorisation or any security control.
- Remove, skip, weaken or `.skip()` a test — including one that a change has made fail.
- Touch production credentials, secrets or Cloudflare resources.
- Deploy anything to production.
- Modify files owned by another slice.
- Silently fix an unrelated issue it notices in passing.

### A3. Stop conditions (universal)

Stop, record `BLOCKED / SUPERVISOR DECISION REQUIRED` with the reason, and do not improvise, if:

1. Completing the slice would require editing a file outside **Allowed scope**.
2. A test outside the slice starts failing and the fix is not obviously inside the slice.
3. The slice as written conflicts with the governing build plan or the architecture notes.
4. A real secret, credential or production resource would be needed.
5. The acceptance criteria cannot be met without changing payment or admission semantics.
6. A required upstream API has changed such that the specified approach cannot work.

Per-slice stop conditions are **in addition** to these.

### A4. Evidence required in every worker report

Every slice report ends with exactly this block, filled in:

```
STARTING SHA:
FINAL SHA:
BRANCH:
FILES CHANGED:
MIGRATIONS:
TESTS RUN:
TEST RESULTS:
BUILD RESULT:
KNOWN LIMITATIONS:
SECRETS/PRODUCTION RESOURCES TOUCHED:
UNCOMMITTED FILES:
```

`SECRETS/PRODUCTION RESOURCES TOUCHED` is expected to read `NONE` for every slice up to and including
AMPED-12. Anything else must be explained.

### A5. Standing rules for every slice

- One branch per slice: `deepseek/<slice-id>-<short-name>`, cut from the SHA the supervisor gives.
- Never push to `main`. Never force-push. Never rewrite history.
- `npm run verify` (typecheck + tests + build) must pass before the report is written.
- Money is **integer pence**, always. Never a float, never a string.
- Timestamps are **ISO-8601 UTC**. Display formatting goes through `src/lib/dates.ts` only.
- Components never access data. Pages call `getServices()`; components receive view models.
- Bindings are read via `import { env } from 'cloudflare:workers'` inside `src/services/` only.
  **`Astro.locals.runtime.env` does not exist on this stack** (see architecture notes §1).
- Every SQL statement is parameterised. String-built SQL is an automatic rejection.
- Alt text is required on any image that can reach a public page.
- New UI reuses `src/components/ui` and the tokens in `src/styles/tokens.css`. No new colour literals.

---

## Part B — Sequencing rationale

The order differs from the conceptual phases in the governing plan in three deliberate ways, all of
which reduce risk:

1. **Ticket inventory and the order state machine (AMPED-06) land before SumUp (AMPED-07).**
   This is the governing plan's own instruction and it is the single most important sequencing choice:
   overselling is proved impossible against a fake provider, so the SumUp slice only has to get payment
   right, not payment *and* inventory.

2. **The Cloudflare Access boundary (AMPED-04A) lands before any admin write path.**
   The scaffold's admin is read-only and harmless. The moment a write endpoint exists it must already be
   behind Access — otherwise there is a window where an unauthenticated POST can publish a gig.

3. **Ticket issuance (AMPED-08A) is split from QR generation (AMPED-08B) and from email (AMPED-08C).**
   Three different failure modes — duplication, credential security, delivery — each reviewable alone.

Slices are sized so that each can be reviewed in one sitting, reverted as a unit, tested completely, and
handed to a different agent with no hidden context.

---

## Part C — The slices

---
---

## Phase 02 — Data layer

### AMPED-02A — Core schema and migration baseline

**Objective** — A D1 database that can be created from empty via migrations, with the full V1 schema.

**Preconditions** — AMPED-01 merged. Wrangler authenticated against a **development** account only.

**Allowed scope**
- `migrations/**` (new)
- `src/db/**` (new: migration runner helpers, typed row shapes)
- `wrangler.jsonc` (uncomment and populate the `d1_databases` binding only)
- `package.json` (add `db:migrate`, `db:seed`, `db:reset` scripts)
- `src/env.d.ts` (make `DB` non-optional)
- `tests/schema.test.ts` (new)

**Forbidden scope** — `src/pages/**`, `src/components/**`, `src/services/**`, `src/data/**`, any other lib.
Do not touch the mock services. Nothing consumes the database in this slice.

**Implementation requirements**
1. One migration file per logical group, numbered and ordered, forward-only.
2. Tables, per the governing plan §AMPED-02: `venues`, `artists`, `events`, `event_artists`,
   `ticket_types`, `orders`, `order_items`, `tickets`, `checkins`, `media_assets`, `social_posts`,
   `enquiries`, `mailing_list`, `audit_log`, plus `processed_webhooks` (R3) and `schema_migrations`.
3. Column names and types mirror `src/types/domain.ts`. Money columns are `INTEGER` named `*_pence`.
   Timestamps are `TEXT` ISO-8601 UTC. Booleans are `INTEGER` 0/1.
4. `CHECK` constraints on every status column, matching the TypeScript unions exactly.
5. Foreign keys with explicit `ON DELETE` behaviour. `orders → events` is `RESTRICT` (R8).
6. Indexes on: `events(status, starts_at)`, `events(slug)` unique, `ticket_types(event_id)`,
   `orders(event_id)`, `orders(reference)` unique, `tickets(order_id)`, `tickets(reference)` unique,
   `checkins(ticket_id)` unique, `mailing_list(email)` unique.
7. A seed script producing a dataset **equivalent to the AMPED-01 fixtures** — same event statuses, same
   availability states, same sold/reserved counts — so the scaffold's visual states remain reachable.

**Tests required**
- Migrate from empty → succeeds; schema matches expectation.
- Migrating twice is a no-op (idempotent runner).
- Seed loads; row counts match expectation.
- Each status `CHECK` constraint rejects an invalid value.
- `orders → events` delete is refused while an order exists.
- Unique constraints reject duplicate slug, order reference and ticket reference.

**Acceptance criteria** — `npm run db:reset && npm run db:migrate && npm run db:seed` succeeds against a
local D1 from empty. `npm run verify` green. No application code reads the database yet.

**Stop conditions** — If a required column cannot be expressed without changing `src/types/domain.ts`.
Report the mismatch; do not edit the types unilaterally.

---

### AMPED-02B — Venue and artist persistence

**Objective** — Venues and artists read from D1 behind the existing `VenueService` / `ArtistService`.

**Preconditions** — AMPED-02A merged.

**Allowed scope** — `src/services/d1/venues.ts`, `src/services/d1/artists.ts` (new),
`src/services/index.ts` (selection logic only), `tests/services.test.ts` (extend, do not weaken).

**Forbidden scope** — `src/pages/**`, `src/components/**`, `src/services/mock/**`, `migrations/**`.

**Implementation requirements**
1. Implement `VenueService` and `ArtistService` exactly as declared in `src/services/contracts.ts`.
2. `getServices()` returns D1-backed venue/artist services when `env.DB` is bound, mock otherwise.
   Every other service stays on fixtures this slice.
3. Sort order matches the mock implementations (alphabetical, `localeCompare` with `en-GB`).
4. All queries parameterised. No `SELECT *`.

**Tests required** — the existing contract tests must pass against the D1 implementation; add a
mock-vs-D1 parity test for `list()` and `getBySlug()`; assert an unknown slug returns `null`, not a throw.

**Acceptance criteria** — `/about`, `/accessibility`, `/artists` and `/admin/venues` render identically
from D1 as they did from fixtures. `npm run verify` green.

**Stop conditions** — If a contract method cannot be satisfied without widening the interface.

---

### AMPED-02C — Event and line-up persistence

**Objective** — Events, line-ups and their joins read from D1.

**Preconditions** — AMPED-02B merged.

**Allowed scope** — `src/services/d1/events.ts`, `src/services/d1/project.ts` (new),
`src/services/index.ts`, `tests/**`.

**Forbidden scope** — `src/pages/**`, `src/components/**`, `src/types/**`, `migrations/**`.

**Implementation requirements**
1. Produce `EventView` objects **identical in shape** to `src/services/mock/project.ts`. That file is the
   reference implementation — read it first.
2. Past/upcoming is derived from the date via `hasFinished()`, never from status (R9).
3. Public queries must never return `draft` or `archived` rows. Enforce in SQL, not in TypeScript.
4. Avoid N+1: fetch events, line-ups, ticket types and media in bounded batched queries.

**Tests required** — every existing test in `tests/services.test.ts` passes unchanged; draft leakage test;
past/upcoming boundary test around a curfew; line-up ordering test; a query-count assertion proving no N+1.

**Acceptance criteria** — all public event routes render from D1. `tests/services.test.ts` **unmodified**
and passing. `npm run verify` green.

**Stop conditions** — If matching the mock projection requires a schema change.

---

### AMPED-02D — Ticket types and inventory reads

**Objective** — Ticket types and derived inventory read from D1.

**Preconditions** — AMPED-02C merged.

**Allowed scope** — `src/services/d1/tickets.ts` (new), `src/services/d1/events.ts`, `tests/**`.

**Forbidden scope** — `src/lib/availability.ts` (it is pure and correct; do not change it),
`src/pages/**`, `src/components/**`.

**Implementation requirements**
1. `sold` = count of tickets in `issued` or `checked_in` for that ticket type.
2. `reserved` = count held by orders in `awaiting_payment` whose `reservation_expires_at` is in the future.
   An expired reservation must **not** count as reserved (R15).
3. Availability continues to come from `deriveAvailability()`. Do not reimplement the thresholds.
4. Hidden (guest list) types are excluded from public reads and from on-sale capacity.

**Tests required** — sold/reserved/available arithmetic; expired reservation is not counted; hidden types
excluded publicly but present in the admin summary; availability states match the AMPED-01 fixtures.

**Acceptance criteria** — every availability state still reachable in the seeded data and rendering
correctly. `npm run verify` green.

**Stop conditions** — If the fixtures must be edited to make a state reachable — that indicates a
seed-data problem in AMPED-02A, not a code problem.

---

## Phase 03 — Public site on real data

### AMPED-03A — Retire the fixture layer

**Objective** — All public read paths on D1; `src/data/` deleted.

**Preconditions** — AMPED-02D merged.

**Allowed scope** — `src/services/**`, `src/data/**` (delete), `tests/**`,
`scripts/generate-artwork.mjs` (delete only if AMPED-05A has landed; otherwise keep).

**Forbidden scope** — `src/pages/**`, `src/components/**`, `src/layouts/**`, `src/lib/**`.

**Implementation requirements**
1. Implement the remaining contracts against D1: media, social, admin, orders, door, enquiries,
   mailing list, audit.
2. Delete `src/data/` entirely, including `clock.ts`.
3. `isScaffoldData()` returns `false` when `env.DB` is bound — this removes the admin scaffold banner.
4. `getServices()` must not silently fall back to fixtures in production. If `DB` is unbound in a
   production build, fail loudly.

**Tests required** — full suite green with no `src/data` import anywhere; a grep-style test asserting no
file outside `tests/` imports from `src/data`; `isScaffoldData()` false with a bound DB.

**Acceptance criteria** — `src/data/` gone. Every page renders from D1. **Zero changes** under
`src/pages/` or `src/components/` — that is the proof the seam held. `npm run verify` green.

**Stop conditions** — If any page or component must change, stop and report: it means the AMPED-01
boundary was violated somewhere and the supervisor needs to see where.

---

### AMPED-03B — Public rendering completeness

**Objective** — Public site behaves correctly as data changes.

**Preconditions** — AMPED-03A merged.

**Allowed scope** — `src/pages/index.astro`, `src/pages/gigs/**`, `src/pages/past-gigs/**`,
`src/pages/tickets.astro`, `src/pages/gallery.astro`, `src/pages/artists/**`, `src/services/d1/**`,
`tests/**`. Plus `src/pages/venues/**` **only if** recommendation V1-3 was approved.

**Forbidden scope** — `src/components/**` (styling is frozen), `src/lib/availability.ts`, `migrations/**`.

**Implementation requirements**
1. The homepage next-gig changes automatically when a gig passes. No manual featuring.
2. An event leaves Upcoming and enters Past Gigs with no operator action (R9).
3. `/tickets` lists exactly the events with at least one public ticket type.
4. Empty states render for every list when the database is empty — do not assume data exists.
5. Per-route caching policy decided and documented: which routes are prerendered, which are
   server-rendered, and what `Cache-Control` each sets.

**Tests required** — homepage next-gig rolls over across a curfew boundary; an event appears in exactly
one of upcoming/past; every list renders its empty state against an empty database; `/gigs/[slug]` for a
past event 301s to `/past-gigs/[slug]` and vice versa.

**Acceptance criteria** — changing a row in D1 updates every appropriate public view with no other
intervention. `npm run verify` green.

**Stop conditions** — If correct behaviour requires a component change.

---

### AMPED-03C — SEO, structured data and social previews

**Objective** — Events are correctly described to search engines and social platforms.

**Preconditions** — AMPED-03B merged.

**Allowed scope** — `src/lib/seo.ts`, `src/layouts/BaseLayout.astro` (head only),
`src/pages/sitemap.xml.ts` (new), `public/robots.txt`, `tests/seo.test.ts` (new).

**Forbidden scope** — every other page, every component, all services.

**Implementation requirements**
1. Complete the `MusicEvent` JSON-LD in `src/lib/seo.ts`; validate against Google's Rich Results rules.
2. `eventStatus` must reflect cancelled and postponed correctly — this is what stops search engines
   advertising a cancelled gig.
3. Generate `sitemap.xml` from published events, artists and static pages. Exclude `/admin/*` and drafts.
4. OpenGraph images: use the event poster; fall back to the site default. Correct dimensions declared.
5. `noindex` on every `/admin/*` route (already set — assert it).

**Tests required** — JSON-LD validates for a normal, a sold-out, a cancelled and a postponed event;
sitemap excludes drafts and admin; every public page emits a canonical URL, a title and a description;
no admin route is missing `noindex`.

**Acceptance criteria** — Rich Results test passes for a sample event. `npm run verify` green.

**Stop conditions** — If schema.org requires a field not present on `EventView`.

---

## Phase 04 — Administrator application

### AMPED-04A — Cloudflare Access boundary

**Objective** — `/admin/*` is unreachable without a verified Cloudflare Access identity.

**Preconditions** — AMPED-03A merged. A **development** Access application configured by the supervisor.

**Allowed scope** — `src/middleware.ts` (new), `src/lib/access.ts` (new), `src/env.d.ts`,
`wrangler.jsonc` (Access variables only), `tests/access.test.ts` (new),
`Docs/AMPED-04A-ACCESS-SETUP.md` (new).

**Forbidden scope** — every page, every component, every service. This slice adds a gate, nothing else.

**Implementation requirements**
1. Middleware over `/admin/*` **and every admin API route**, verifying the `Cf-Access-Jwt-Assertion`
   header server-side against the team's public keys. Presence of the header is not verification (R6).
2. Verify issuer, audience, expiry and signature. Cache the JWKS with a sane TTL.
3. Populate `Astro.locals.operator` from the verified claims. **Remove the hard-coded demo fallback in
   `src/layouts/AdminLayout.astro`** — this is the one permitted edit outside the scope list, and it must
   be called out explicitly in the report.
4. Failure returns 403 with a plain page, never a redirect loop and never a stack trace.
5. Document the Access application setup, including how a local developer bypasses it safely.

**Tests required** — no header → 403; malformed JWT → 403; expired JWT → 403; wrong audience → 403;
valid JWT → 200 with `locals.operator` populated; a route-enumeration test asserting **every** path under
`/admin` is covered by the middleware matcher.

**Acceptance criteria** — no `/admin` route is reachable unauthenticated. `npm run verify` green.

**Stop conditions** — If any production Access application or production credential would be required.

---

### AMPED-04B — Gig create, edit and lifecycle

**Objective** — `PromotionForm` writes to D1. An operator can create, edit, publish and change a gig.

**Preconditions** — AMPED-04A merged.

**Allowed scope** — `src/pages/admin/gigs/**`, `src/pages/api/admin/gigs/**` (new),
`src/components/admin/PromotionForm.astro`, `src/services/d1/events.ts`, `src/lib/validation.ts` (new),
`tests/**`.

**Forbidden scope** — public pages, `src/components/ui/**`, `src/lib/availability.ts`, payment, door,
media upload.

**Implementation requirements**
1. Server-side validation of every field. Client validation is convenience only.
2. Pounds → pence conversion via `parsePoundsToPence()`. Reject anything it returns `null` for.
3. `datetime-local` input is interpreted as Europe/London and stored as UTC.
4. Status transitions enforced server-side: `draft → published`, `published → postponed | cancelled |
   completed`, `* → archived`. Anything else is a 400.
5. Deletion rule (R8): an event with any order is **never** deletable. A draft with no dependencies may
   be deleted. Enforced in the API, not only the UI.
6. Capacity may be raised but never set below the number already sold.
7. Every write appends an `audit_log` row with the verified operator identity.
8. Slug generated from the title via `slugify()`, uniqueness enforced, and **stable once published** —
   changing a published slug would break every shared link.

**Tests required** — create draft → publish → appears publicly; every illegal status transition rejected;
delete refused with orders; delete allowed for a bare draft; capacity below sold rejected; audit row
written per operation; price parsing rejects `10.999`, `-5`, `ten`; BST datetime stored correctly.

**Acceptance criteria** — a gig can be created and published from `/admin/gigs/new` with no developer
involvement, and appears on the public site. `npm run verify` green.

**Stop conditions** — If a transition rule conflicts with the governing plan.

---

### AMPED-04C — Artist and venue management

**Objective** — Artists and venues can be created and edited from the admin.

**Preconditions** — AMPED-04B merged.

**Allowed scope** — `src/pages/admin/artists.astro`, `src/pages/admin/venues.astro`,
`src/pages/api/admin/artists/**`, `src/pages/api/admin/venues/**` (new), `src/services/d1/**`, `tests/**`.

**Forbidden scope** — events, tickets, orders, media upload, public pages.

**Implementation requirements**
1. Create and edit for both. Archive, never hard-delete, for any record referenced by an event.
2. Venue accessibility information is a **required** field (R10, and the reason it lives on the venue).
3. `+ Add artist` from the Line-up step creates the artist and adds it to the bill in one action — this
   is the workflow the governing plan calls for.
4. Audit every write.

**Tests required** — create/edit round-trip for both; archive instead of delete when referenced;
venue rejected without accessibility text; add-artist-from-lineup creates and attaches in one call.

**Acceptance criteria** — a new band entered once is selectable on the next promotion. `npm run verify` green.

**Stop conditions** — as A3.

---

### AMPED-04D — Duplicate Promotion

**Objective** — Any event can be copied into a new draft.

**Preconditions** — AMPED-04B merged.

**Allowed scope** — `src/pages/api/admin/gigs/duplicate.ts` (new), `src/pages/admin/gigs/[id].astro`,
`src/services/d1/events.ts`, `tests/duplicate.test.ts` (new).

**Forbidden scope** — everything else.

**Implementation requirements**
1. **Copy:** venue, line-up and running order, ticket type definitions (name, price, capacity,
   max per order), age restriction, description, accessibility notes, artwork references, social links,
   photography credit.
2. **Do not copy:** dates, sale windows, orders, order items, tickets, check-ins, sales counters,
   status (always `draft`), `published_at`, gallery images, status messages.
3. New slug derived from the title with a uniqueness suffix.
4. The operator lands on the edit screen for the new draft with the date fields empty and focused.
5. Audit the duplication, recording the source event id.

**Tests required** — every copied field is present; every excluded field is absent or reset; the copy is
always `draft`; sales counters are zero; the source event is completely unmodified.

**Acceptance criteria** — duplicating a sold-out gig produces a clean draft with zero sales.
`npm run verify` green.

**Stop conditions** — If the copy/exclude split is ambiguous for a field added after this plan was written.

---

## Phase 05 — Media and social

### AMPED-05A — R2 media storage

**Objective** — Images upload from the admin to R2 and render on the site.

**Preconditions** — AMPED-04A merged. A **development** R2 bucket.

**Allowed scope** — `src/pages/api/admin/media/**` (new), `src/services/d1/media.ts`,
`src/lib/upload.ts` (new), `src/pages/admin/media.astro`, `src/components/admin/PromotionForm.astro`
(artwork step only), `wrangler.jsonc` (R2 binding), `astro.config.mjs` (image service), `tests/**`.
May delete `scripts/generate-artwork.mjs` and `public/media/**`.

**Forbidden scope** — events, orders, tickets, door, payment.

**Implementation requirements**
1. Server-side validation: MIME allowlist (`image/jpeg`, `image/png`, `image/webp`, `image/avif`),
   magic-byte sniff (do not trust the declared type), max 8 MB, max dimensions.
2. Storage key generated server-side — **never** derived from the uploaded filename.
3. Persist width, height, byte size, MIME, role, credit and **alt text**.
4. Alt text is required before an image can be attached to a publishable event (R10).
5. Revisit `imageService` in `astro.config.mjs` now that real photographs exist — likely
   `{ build: 'compile', runtime: 'cloudflare-binding' }` with an `IMAGES` binding.
6. Removing an asset deletes the R2 object and the row together, or neither.

**Tests required** — allowed types accepted; disallowed rejected; a PNG renamed `.jpg` rejected by
magic-byte check; oversize rejected; path traversal in the filename cannot influence the key; alt text
required; orphaned-object check after a failed write.

**Acceptance criteria** — a poster uploaded in the admin appears on the public gig page.
`npm run verify` green.

**Stop conditions** — If a production R2 bucket would be needed.

---

### AMPED-05B — Event galleries and photography links

**Objective** — Past gig galleries and the AnyaParallax cross-link, driven by data.

**Preconditions** — AMPED-05A merged.

**Allowed scope** — `src/pages/admin/media.astro`, `src/pages/past-gigs/**`, `src/pages/gallery.astro`,
`src/services/d1/media.ts`, `src/pages/api/admin/media/**`, `tests/**`.

**Forbidden scope** — upload primitives (frozen by AMPED-05A), events, orders, payment.

**Implementation requirements**
1. Multi-file upload assigned to one event in a single operation.
2. Gallery ordering is operator-controlled and persisted.
3. The photography credit and gallery URL are **fields on the event**, never hard-coded into a page —
   this is explicit in the governing plan.
4. `/gallery` groups by event, most recent first.

**Tests required** — gallery ordering persists; credit and URL render from data and are absent when
unset; `/gallery` grouping and ordering; an event with no photographs renders its empty state.

**Acceptance criteria** — adding photographs to a past gig updates both the gig page and `/gallery`.
`npm run verify` green.

**Stop conditions** — as A3.

---

### AMPED-05C — Social post management

**Objective** — Operators curate the social strip by pasting URLs.

**Preconditions** — AMPED-05A merged.

**Allowed scope** — `src/pages/admin/social.astro` (new), `src/pages/api/admin/social/**` (new),
`src/services/d1/social.ts`, `src/lib/site.ts` (admin nav entry), `src/pages/index.astro` (strip wiring
only), `tests/**`.

**Forbidden scope** — events, media upload internals, orders, payment.

**Implementation requirements**
1. Paste URL → choose network → optional caption and thumbnail → optionally attach to an event.
2. `featured` controls homepage placement; the operator chooses, in an explicit order.
3. **No crawler, no platform API, no oEmbed fetch.** This is a deliberate V1 decision in the governing
   plan: social APIs change without warning and a broken homepage crawler is worse than a manual strip.
4. Validate the URL and store it as given; never render pasted content as HTML.

**Tests required** — create/edit/delete round-trip; only featured posts reach the homepage; featured
ordering respected; a `javascript:` URL is rejected; caption text is escaped, never injected.

**Acceptance criteria** — an operator can change the homepage social strip with no developer.
`npm run verify` green.

**Stop conditions** — If the slice appears to need a platform API. It does not.

---

## Phase 06 — Inventory and orders

### AMPED-06A — Order state machine

**Objective** — Orders exist, with legal transitions enforced, against a **fake** payment provider.

**Preconditions** — AMPED-02D merged.

**Allowed scope** — `src/services/orders/**` (new), `src/services/payments/mock.ts` (new),
`src/pages/api/checkout/**` (new), `src/pages/admin/orders.astro`, `tests/**`.

**Forbidden scope** — anything SumUp, email, QR, door, media.

**Implementation requirements**
1. Implement the state machine documented on `OrderStatus` in `src/types/domain.ts`:
   `pending → awaiting_payment → paid`, with `cancelled`, `expired`, `refunded`, `partially_refunded`.
2. **`paid` may only be entered via a provider confirmation call** (R2). No other code path may set it.
   Enforce this structurally, not by convention.
3. Order reference format `AMP-YY-NNNNN`, unique, generated server-side, collision-safe.
4. `order_items` capture an **immutable** price and ticket type name at purchase time.
5. Totals are recomputed server-side from the ticket types. A client-supplied total is never trusted.
6. `MockPaymentProvider` implements `PaymentProvider` and can be told to succeed, fail, expire or be slow.

**Tests required** — every legal transition; every illegal transition rejected; `paid` unreachable except
via `confirm()`; totals recomputed and a tampered client total ignored; reference uniqueness under
concurrent creation; immutable item price survives a later ticket-type price change.

**Acceptance criteria** — a full purchase completes against the mock provider and produces exactly one
`paid` order. `npm run verify` green.

**Stop conditions** — If the state machine cannot be enforced without changing payment semantics.

---

### AMPED-06B — Ticket reservations

**Objective** — Checkout holds stock for a bounded window, and expired holds are released.

**Preconditions** — AMPED-06A merged.

**Allowed scope** — `src/services/orders/**`, `src/services/inventory/**` (new),
`src/pages/api/checkout/**`, `migrations/**` (reservation columns/indexes only),
`wrangler.jsonc` (scheduled handler), `src/worker/scheduled.ts` (new), `tests/**`.

**Forbidden scope** — `src/lib/availability.ts`, public components, payment provider internals.

**Implementation requirements**
1. Starting a checkout reserves the requested tickets for **30 minutes**, matching the SumUp hosted
   checkout session lifetime named in the governing plan.
2. Reserved stock is immediately unavailable — the behaviour `deriveAvailability` already assumes.
3. Two independent release mechanisms (R15): a scheduled sweep, **and** lazy reconciliation whenever
   inventory is read. A cron alone will eventually miss one.
4. Payment success converts reservation → sold atomically. Failure or expiry returns the stock.
5. `maxPerOrder` enforced server-side.

**Tests required** — the governing plan's worked example (50 available → reserve 2 → 48 → paid → 2 sold;
expired → back to 50); expired reservation invisible to a read even before the sweep runs; sweep is
idempotent; `maxPerOrder` enforced; reservation cannot exceed available.

**Acceptance criteria** — availability figures are correct at every point in the lifecycle.
`npm run verify` green.

**Stop conditions** — If atomicity is unachievable with the available D1 primitives. Report the specific
limitation — this is a genuine architectural decision point (R1).

---

### AMPED-06C — Oversell protection under concurrency

**Objective** — Prove that capacity cannot be exceeded, under concurrent load.

**Preconditions** — AMPED-06B merged.

**Allowed scope** — `src/services/inventory/**`, `migrations/**` (constraints and indexes only),
`tests/concurrency.test.ts` (new).

**Forbidden scope** — UI of any kind, payment provider, email, door.

**Implementation requirements**
1. Reservation is a **single conditional statement** that decrements only if stock remains. Never a
   `SELECT` followed by an `UPDATE` (R1).
2. A database-level constraint as a second line of defence, so a logic bug cannot oversell silently.
3. A losing concurrent request receives a clear, specific error — not a generic 500.

**Tests required** — N concurrent buyers against a capacity of M where N > M: exactly M succeed, and the
sold count is exactly M. Run at several sizes including the pathological case capacity = 1.
Repeat for the mixed case where some reservations expire mid-run.

**Acceptance criteria** — the governing plan's requirement: *concurrent simulated purchasers cannot
exceed event capacity.* Demonstrated by a test, not by inspection. `npm run verify` green.

**Stop conditions** — If the test cannot be made to pass. **Do not relax the test.** Report it.

---

## Phase 07 — SumUp

> Phase 07 is the tightest-supervised phase in the project. Development credentials only. No production
> SumUp credential may ever be supplied to a worker agent.

### AMPED-07A — SumUp adapter skeleton

**Objective** — A `PaymentProvider` implementation for SumUp, no live calls.

**Preconditions** — AMPED-06C merged. Sandbox credentials in `.dev.vars` (never committed).

**Allowed scope** — `src/services/payments/sumup/**` (new), `src/env.d.ts`, `.dev.vars.example`,
`tests/payments/**` (new).

**Forbidden scope** — order state machine, inventory, UI, email, tickets.

**Implementation requirements**
1. Implement the full `PaymentProvider` interface against recorded fixtures of SumUp's responses.
2. Credentials read server-side only, via `env`. A build-time assertion that no secret name appears in
   any client bundle.
3. Typed request/response models. Unknown fields tolerated, never fatal.
4. Explicit timeout and retry policy for provider calls. Retries must be safe.

**Tests required** — every method against recorded fixtures; a malformed response is handled, not thrown;
timeout path; a bundle-scan test asserting no secret reaches the client.

**Acceptance criteria** — `MockPaymentProvider` is swappable for the SumUp adapter with no change to
calling code. `npm run verify` green.

**Stop conditions** — If any production credential would be required.

---

### AMPED-07B — Hosted checkout creation

**Objective** — Real sandbox checkouts created server-side.

**Preconditions** — AMPED-07A merged.

**Allowed scope** — `src/pages/api/checkout/**`, `src/services/payments/sumup/**`,
`src/components/events/TicketPanel.astro` (submit wiring only), `tests/**`.

**Forbidden scope** — webhook handling, ticket issuance, email, door, order state machine internals.

**Implementation requirements**
1. Checkout created **server-side**. No credential, and no amount, originates in the browser.
2. The amount is recomputed server-side from the ticket types at creation time.
3. Redirect the buyer to the returned hosted URL; store the checkout id against the order.
4. The return URL landing page shows a **pending** state and never claims success (R2). It polls or waits
   for the webhook-driven confirmation.
5. Reservation expiry and checkout expiry are aligned.

**Tests required** — order and reservation created before redirect; amount matches the server-side
recomputation; tampered client amount ignored; the return page shows pending, never paid, on arrival;
failure to create a checkout releases the reservation.

**Acceptance criteria** — a sandbox checkout completes and the order sits in `awaiting_payment` until
confirmed. `npm run verify` green.

**Stop conditions** — If any change to the ticket panel beyond form submission is needed. Its design is
frozen.

---

### AMPED-07C — Webhook verification and idempotency

**Objective** — Payments are confirmed from the server, exactly once.

**Preconditions** — AMPED-07B merged.

**Allowed scope** — `src/pages/api/webhooks/sumup.ts` (new), `src/services/payments/sumup/**`,
`src/services/orders/**` (confirmation path only), `migrations/**` (`orders` indexing and
`processed_webhooks` only), `tests/**`.

**Forbidden scope** — UI, email, tickets, door, checkout creation.

> **REVISED 2026-10-04 (AMPED-07C0 preflight, implemented in AMPED-07C1).**
> This slice originally specified a signed-webhook model. Current SumUp documentation
> describes no such mechanism, so four requirements below were impossible as written and
> have been replaced rather than quietly reinterpreted. The superseded wording is recorded
> here so the change is auditable:
>
> | Original requirement | Status | Replacement |
> |---|---|---|
> | "Verify the webhook's authenticity per SumUp's documentation before doing anything else" | REINTERPRET | SumUp's documented verification *is* the authenticated API retrieval |
> | Test: "invalid signature rejected" | IMPOSSIBLE | Replaced by the correlation-mismatch tests |
> | Test: "valid signature but API says unpaid → order not paid" | REINTERPRET | "Signature" dropped; the rest retained |
> | "record the provider event id" | SUPERSEDED | SumUp sends no event id; the successful **transaction** id is the observation identity |
> | Test: "replayed old webhook rejected" | REINTERPRET | No timestamp exists to age a delivery; replay is proven harmless instead of rejected |
>
> Sources, reviewed 2026-10-04: `developer.sumup.com/online-payments/webhooks`,
> `developer.sumup.com/api/checkouts/create`, `developer.sumup.com/api/checkouts/get`.

**Security model** — The notification is an unauthenticated hint containing a checkout ID. It has
zero payment authority. Authenticity of the claimed payment state is established by an
authenticated server-to-server SumUp API retrieval plus correlation against the local order.
There is no signature, HMAC, shared secret, timestamp or delivery ID to verify, and the
application must not pretend otherwise.

**Implementation requirements**
1. Take the checkout id from the notification and nothing else. Retrieve the authoritative
   checkout over the authenticated API (R2). This is SumUp's own documented instruction.
2. **Never trust the webhook payload as evidence of payment.** Before any transition, correlate
   the retrieved checkout against authoritative local data: checkout id matches the stored
   `payment_reference`; status is `PAID`; `checkout_reference` equals the local order reference;
   amount equals `total_in_pence` compared as exact integer pence, never floating point;
   currency is `GBP`; `merchant_code` is ours; a SUCCESSFUL transaction exists to supply the
   paid timestamp and the observation identity. Any mismatch is a security event and never pays.
3. Idempotency (R3): correctness lives in ONE conditional D1 update — only an unexpired
   `awaiting_payment` order may become `paid`. `processed_webhooks` is a verified-observation
   record, not the correctness gate, and is keyed `sumup_txn:<successful transaction id>`.
   Keying on the checkout id is forbidden: one checkout can be attempted repeatedly and can move
   FAILED → PAID, so a checkout-level key would let an early failure suppress the real payment.
4. The `order.paid` audit insert must be guarded, not unconditional. Concurrent duplicates must
   produce exactly one transition **and** exactly one audit row.
5. Unknown or future event types are acknowledged with an empty 2xx and ignored, never 500.
6. Malformed JSON, missing/non-string ids and unknown local checkouts are acknowledged with an
   empty 2xx. SumUp retries any non-2xx at 1 min, 5 min, 20 min and 2 hours, so rejecting
   unfixable input would only buy more copies of it.
7. A provider retrieval failure, timeout or missing configuration returns a retryable non-2xx
   (502) and changes nothing — the only case where being told again helps.
8. Responses carry an empty body in every case, so the endpoint cannot be used to discover
   whether a checkout id is known.
9. Provider `FAILED`/`EXPIRED` must NOT expire the order or release stock. A declined attempt can
   be retried on the hosted page; expiry belongs solely to the AMPED-06B reservation sweep.
10. `return_url` is SumUp's BACKEND callback and `redirect_url` is the shopper's browser
    destination. They must not be given the same value. The webhook URL is server configuration
    (`SUMUP_WEBHOOK_URL`) and is omitted entirely when unset.
11. One writer to `paid`: `retrieve + verify → VerifiedPayment → applyVerifiedPayment(...)`.
    `applyVerifiedPayment` performs no network I/O and is the primitive AMPED-07D must reuse.

**Tests required** — correlation mismatch (wrong reference / amount / currency / merchant /
no successful transaction) never pays; PAID pays exactly once; PENDING, FAILED and EXPIRED change
nothing; FAILED followed by PAID on the same checkout still pays; duplicate webhook → exactly one
transition; **concurrent** duplicates (N=8, real ephemeral D1) → exactly one transition, one audit
row and one observation; webhook racing the reservation sweep cannot both win; unknown event
type → 2xx; unknown order → 2xx and logged; malformed JSON → 2xx; retrieval failure → 502;
replay after paid is harmless; exact-pence conversion rejects over-precision.

**Acceptance criteria** — the governing plan's requirement: *test payment → verified SumUp
transaction → exactly one completed order.* `npm run verify` green.

**Real-webhook certification** — A SumUp-originated sandbox webhook is still REQUIRED and is
explicitly DEFERRED to the first authorised staging deployment, after the Cloudflare Access
exposure gate is proven. SumUp cannot reach `127.0.0.1`, and no tunnel is authorised. AMPED-07C1
proves the endpoint → retrieval → verification → mutation chain with a synthetic local POST
using the real documented notification shape; it does not claim real delivery has been certified.

**Stop conditions** — If SumUp's current documentation contradicts this slice. Report the
difference; do not improvise a verification scheme.

---

### AMPED-07D — Payment reconciliation

**Objective** — No order is left stuck because a webhook never arrived.

**Preconditions** — AMPED-07C1 accepted.

**Allowed scope** — `src/worker/scheduled.ts`, `src/services/payments/**`, `src/services/orders/**`,
`src/pages/admin/orders.astro` (reconciliation status display only), `tests/**`.

**Forbidden scope** — webhook handler internals, UI beyond the status column, email, tickets.

> **REVISED 2026-10-04 (implemented in AMPED-07D).** Two requirements below changed and one
> area was deliberately deferred. Recorded here rather than quietly implemented differently:
>
> | Original | Status | Why |
> |---|---|---|
> | (1) "finds orders in `awaiting_payment` **past their window**" | **SUPERSEDED** | Acting on a lapsed hold means resurrecting stock the sweep already released, which can oversell the room. Reconciliation now targets orders whose hold is still LIVE, so a verified payment can actually be applied. The paid-but-expired case is detected and counted, never auto-resolved. |
> | (3) "Orders genuinely abandoned are expired and the stock released" | **UNCHANGED, pre-existing** | Already owned by the AMPED-06B sweep. 07D does not duplicate it; it runs *before* it in the same tick. |
> | (4) discrepancy surfaced to the operator | **PARTIAL — deferred** | 07D counts `discrepancies` and logs them operationally. The `admin/orders.astro` status display is NOT implemented in this slice and remains outstanding. |
> | (5) refund status read back from SumUp | **NOT IMPLEMENTED — deferred** | Out of the authorised 07D instruction; no refund reading exists. V1 still does not initiate refunds. |

**Implementation requirements**
1. A scheduled job that finds `awaiting_payment` orders which still hold stock and have a SumUp
   `payment_reference`, and asks SumUp what happened. Candidate selection is bounded
   (`RECONCILIATION_BATCH_SIZE`), soonest-expiry-first, and served by the accepted 0010 index
   (`SEARCH orders USING INDEX orders_status_reservation_expires_at_idx
   (status=? AND reservation_expires_at>?)`) — no new index was required.
2. Reconciliation uses the same confirmation path as the webhook: the AMPED-07C1
   `SumUpPaymentVerifier.verify()` and the AMPED-07C1 `applyVerifiedPayment()`. Exactly one SQL
   statement in the application can set an order to `paid`, and it is not in the reconciler.
3. Orders genuinely abandoned are expired and the stock released — by the AMPED-06B sweep, which
   runs AFTER reconciliation in the same scheduled tick so a late payment is rescued before its
   hold can be swept away.
4. Provider `PENDING`, `FAILED` and `EXPIRED` cause no local transition. A provider failure or
   timeout mutates nothing and is retried on the next tick. One failing candidate never strands
   the rest of the batch.
5. An expired or released reservation is never resurrected. A verified payment against one is
   counted as a discrepancy and logged, never applied.
6. Provider traffic is bounded: `RECONCILIATION_BATCH_SIZE` candidates per run, at most
   `RECONCILIATION_CONCURRENCY` simultaneous retrievals. No polling loop.
7. Reconciliation inspecting an order writes no business-audit row. The guarded `order.paid`
   audit inside `applyVerifiedPayment` remains the only business record.

**Cadence** — the existing five-minute cron, unchanged. Derived from the lifecycle rather than
convenience: with a 30-minute hold, every order gets roughly six reconciliation attempts before it
can lapse, and a dropped webhook is recovered within about five minutes instead of being lost.

**Tests required** — lost webhook reconciled to `paid`; repeated runs harmless; no eligible orders;
missing `payment_reference` ignored; already-paid and already-expired ignored; expired never
resurrected; PENDING / FAILED / EXPIRED unchanged; wrong reference / amount / currency / merchant /
missing successful transaction never pay; retrieval failure changes nothing; one bad candidate does
not strand the batch; **concurrent** webhook-vs-reconciler, reconciler-vs-reconciler and
reconciler-vs-sweep each produce exactly one outcome; batch and concurrency bounds enforced; the
scheduled task still expires holds when SumUp is unconfigured.

**Acceptance criteria** — a deliberately dropped webhook is recovered by reconciliation.
`npm run verify` green.

**Stop conditions** — If reconciliation would need to initiate a refund, or would need a second
writer to `paid`.

---

### AMPED-07D2-2 — Durable payment discrepancy detection

**Objective** — When SumUp holds money we cannot attach to an order, a human finds out.

**Preconditions** — AMPED-07D accepted.

**Allowed scope** — `migrations/0013`, `src/services/payments/**`, `src/worker/scheduled.ts`,
`src/services/index.ts`, `src/db/schema.ts` (table inventory registration only), `tests/**`.

**Forbidden scope** — refunds, OAuth, admin UI, order resurrection, customer notification.

#### Policy A is permanent

> **Once `reservation_expires_at <= now`, the reservation has ceased to reserve inventory. That
> order must never subsequently transition to `paid`, regardless of when the provider claims the
> payment was made.**

**Expiry is time-based, not sweep-based.** This is the fact the whole design rests on. `reserved`
is computed in both the acquisition gate (`src/services/inventory/acquire.ts`) and the public read
(`src/services/d1/tickets.ts`) as `status = 'awaiting_payment' AND reservation_expires_at > ?now`,
where `?now` is the *reading request's* clock. The instant the timestamp passes, those seats are
purchasable by anybody — the AMPED-06B sweep does not release them, it only writes the label down
afterwards.

**Policy B (authoritative payment-time cutoff) is rejected.** Letting a payment proven to have
completed before the deadline race the sweep would credit an order whose seats may already have
been resold in the unswept gap. That reintroduces precisely the oversell AMPED-06C exists to
prevent, it gets worse the longer the scheduler is down, and it still needs the refund path for
every case where the seats did go. **Policy C (re-acquire capacity, then credit)** is correct but
is a new state path for a case better addressed by reconciling earlier; also rejected for now.

The real lever is prevention: a live hold already gets ~6 reconciliation attempts before it can
lapse.

#### What a discrepancy is

> Authenticated provider evidence indicates SumUp may hold customer money which Amped Up cannot
> safely attach to the local order.

The discriminator is **money**, not failure: a SUCCESSFUL transaction exists, or the checkout
reads `PAID`. PENDING, an ordinary decline, a checkout that expired unpaid, a transient retrieval
failure, malformed webhook input and unknown attacker-supplied checkout ids are operational
conditions and get no financial record — recording them would bury the handful of rows that
represent real money.

Kinds: `paid_after_expiry`, `paid_order_expired`, `amount_mismatch`, `correlation_mismatch`.

#### Detection window and identity

**Window: 30 minutes**, matching the reservation lifetime. With the 5-minute cron that gives each
lapsed order ~6 opportunities to be examined — the same budget a live hold gets. It is not longer
because a payment cannot occur after the checkout's own `valid_until`, which is the same instant
as the local expiry under the AMPED-07B single-clock rule; by the time the window closes,
everything that could have been paid already has been. Batch 20, concurrency 4. Orders that
already have a discrepancy drop out of the candidate query, so repeated runs cost no provider
calls.

**Identity key** (`identity_key`, NOT NULL, UNIQUE):
`sumup_txn:<transaction id>` when an authenticated transaction names the money, otherwise
`sumup_checkout:<checkout id>` — which covers the real recurring case of a PAID checkout whose
transaction list has not settled. Both inputs are trustworthy: the checkout id comes from our own
`payment_reference`, never from a webhook body. `UNIQUE(provider, transaction_id)` was rejected
because SQLite permits unlimited NULLs through a UNIQUE constraint, which would silently allow
duplicates for exactly that case. A second constraint, `UNIQUE(order_id, checkout_id)`, stops a
discrepancy first seen without a transaction id from being recorded again under the preferred
key once it settles. Neither constraint subsumes the other.

#### Scheduler

`live-hold reconciliation → expiry bookkeeping sweep → discrepancy detection`.

Detection is last by preference, not necessity: because the boundary is the timestamp rather than
the sweep, it sees the same lapsed orders either way. A test pins that running it before or after
the sweep produces the same durable outcome — only the recorded `kind` differs.

#### Refunds remain external — and the documentation contradicts itself

V1 policy is unchanged: **the operator refunds in SumUp**, then records the outcome here. No
in-app refund exists and none is implied by a discrepancy row.

Two SumUp documents disagree about how a refund would ever be issued, and this is unresolved:

| Source | Endpoint | Authentication |
|---|---|---|
| Current API reference | `POST /v1.0/merchants/{merchant_code}/payments/{transaction_id}/refunds` | documents API-key examples |
| Older guide (`/docs/refund/`, `/online-payments/guides/refund`) | `POST /v0.1/me/refund/{txn_id}` | *"Valid access token obtained with the Authorization code flow"*; explicitly **cannot** use client-credentials |

The older guide is treated as legacy/contradictory pending sandbox certification. Whether the
merchant-scoped API key Amped Up already holds can issue a refund is **not established**, and no
money-moving probe was made. Settling it needs its own authorisation.

Refund state, when it matters, requires a **transaction** lookup (`refunded_amount`,
`simple_status`): checkout retrieval alone cannot distinguish a partial refund from a full one.

#### Deferred

- **AMPED-07D2-3** — operator visibility. **DONE**: badge, list, recommended action and the
  manual `resolved_manually` transition (plus Reopen) shipped in that slice. `dismissed` remains
  unexposed.
- **In-app refunds** — deferred indefinitely, gated on the credential question above. The
  `refund_requested` / `refund_confirmed` / `refund_failed` states are reserved in migration 0013
  so the schema need not change later, and 07D2-2 is tested never to write them.
- Resolving a discrepancy must **not** set the order to `refunded`; that transition belongs to
  the later workflow and needs its own invariant.

**Stop conditions** — If detection would require trusting webhook payload data, storing raw
provider responses, resurrecting a lapsed reservation, or creating a second writer to `paid`.

---

### AMPED-07D2-3 — Discrepancy operator visibility and manual resolution

**Objective** — A human finds out about money SumUp is holding, and can record that they dealt
with it.

**Preconditions** — AMPED-07D2-2 accepted at `6e057b8`.

**Allowed scope** — `src/pages/admin/discrepancies.astro`, `src/pages/api/admin/discrepancies/**`,
`src/pages/admin/orders.astro` (badge only), `src/services/payments/**`, `src/services/index.ts`,
`src/lib/text.ts`, `src/lib/site.ts` (nav entry), `tests/**`.

**Forbidden scope** — refund API calls, OAuth, order status changes, customer email, deployment,
Access configuration.

#### Discrepancies are now operator-visible

`/admin/discrepancies`, linked from the admin navigation and from a stat card on the orders page —
which is where an operator already is when a customer says they have paid and have no ticket. The
badge counts `state='open'` only, so a resolved discrepancy stops demanding attention. Open work
is listed oldest-detected first (longest-unresolved money is the most urgent); resolved history
lives behind a separate view, newest first, and is never mixed into the active queue.

Shown per row: order reference and local order status, the discrepancy in plain English with a
recommended action, both amounts, provider paid-at, hold expiry, transaction id (or "Not yet
known" — absence is normal, not an error), detected and last-checked times, and state. **No
customer name or email**: the order reference is enough to find the payment in SumUp, and a
financial queue is not a reason to spread personal data onto another screen. No credentials, no
provider bodies, no card data.

#### External refund remains V1 policy, and the wording must protect it

Amped Up sends no refunds. The operator refunds in SumUp and then records that here. The action
is **"Mark resolved"**, never "Refund" — a button that looks like it refunds somebody is worse
than no button at all. The page carries a standing warning, and the confirmation states plainly
that no refund is sent and nothing changes at SumUp.

`resolved_manually` therefore means exactly one thing: **an authorised operator attests that the
discrepancy was dealt with externally.** It is not evidence that SumUp refunded anything, and the
recorded event says so in those words. No event named `refunded` is ever written, because Amped Up
has not verified that a refund occurred.

#### Order status is deliberately unchanged

Resolving a discrepancy does not touch the order. Expired stays expired; `awaiting_payment` stays
governed by the reservation lifecycle; nothing becomes `paid` or `refunded`. The relationship
between an externally completed SumUp refund and `orders.status='refunded'` needs its own
invariant and is **not** defined here.

#### Transitions

`open -> resolved_manually` and `resolved_manually -> open` (**Reopen**, implemented). Both are
conditional D1 updates, so concurrency is settled by the database rather than a disabled button,
and both append to the immutable history rather than rewriting it — a reopened discrepancy still
shows that it was resolved once, and by whom. Reopen exists because a financial record should not
be a one-way door: the cost of an uncorrectable mis-click is that real money silently stops being
chased.

`dismissed` is reserved in the schema but **not exposed**. A financial discrepancy either stays
open or is deliberately marked externally resolved; false-positive dismissal needs its own
evidentiary semantics first.

Authorisation is the existing AMPED-04A boundary: the routes sit under `/api/admin/`, so the
middleware has verified a Cloudflare Access token before the handler runs, and `operatorFrom`
refuses without the verified operator. The actor recorded is that verified identity. The request
body is empty by design — the discrepancy id comes from the path and the permitted transition
from the route, so there is no client-supplied state, amount, kind or provider fact to trust.

#### Evidence enrichment (repair made in this slice)

AMPED-07D2-2 excluded any order with a discrepancy from re-observation, so a row recorded from the
checkout fallback could never gain the transaction id once SumUp settled it — it stayed
permanently less authoritative than the provider. Repaired narrowly:

- the candidate query now excludes only **fully identified** discrepancies
  (`transaction_id is not null`), so an unidentified row stays observable and an identified one
  stops costing provider calls;
- `enrich()` attaches `transaction_id`, `provider_paid_at` and `provider_amount_in_pence` to the
  **existing** row, gated on `transaction_id is null` for exactly-once, and appends one
  `evidence_enriched` event.

It is evidence only: `state`, `kind` and `resolved_at` are never touched, so a later observation
can improve a **resolved** record without silently reopening it. The identity system is unchanged
— `identity_key` is not rewritten when the preferred identity strengthens, because
`UNIQUE(order_id, checkout_id)` already guarantees one row per payment and mutating a business key
would risk a collision for no gain.

#### Still deferred

- **In-app refunds.** Gated on the unresolved question of whether Amped Up's merchant API key can
  issue one at all (see the 07D2-2 record of the contradictory SumUp documentation). The
  `refund_requested` / `refund_confirmed` / `refund_failed` states remain reserved and unwritten.
- **`orders.status='refunded'`** after an external refund — needs its own invariant.
- **Dismissal** of false positives.

---

### Deployment invariant — migration 0012

`0012_payment_reference_identity.sql` adds a partial UNIQUE index on non-null
`orders.payment_reference`. It was proven safe against local data before being written, but a
remote database has its own history.

**Before 0012 is applied to any remote staging or production D1, that database MUST receive a
read-only duplicate check first:**

```sql
SELECT payment_reference, COUNT(*) AS n
FROM orders
WHERE payment_reference IS NOT NULL
GROUP BY payment_reference
HAVING COUNT(*) > 1;
```

An empty result is required. If it returns rows, the migration will fail on apply — and more
importantly those duplicates mean a checkout id does not uniquely identify an order, so the webhook
and reconciler could credit the wrong customer. Resolve the duplicates and understand how they
arose before migrating; do not weaken the index to accommodate them.

No remote database was queried while implementing AMPED-07C1, AMPED-07D or AMPED-07D2-2.

`0013_payment_discrepancies.sql` is purely additive - two new tables and their indexes -
so it needs no pre-apply data check of its own.

---

## Phase CF — Cloudflare hosting

### AMPED-CF-00A — Pre-staging security and runtime repair

**Objective** — Remove the code and configuration blockers that stood between the accepted
application and a first hosted Worker.

**Preconditions** — AMPED-CF-00 preflight accepted; AMPED-07D2-3 accepted at `3b3d793`.

#### Deployment architecture: Cloudflare Workers with Static Assets

**Pages is rejected.** The application exports a `scheduled` handler (`src/worker/entry.ts`) that
exists solely because the Astro adapter's own entry exports only `fetch`. Pages Functions have no
cron triggers, so moving to Pages would mean deleting the reconciliation and discrepancy passes or
running a second Worker to host them. Nothing forces that trade.

`astro build` emits a **redirected Wrangler configuration** — `.wrangler/deploy/config.json`
points at `dist/server/wrangler.json`, and that generated file is what `wrangler dev` and
`wrangler deploy` actually use. Two consequences that are easy to get wrong:

- The root `wrangler.jsonc` is an **input** to generation, not the deployed config. Its
  `assets.directory` is overridden to `../client` by the adapter. It previously read `./dist` —
  the directory containing both the browser assets and the server bundle — which invited the
  reasonable but false conclusion that the server bundle was being published. Corrected to
  `./dist/client` so the file documents reality. Verified: the build still resolves `/_astro/*`
  and still does not serve `dist/server/*`.
- **Named Wrangler environments are resolved at BUILD time from `CLOUDFLARE_ENV`, not from the
  `--env` flag at deploy time.** Building without it and deploying with `--env staging` silently
  produced `AMPED_ENV ("development")` and the default bindings — no error, just the wrong
  environment. Both halves are required:

  ```
  CLOUDFLARE_ENV=staging npm run build
  npx wrangler deploy --env staging
  ```

#### Admin mutation origin defence

Cloudflare Access answers *who is this*; it cannot answer *did they mean to send this*. The
operator credential is ambient, so a hostile page can make an authenticated browser act. Whether
Cloudflare's `CF_Authorization` cookie would block that depends on a `SameSite` attribute this
application neither controls nor can observe — not a basis for exposing financial mutations.

One shared guard (`guardAdminMutation`, `src/lib/access.ts`) now runs in middleware for the whole
`/api/admin` namespace, after identity and before any handler. All **22** admin routes are
mutations; there is no admin GET API to exempt.

The rule, in order: safe methods pass → `Sec-Fetch-Site` is believed when present and only
`same-origin` passes (`same-site` is rejected too, because admin and storefront share one
hostname by design) → otherwise `Origin` must equal the request's own origin → when **both** are
absent the request passes, as a documented compatibility policy for server-to-server and CLI
clients, which carry no ambient session to hijack. The expected origin is derived from the
request, so the guard is correct on localhost, `*.workers.dev` and any custom domain with no list
to maintain. No CSRF token system was introduced: one would add a session, a rotation story and a
failure mode to defend a surface fetch metadata already closes.

`/api/webhooks/sumup` and the customer checkout routes are deliberately outside the guard. SumUp
sends neither header, and the webhook carries zero payment authority by design.

#### Astro sessions removed

No consumer exists anywhere in `src/` — no `Astro.session`, no `SESSION` binding reference;
operator identity comes from the verified Access JWT via `locals.operator`. Left on, the adapter
emitted a `SESSION` KV binding with **no namespace id**, which a real deploy rejects. Rather than
create a throwaway namespace to satisfy a facility nothing uses, `session: false` turns it off.
Verified: the generated config now contains `kv_namespaces: []`.

#### Canonical identity corrected

`ampedupmusic.co.uk` (no "promo") was never registered. `astro.config.mjs` and `src/lib/site.ts`
used it while `src/lib/seo.ts` used the real `ampedupmusicpromo.co.uk` — the two disagreed.
Reconciled on the live zone, along with `hello@` and `tickets@`. Four seeded venue/cancellation
messages telling customers to email the dead address were also corrected; fabricated audit-actor
names (`anya@`, `jay@`) keep the old domain deliberately — they name nobody real and instruct
nobody. A test now fails if a contact address or site URL on the unregistered domain reappears.

#### Staging must never advertise itself

Indexing is **opt-in**: only `AMPED_ENV=production` at build time marks a build indexable, and the
default is not. Read at build time rather than runtime because four pages are prerendered, so
their `<meta robots>` is fixed when they are built — a runtime lookup would be ignored by exactly
the pages most likely to be crawled.

The opposite default was considered and rejected: forgetting the flag on a production build gives
a site that is not indexed, visible at a glance and fixed by one rebuild, whereas forgetting it on
staging publishes a duplicate of the real site under the brand's own name. `robots.txt` moved from
a static file to a generated route for the same reason — the static one would have shipped
`Allow: /` and advertised the production sitemap from a staging host. Indexing is a courtesy to
crawlers; Cloudflare Access is what actually keeps staging private.

#### Staging environment prepared, cron off

`wrangler.jsonc` gains an `env.staging` block: name `ampedup-staging`, `AMPED_ENV=staging`, and
**`triggers.crons: []`**. Omitting `triggers` was tried first and the top-level five-minute cron
came through anyway; an empty array is what actually stops it. A fresh deployment must not begin
calling a payment provider on a timer before anyone has confirmed its configuration. D1 and R2
bindings are intentionally absent — CF-01 adds them with ids the operator creates.

#### Staging topology (unchanged from CF-00, restated)

One hostname, `staging.ampedupmusicpromo.co.uk`, with `/admin` inside it. A separate admin
hostname would be actively harmful: the checkout derives its customer return URL from the live
request origin, so an admin action on a second host could mint checkout URLs on the wrong origin.

#### Deferred

- `staging` branch creation — after this slice is accepted.
- Cloudflare resources: D1, R2, Access applications, DNS — all CF-01.
- The full README / PCGSoft AUTO rewrite remains its own pre-launch gate.

---

### AMPED-CF-02 — Hosted SumUp sandbox certification

The staging-only hosted certification record is in
[`AMPED-CF-02-CERTIFICATION.md`](AMPED-CF-02-CERTIFICATION.md). CF-02 does not
authorise live SumUp payments, ticket issuance, or email delivery.

---

## Phase 08 — Tickets and email

### AMPED-08A — Ticket issuance

**Objective** — A confirmed payment issues exactly one ticket per admission, exactly once.

**Preconditions** — AMPED-07C merged.

**Allowed scope** — `src/services/tickets/**` (new), `src/services/orders/**` (issuance hook only),
`src/pages/orders/[reference].astro` (new — **only if recommendation V1-1 is approved**), `tests/**`.

**Forbidden scope** — QR generation, email, door, payment internals.

**Implementation requirements**
1. Issuance is triggered only by the `→ paid` transition, and is idempotent: calling it twice produces
   one set of tickets (R3, R7).
2. One ticket row per admission. Reference `AMP-YY-NNNNN-N`, unique.
3. Guest list tickets are ordinary tickets on a comp order — so they scan like any other.
4. Issuance and the `paid` transition succeed or fail together.

**Tests required** — one ticket per admission; re-running issuance creates nothing new; concurrent
issuance produces one set; a failure rolls back cleanly; references unique across the database.

**Acceptance criteria** — a paid order has exactly the right number of tickets, and cannot be made to
have more. `npm run verify` green.

**Stop conditions** — If V1-1 has not been approved and the slice appears to need the confirmation page.

---

### AMPED-08B — QR admission credentials

**Objective** — Each ticket carries an opaque, non-guessable admission credential.

**Preconditions** — AMPED-08A merged.

**Allowed scope** — `src/services/tickets/token.ts` (new), `src/services/tickets/qr.ts` (new),
`migrations/**` (token hash column only), `src/env.d.ts`, `tests/tickets/**`.

**Forbidden scope** — door validation (AMPED-09B), email, orders, payment.

**Implementation requirements**
1. Tokens from a CSPRNG, ≥128 bits of entropy.
2. **Store only a hash.** A database leak must not yield working tickets.
3. **No PII in the QR** (R5). Not the name, not the email, not the order reference. An opaque credential
   and nothing else.
4. A QR library may be added — name it in the report and justify the choice. It must work in the Workers
   runtime.
5. Token verification is constant-time against the stored hash.

**Tests required** — tokens unique across a large sample; entropy assertion; a decoded QR contains no PII
and no readable order data; verification is constant-time; a modified token fails.

**Acceptance criteria** — a generated QR scans to an opaque credential that resolves to exactly one
ticket. `npm run verify` green.

**Stop conditions** — If no QR library works in Workers. Report options rather than inventing an encoder.

---

### AMPED-08C — Transactional email

**Objective** — A confirmed order produces one email containing the correct tickets, once.

**Preconditions** — AMPED-08B merged. Development email provider credentials.

**Allowed scope** — `src/services/email/**` (new), `src/services/orders/**` (send hook only),
`src/env.d.ts`, `.dev.vars.example`, `tests/email/**`.

**Forbidden scope** — ticket issuance internals, QR generation, door, payment, mailing list.

**Implementation requirements**
1. Implement `TicketEmailProvider` (already declared in `src/services/contracts.ts`) with a Resend
   implementation and a console implementation for local development.
2. Idempotency is mandatory (R7): the `idempotencyKey` must prevent a second send, including under
   concurrency. Record sends.
3. Email content per the governing plan: promoter, act, date, venue, doors, ticket type, reference, QR.
   Plain-text alternative required.
4. A send failure does **not** roll back the order — the customer has paid. Queue for retry and surface
   it to the operator.
5. `sendEventNotice` for cancellation and postponement, same idempotency guarantees.

**Tests required** — one email per paid order; duplicate send suppressed; concurrent sends produce one
email; all required fields present; plain-text alternative present; a provider failure leaves the order
paid and the failure visible; the notice path is idempotent per order per notice.

**Acceptance criteria** — the governing plan's requirement: *successful purchase produces one email
containing the correct tickets exactly once.* `npm run verify` green.

**Stop conditions** — If a production sending domain would be needed.

---

## Phase 09 — Door Mode

### AMPED-09A — Door scanner client

**Objective** — The camera decodes QR codes in the existing Door Mode interface.

**Preconditions** — AMPED-08B merged, AMPED-04A merged.

**Allowed scope** — `src/pages/admin/door/[eventId].astro` (scanner script and viewfinder only),
`src/scripts/scanner.ts` (new), `tests/**`.

**Forbidden scope** — the check-in API (AMPED-09B), the result component's **design**, tickets, orders,
payment. The visual design of `ScannerResult` is frozen; only the data it receives changes.

**Implementation requirements**
1. Camera permission requested on the explicit Start scanning tap, never on page load.
2. Rear camera preferred. Torch control if the device supports it — venues are dark.
3. Decode debounced so one physical code produces one request.
4. Replace the three demonstration buttons with real scanning. Remove the `ScaffoldNote`.
5. Graceful, loud failure when permission is denied or no camera exists, with the manual lookup offered
   as the route through.
6. Detect offline and say so unmistakably rather than appearing to scan (V1-6).

**Tests required** — decode produces exactly one check-in call per physical scan; permission denial path;
no-camera path; offline state visible; scanning stops when the view is left.

**Acceptance criteria** — a real QR scans on a phone and reaches the check-in API. `npm run verify` green.

**Stop conditions** — If the decoder cannot be made reliable without changing the Door Mode layout.

---

### AMPED-09B — Atomic check-in

**Objective** — Admission is atomic. Two phones, one code, one admission.

**Preconditions** — AMPED-09A merged.

**Allowed scope** — `src/pages/api/admin/door/**` (new), `src/services/door/**` (new),
`migrations/**` (check-in constraints only), `tests/door/**`.

**Forbidden scope** — the scanner client, UI of any kind, tickets, orders, payment.

**Implementation requirements**
1. The `issued → checked_in` transition is a **single conditional UPDATE**, never read-then-write (R4).
2. A unique constraint on `checkins(ticket_id)` as a second line of defence.
3. Return the full `ScanResult` the UI already expects, including `remainingOnOrder`.
4. Record operator identity and timestamp for every check-in.
5. `undoCheckIn` is available, always audited, and reversible only by a verified operator.
6. Correct outcomes for: valid, already used, invalid, wrong event, void/refunded.

**Tests required** — **two concurrent check-ins of the same ticket produce exactly one `valid` and one
`already-used`.** Plus: every outcome path; the unique constraint holds under concurrency; undo is
audited; a refunded ticket is refused.

**Acceptance criteria** — the governing plan's requirement: *two phones can simultaneously operate Door
Mode without duplicate admission.* Demonstrated by a concurrency test. `npm run verify` green.

**Stop conditions** — If atomicity cannot be achieved. **Do not weaken the test.** Report it (R4).

---

### AMPED-09C — Manual lookup and guest list

**Objective** — Somebody with a dead phone still gets in.

**Preconditions** — AMPED-09B merged.

**Allowed scope** — `src/pages/api/admin/door/search.ts` (new), `src/services/door/**`,
`src/pages/admin/door/[eventId].astro` (lookup and guest tabs only), `tests/**`.

**Forbidden scope** — the scanner, the check-in transition itself, orders, payment.

**Implementation requirements**
1. One search endpoint matching name, email, order reference and ticket reference — the operator has one
   box and should not have to know what they are holding.
2. Scoped to the current event. Debounced. Paginated for large events.
3. Manual admission uses **the same atomic check-in** as the scanner. No second code path.
4. Guest list entries are ordinary tickets and behave identically.
5. The endpoint is behind Access and returns only what the door needs — never full customer records.

**Tests required** — each of the four match types finds the order; results scoped to the event; manual
admit is atomic and audited with `method: 'manual'`; guest list admission works; the response contains no
unnecessary personal data.

**Acceptance criteria** — a customer with no email and no phone can be found and admitted by name.
`npm run verify` green.

**Stop conditions** — as A3.

---

## Phase 10 — Promoter tools

### AMPED-10A — Public enquiries with Turnstile

**Objective** — The contact and promote-with-us forms work, and are protected.

**Preconditions** — AMPED-03A merged.

**Allowed scope** — `src/pages/api/enquiries.ts` (new), `src/services/d1/enquiries.ts`,
`src/pages/contact.astro`, `src/pages/promote-with-us.astro` (form wiring only),
`src/components/ui/Turnstile.astro` (new), `src/pages/admin/enquiries.astro`, `src/env.d.ts`, `tests/**`.

**Forbidden scope** — mailing list, events, orders, payment, door.

**Implementation requirements**
1. **Verify the Turnstile token server-side** before storing anything. Rendering the widget is not
   protection — Cloudflare's own documentation says so and the governing plan repeats it.
2. Rate limit by IP as well, since Turnstile is not a rate limiter.
3. Store the enquiry with `botCheckPassed` recorded. A failed check is **kept and flagged**, never
   silently discarded — a real band pitch lost to a bad Turnstile day is a genuine business cost.
4. Server-side validation and length limits on every field. Store as text; never render as HTML.
5. Both forms work without JavaScript where the widget permits it; degrade honestly if not.

**Tests required** — missing token rejected; invalid token rejected; valid token accepted and stored;
failed check stored and flagged; rate limit triggers; XSS payload stored inert and rendered escaped;
oversize input rejected.

**Acceptance criteria** — a submitted enquiry appears in `/admin/enquiries`. `npm run verify` green.

**Stop conditions** — If a production Turnstile secret would be needed.

---

### AMPED-10B — Mailing list

**Objective** — Gig alerts sign-up, unsubscribe, and one announcement action.

**Preconditions** — AMPED-10A merged, AMPED-08C merged.

**Allowed scope** — `src/pages/api/mailing-list/**` (new), `src/pages/unsubscribe.astro` (new),
`src/services/d1/mailing.ts`, `src/components/site/SiteFooter.astro` (form wiring only),
`src/pages/admin/mailing-list.astro`, `src/services/email/**` (announcement only), `tests/**`.

**Forbidden scope** — ticket email templates, orders, payment, door, enquiries.

**Implementation requirements**
1. Sign-up from the footer and from checkout, with the consent source and timestamp recorded — this is
   the only answer that matters if anyone ever asks.
2. Unsubscribe via a signed link needing no login, effective immediately, one click.
3. Unsubscribes become permanent **suppression** records. A later sign-up must not resurrect them silently.
4. One announcement action, reachable from the gig, sending one email about that gig. **No campaign
   builder** — the list has one purpose.
5. Announcement sending is idempotent per event (R7) and reports failures.
6. Low-stock alert to the operator at 90% sold (V1-7), if approved.

**Tests required** — sign-up records consent evidence; duplicate sign-up does not duplicate the row;
unsubscribe works from the link alone and is immediate; suppression survives a re-subscribe attempt;
announcement sends once per event even if triggered twice; unsubscribed addresses are excluded.

**Acceptance criteria** — a subscriber can join and leave without a developer, and the announcement
reaches exactly the subscribed list. `npm run verify` green.

**Stop conditions** — If the scope appears to require campaign management.

---

### AMPED-10C — Cancellation and postponement operations

**Objective** — Changing or stopping a gig is a supported operator workflow.

**Preconditions** — AMPED-04B, AMPED-08C, AMPED-10B merged.

**Allowed scope** — `src/pages/api/admin/gigs/lifecycle.ts` (new), `src/services/d1/events.ts`,
`src/pages/admin/gigs/[id].astro` (danger zone wiring only), `src/services/email/**` (notice path only),
`tests/**`.

**Forbidden scope** — refunds of any kind, payment provider code, ticket issuance, door.

**Implementation requirements**
1. Cancel, postpone and venue-change, each requiring a `statusMessage` that is shown publicly.
2. Cancelling or postponing **stops sales immediately** — the case `deriveAvailability` already covers
   via `eventSellable` (R9).
3. Offer to notify ticket holders. Sending is idempotent per event per notice type.
4. **Refunds stay in SumUp.** The operator refunds there, then marks the order refunded here, which voids
   its tickets. Building refund machinery is explicitly out of V1 scope and is a large financial risk.
5. Every lifecycle change is audited with the operator identity and the message sent.

**Tests required** — cancelled event cannot sell a ticket; postponed event keeps tickets valid;
notification sends once even if the operator clicks twice; marking refunded voids the tickets; a voided
ticket is refused at the door; audit rows written.

**Acceptance criteria** — the full postponement workflow completes from the admin with no developer.
`npm run verify` green.

**Stop conditions** — If the slice appears to need automated refunds. It does not.

---

## Phase 11 — Hardening

### AMPED-11A — Security hardening

**Objective** — Close out the governing plan's security review.

**Preconditions** — AMPED-10C merged.

**Allowed scope** — `src/middleware.ts`, `src/lib/security.ts` (new), `astro.config.mjs`,
`wrangler.jsonc`, `public/_headers`, any route missing a control, `tests/security/**` (new),
`Docs/AMPED-11-SECURITY-REVIEW.md` (new).

**Forbidden scope** — feature work of any kind. No new capability in this slice.

**Implementation requirements** — work the governing plan's list and evidence each item:
authorisation on **every** admin route; Access identity verified server-side; SumUp secret server-only;
email key server-only; no secret in any client bundle; upload MIME/type/size limits; SQL parameterisation
everywhere; rate limiting; Turnstile on public forms; CSRF where applicable; secure headers and CSP;
no PII in QR codes; no payment information stored; audit trail complete.

**Tests required** — an automated route-enumeration test asserting every `/admin` and every admin API
route is authenticated; a bundle scan for secret names; a CSP test; a SQL-injection probe suite; a rate
limit test; a PII-in-QR assertion.

**Acceptance criteria** — every item evidenced in the review document with a test or an explicit
justification. `npm run verify` green.

**Stop conditions** — If closing an item requires a design change. Report it as a finding.

---

### AMPED-11B — Accessibility, performance and error handling

**Objective** — Close out the governing plan's quality review.

**Preconditions** — AMPED-11A merged.

**Allowed scope** — any page or component for accessibility or performance fixes only,
`src/pages/500.astro` (new), `src/styles/**`, `tests/a11y/**` (new),
`Docs/AMPED-11-QUALITY-REVIEW.md` (new).

**Forbidden scope** — business logic, services, payment, door logic, schema. Presentation only.

**Implementation requirements**
1. Automated accessibility audit on every route, at phone, tablet and desktop widths. WCAG 2.2 AA.
2. Keyboard-only walkthrough of both critical journeys: buy a ticket, and create a promotion.
3. Contrast verified against the real tokens. Reduced motion respected. Alt text everywhere.
4. Self-host the web font (R14) and remove the Google Fonts request.
5. Core Web Vitals measured and recorded for the homepage, an event page and the admin dashboard.
6. 404 and 500 pages, correct status codes, no stack traces in production.

**Tests required** — axe-style audit passing on every route at three widths; keyboard traversal of both
journeys; reduced-motion assertion; a test that no page uses colour as the only status signal; 404 and
500 return the right codes.

**Acceptance criteria** — the quality checklist evidenced item by item. `npm run verify` green.

**Stop conditions** — If an accessibility fix requires changing a business rule.

---

### AMPED-11C — Legal and customer pages

**Objective** — Legal content finalised from the AMPED-01 drafts.

**Preconditions** — supervisor has supplied reviewed copy.

**Allowed scope** — `src/pages/privacy.astro`, `src/pages/ticket-terms.astro`,
`src/pages/accessibility.astro`, `src/pages/about.astro`, `src/lib/site.ts` (company details).

**Forbidden scope** — everything else.

**Implementation requirements** — replace the placeholder copy with the supplied text; remove the draft
callouts; add company registration details, refund and cancellation wording, and a cookie policy if one
proves necessary.

**Tests required** — no page still renders a "Draft" callout; contact details resolve; internal links
resolve.

**Acceptance criteria** — no placeholder legal text remains anywhere.

**Stop conditions** — **If reviewed copy has not been supplied, stop.** Do not write legal text.

---

## Phase 12 — Staging certification

### AMPED-12 — Full lifecycle certification

**Objective** — Execute the governing plan's real V1 acceptance test end to end on staging.

**Preconditions** — every prior slice merged. A complete staging environment. **No production resource.**

**Allowed scope** — `tests/e2e/**` (new), `Docs/AMPED-12-CERTIFICATION.md` (new).
Defects found are reported, **not fixed in this slice**.

**Forbidden scope** — all application code. This slice observes; it does not repair.

**Implementation requirements** — automate the governing plan's §AMPED-12 scenario:

*Operator logs in → creates venue → creates bands → creates gig → uploads poster → creates ticket
allocation → previews → publishes.
Customer discovers the gig → chooses 2 tickets → checks out → payment succeeds → receives confirmation →
receives two QR tickets.
Door: first ticket scans and is accepted → second scans and is accepted → first scans again and is
rejected as already used.
After the event: it moves into Past Gigs → photographs are added → the photography gallery link is added.*

Plus every failure case the plan lists: payment failure, expired checkout, duplicate webhook, sold-out
event, cancelled event, postponed event, bad QR, lost email with manual lookup, two simultaneous scans.

**Tests required** — the full scenario as one automated run, plus each failure case. Every step evidenced.

**Acceptance criteria** — the whole scenario passes unattended, and every failure case behaves as
specified. Defects are listed in the certification document with severity and a proposed slice.

**Stop conditions** — Any failure in the core purchase or admission path halts certification immediately.
Do not patch and continue.

---

## Phase 13 — Production (supervisor only)

### AMPED-13 — Production and handover

**Not a DeepSeek slice.** Production D1, R2, domain, Access users, SumUp production credentials, email
domain, Turnstile keys, backups, monitoring, the first low-value real transaction and the first real
ticket email are all handled by the supervisor and the owner.

DeepSeek's remaining contribution is the operator guide, written **only after** AMPED-12 passes:
creating a gig, changing a gig, selling tickets, cancelling and postponing, uploading photos, door
scanning, guest list, finding an order.

Per the governing plan: **if that guide runs long, the admin is too complicated and that is a defect,
not a documentation problem.**

---

## Part D — Slice summary

| # | Slice | Objective | Depends on |
|---|---|---|---|
| 1 | AMPED-02A | D1 schema and migration baseline | AMPED-01 |
| 2 | AMPED-02B | Venue and artist persistence | 02A |
| 3 | AMPED-02C | Event and line-up persistence | 02B |
| 4 | AMPED-02D | Ticket types and inventory reads | 02C |
| 5 | AMPED-03A | Retire the fixture layer | 02D |
| 6 | AMPED-03B | Public rendering completeness | 03A |
| 7 | AMPED-03C | SEO, structured data, social previews | 03B |
| 8 | AMPED-04A | Cloudflare Access boundary | 03A |
| 9 | AMPED-04B | Gig create, edit and lifecycle | 04A |
| 10 | AMPED-04C | Artist and venue management | 04B |
| 11 | AMPED-04D | Duplicate Promotion | 04B |
| 12 | AMPED-05A | R2 media storage | 04A |
| 13 | AMPED-05B | Event galleries and photography links | 05A |
| 14 | AMPED-05C | Social post management | 05A |
| 15 | AMPED-06A | Order state machine | 02D |
| 16 | AMPED-06B | Ticket reservations | 06A |
| 17 | AMPED-06C | Oversell protection under concurrency | 06B |
| 18 | AMPED-07A | SumUp adapter skeleton | 06C |
| 19 | AMPED-07B | Hosted checkout creation | 07A |
| 20 | AMPED-07C | Webhook verification and idempotency | 07B |
| 21 | AMPED-07D | Payment reconciliation | 07C |
| 22 | AMPED-08A | Ticket issuance | 07C |
| 23 | AMPED-08B | QR admission credentials | 08A |
| 24 | AMPED-08C | Transactional email | 08B |
| 25 | AMPED-09A | Door scanner client | 08B, 04A |
| 26 | AMPED-09B | Atomic check-in | 09A |
| 27 | AMPED-09C | Manual lookup and guest list | 09B |
| 28 | AMPED-10A | Public enquiries with Turnstile | 03A |
| 29 | AMPED-10B | Mailing list | 10A, 08C |
| 30 | AMPED-10C | Cancellation and postponement | 04B, 08C, 10B |
| 31 | AMPED-11A | Security hardening | 10C |
| 32 | AMPED-11B | Accessibility, performance, errors | 11A |
| 33 | AMPED-11C | Legal and customer pages | supervisor copy |
| 34 | AMPED-12 | Full lifecycle certification | all |

Phases 02–05 and 10A can run partly in parallel once 02D lands. Phases 06→07→08→09 are strictly
sequential: that chain is the money and admission path and must not be parallelised.

---

## Part E — The three slices that decide whether V1 works

If review attention is limited, spend it here:

1. **AMPED-06C — oversell protection.** If this is wrong, the business sells tickets it does not have and
   has to turn paying customers away at the door.
2. **AMPED-07C — webhook verification and idempotency.** If this is wrong, the business either gives away
   free tickets or charges twice.
3. **AMPED-09B — atomic check-in.** If this is wrong, one ticket admits two people, and the count on the
   door is fiction.

Each has an explicit concurrency test as its acceptance criterion. **None of those tests may be relaxed
to make a slice pass.** If a test cannot be made to pass, that is a `BLOCKED / SUPERVISOR DECISION
REQUIRED`, not a reason to change the test.
