# AMPED-01 — Scaffold Report

**Slice:** AMPED-01 — Claude Visual Scaffold
**Owner:** Claude Opus
**Branch:** `claude/amped-01-visual-scaffold`
**Companions:** `AMPED-01-ARCHITECTURE-NOTES.md`, `AMPED-DEEPSEEK-BUILD-PLAN.md`

---

## 1. Starting repository state

| | |
|---|---|
| Repository | `D:\Users\fleur\AmpedUpMusic` |
| Remote | `https://github.com/hourwise/AmpedUpMusic.git` |
| Branch at start | `main` |
| Starting SHA | `9cf7a778e83398f784bda9b3631d33f3fc663356` ("first commit") |
| Tracked files | 1 — `README.md` (a UTF-16 stub containing only the repository name) |
| Untracked | `Docs/Amped Up Music Promotions — V1 Build Plan.md` |
| Worktree | Clean apart from that one untracked document |

**Runtime available:** Node 24.12.0, npm 11.7.0, git 2.45.1.windows.1, Windows 11 Pro 26100.

The governing build plan was untracked at the start of this run. It has been **left byte-for-byte
unchanged** and is now committed alongside the scaffold.

---

## 2. Governing document

**File read in full:** `Docs/Amped Up Music Promotions — V1 Build Plan.md` (17,768 bytes).

Treated as authoritative. No internal contradictions were found. Four under-specified points are
recorded in `AMPED-01-ARCHITECTURE-NOTES.md` §5 rather than silently decided, and three implementation
mechanisms differ from what the plan assumed because the relevant libraries changed after it was written
(architecture notes §1) — none of which alters the specified architecture.

---

## 3. Scaffold created

### 3.1 Stack

Astro 7.3.3 · TypeScript 5.9 · `@astrojs/cloudflare` 14.3.2 · Wrangler 4.135 · Vitest 5.0.1.
Target: Cloudflare Workers with Static Assets, `output: 'server'` with four prerendered static pages.

Five runtime/dev dependencies in total. No CSS framework, no component library, no icon package, no date
library, no state manager. The design system is hand-built on CSS custom properties.

Astro 7 is newer than my training data, so the baseline was generated from the official `npm create
astro@latest` template and the adapter, routing and binding conventions were verified against current
documentation rather than assumed.

### 3.2 Public routes (15)

| Route | Notes |
|---|---|
| `/` | Next-gig hero, upcoming grid, gallery strip, archive, socials, about, mailing-list CTA |
| `/gigs` | All announced gigs |
| `/gigs/[slug]` | The core event page. 301s to `/past-gigs/…` once finished |
| `/tickets` | Price and availability comparison across every on-sale gig |
| `/past-gigs` | Archive, populated automatically by date |
| `/past-gigs/[slug]` | Completed gig with gallery and lightbox |
| `/gallery` | Photographs grouped by night |
| `/artists` | Artist directory |
| `/artists/[slug]` | Individual artist (optional in the plan — built; see notes §5) |
| `/about` | Promoter story plus the venue list, read from venue records |
| `/promote-with-us` | Artist and venue enquiry form |
| `/contact` | Contact form and routes |
| `/privacy` | Draft privacy notice |
| `/ticket-terms` | Draft ticket terms |
| `/accessibility` | Venue-by-venue access plus website accessibility statement |
| `/404` | Custom, with upcoming gigs |

### 3.3 Admin routes (12)

| Route | Notes |
|---|---|
| `/admin` | Dashboard: next gig, four primary actions, glance stats, recent orders, activity |
| `/admin/gigs` | Full diary including drafts, with sold/capacity per row |
| `/admin/gigs/new` | Create Promotion — four steps |
| `/admin/gigs/[id]` | Edit, sales summary, Duplicate, lifecycle actions |
| `/admin/orders` | Search by name, email, order reference or ticket reference |
| `/admin/artists` | Artist directory with add form |
| `/admin/venues` | Venue directory with required accessibility field |
| `/admin/media` | Photos grouped by gig, alt text editable inline |
| `/admin/enquiries` | Inbox, spam kept and flagged |
| `/admin/mailing-list` | Consent evidence, growth chart, suppression states |
| `/admin/door` | Choose tonight's gig |
| `/admin/door/[eventId]` | Door Mode: Scan / Look up / Guests |

### 3.4 Components (32)

**Site chrome** — `SiteHeader` (sticky, with an always-visible Tickets CTA and a native `<dialog>` mobile
menu), `SiteFooter`, `Wordmark` (type-led, with a level-meter glyph), `PageHeader`, `SocialLinks`,
`SocialStrip`, `NotFound`.

**Events** — `EventCard` (stacked and feature layouts), `EventHero` (event and homepage variants),
`PosterImage` (real artwork or a designed placeholder), `TicketPanel` (steppers, live total, inert
checkout), `AvailabilityBadge`, `Lineup`, `VenuePanel`, `ShareRow` (Web Share API with clipboard
fallback), `StickyBuyBar`.

**UI** — `Button` (5 variants × 4 sizes, ≥44px at every size), `Badge`, `Section`, `Field` (label, hint,
error, required announcement, prefix/suffix), `Callout`, `EmptyState`, `ConfirmDialog`, `ScaffoldNote`.

**Admin** — `AdminIcon` (16 inline paths), `StatCard`, `StatusBadge`, `DataTable`, `PromotionForm`,
`ScannerResult`.

**Gallery / artists** — `GalleryGrid` (native `<dialog>` lightbox with arrow-key navigation), `ArtistCard`.

**Layouts** — `BaseLayout` → `SiteLayout` | `AdminLayout` | `DoorLayout`.

### 3.5 Visual system

Defined in `src/styles/tokens.css` and `src/styles/base.css`.

- **Palette** — near-black surfaces (`#08080B` → `#1E1E28`) with a stage-lighting accent set. The primary
  accent is *Volt* `#E8FF3A`: uncommon, reads as a lighting rig rather than a brand guideline, and gives
  roughly 16:1 contrast with black text so the Buy Tickets action is both the loudest and the most legible
  thing on the page. Secondary accents: stage pink, cyan, violet, ember.
- **Typography** — one variable family (Archivo) carrying both the condensed poster headlines
  (`font-stretch: 78%`, weight 800–900, uppercase) and the body copy. One webfont request, no mismatched
  pairing. Fluid `clamp()` scale from a 360px phone to 1440px.
- **Atmosphere** — a single fixed film-grain overlay at 4.5% opacity, and a fixed three-point "stage wash"
  of soft radial gradients. Content scrolls through the light rather than the light moving.
- **Motion** — subtle and optional. All durations collapse to 1ms under `prefers-reduced-motion`, and the
  scroll reveal is progressive enhancement: with no JavaScript the content is simply visible.
- **Contrast** — `prefers-contrast: more` hardens hairlines and brightens muted text.

Explicitly avoided: flames, distressed type, torn edges, grunge textures, and generic dark-SaaS styling.

### 3.6 Mock data

`src/data/fixtures/` — replaced wholesale in AMPED-03A.

- **4 venues** in real North West towns with invented addresses, each with genuine accessibility copy —
  including one room that is honestly described as "down twelve steps with no lift", because pretending
  otherwise is worse than saying it.
- **10 artists** with biographies, genres and `example.com` links (nothing points at a real account).
- **12 events** covering every state the UI has to render: selling fast, sold out, mixed (early bird gone
  / GA on sale), postponed, last few, not yet on sale, cancelled, draft-with-no-artwork, and four
  completed gigs with galleries.
- **~630 orders / ~1,575 tickets**, generated deterministically from a seeded LCG so the admin tables,
  dashboard totals and door lookup are consistent with each other and identical on every machine.
- **43 media assets**, **6 social posts**, **6 enquiries** (including one spam), **20 subscribers**.

**Dates are offsets from today, not fixed calendar dates.** The next gig is always about a fortnight
away and the archive is always genuinely in the past, whenever anyone opens the scaffold. Gigs land on
Fridays and Saturdays; all-dayers on Saturdays.

**Artwork is generated, not sourced.** `scripts/generate-artwork.mjs` produces 43 abstract
stage-lighting SVGs (7 palettes × 7 motifs) at real poster (3:4), hero (16:9), square and wide ratios —
364 KB total. Self-contained, no third-party image host, no unlicensed photographs.

### 3.7 Architecture contracts

`src/types/domain.ts` — the storage-agnostic model: `Venue`, `Artist`, `EventLineupEntry`, `Event`,
`PhotographyCredit`, `TicketType`, `TicketInventory`, `AvailabilityState`, `Order`, `OrderItem`,
`Ticket`, `CheckIn`, `ScanResult`, `MediaAsset`, `SocialPost`, `Enquiry`, `MailingListSubscriber`,
`AuditLogEntry`. Money is `Pence` (integer). Timestamps are ISO-8601 UTC.

`src/types/view.ts` — the joined shapes components actually receive: `EventView`, `TicketTypeView`,
`LineupEntryView`, `EventSalesSummary`, `OrderView`, `SocialPostView`, `EnquiryView`, `SubscriberView`.

`src/services/contracts.ts` — the seam: `PublicEventService`, `ArtistService`, `VenueService`,
`MediaService`, `SocialService`, `AdminEventService`, `OrderService`, `DoorService`, `EnquiryService`,
`MailingListService`, `AuditService`, plus the two future integration boundaries `PaymentProvider` and
`TicketEmailProvider`.

Every method is `async` even where the fixture implementation is synchronous, so the signatures survive
the move to D1 unchanged.

Rules encoded in the types themselves rather than in prose:
- `OrderStatus` documents that `paid` may only be entered from a server-side provider confirmation.
- `DoorService.checkIn` documents the atomicity requirement, and the fixture implementation carries a
  doc comment stating it is **not** atomic.
- `MediaAsset.alt` is required, not optional.
- `TicketInventory` is the only source of availability arithmetic; no UI computes `capacity − sold`.

---

## 4. Validation

All commands run from a clean install on the branch.

| Check | Command | Result |
|---|---|---|
| Dependency install | `npm install` | **PASS** — 319 packages, 0 vulnerabilities reported |
| Type check | `npx astro check` | **PASS** — 89 files, 0 errors, 0 warnings, 0 hints |
| Lint | — | **NOT CONFIGURED** — see §6 |
| Unit and contract tests | `npx vitest run` | **PASS** — 5 files, **123 tests**, 0 failures |
| Production build | `npm run build` | **PASS** — server built in ~2.5s, 4 pages prerendered |
| Route rendering | dev server + browser | **PASS** — every route rendered, 0 console errors |

### Test coverage

| File | Tests | Covers |
|---|---|---|
| `availability.test.ts` | 21 | Threshold boundaries, reserved-stock guard, sale-window precedence, cancelled-event override, roll-up, presentation distinctness |
| `money.test.ts` | 14 | Formatting, "Free", parsing rejection cases, integer guarantee, float-free addition |
| `dates.test.ts` | 19 | GMT/BST, 24-hour clock, late-night day assignment, calendar-day arithmetic, relative labels, `hasFinished` |
| `services.test.ts` | 41 | **Contract tests** — draft leakage, ordering, canonical URLs, sellability, guest-list hiding, fixture integrity, sales arithmetic, order search, door outcomes including double-scan and wrong-event |
| `routes.test.ts` | 28 | Every route named in the build plan, every nav link, every admin route, every fixture slug, artwork presence |

`services.test.ts` is written against the **service contracts**, not the fixtures. It should survive the
D1 swap in AMPED-03A unchanged — that is its purpose, and the DeepSeek plan states that editing it to
make a slice pass is a scope violation.

### Browser verification

Verified in the built-in browser at mobile (375×812), tablet and desktop widths:

- **Mobile navigation** — burger opens a native `<dialog>`; the Tickets CTA stays visible beside it at
  every width and never folds into the menu.
- **Event hero** — poster, title, four-fact grid, Buy Tickets and price all above the fold on a 375px phone.
- **Tickets** — steppers increment, the total recalculates, sold-out types show "None left", the sticky
  buy bar appears once the hero scrolls away.
- **Create Promotion** — four tabs switch correctly; the Tickets step renders with the persistent
  Save draft / Preview / Publish bar.
- **Door Mode** — full-screen chrome, viewfinder with a sweeping scan line, demonstration buttons produce
  the VALID / ALREADY USED / INVALID states, the admission counter increments on a valid scan, and the
  bottom tab bar switches between Scan, Look up and Guests.

**Defects found and fixed during this run:**
1. Two ticket panels were rendering on the event page (duplicate `id="tickets"`, broken steppers). Fixed
   by restructuring the page into intro / tickets / rest with explicit desktop grid placement, so exactly
   one panel exists in the document.
2. `£1,380.00` clipped inside a dashboard stat card. Fixed with container-relative sizing.
3. Availability descriptions read "…for this event" when used at ticket-type level. Reworded to be
   level-neutral.
4. `formatFullDate` produced "Saturday, 14 November 2026" (ICU inserts a comma once a year is present),
   inconsistent with the rest of the site. Composed from parts instead.
5. A stray space before a full stop in the photography credit sentence.

---

## 5. Production safety

| | |
|---|---|
| Production Cloudflare resources created or modified | **NO** |
| D1 databases created or accessed | **NO** |
| R2 buckets created or accessed | **NO** |
| SumUp credentials accessed, stored or transmitted | **NO** |
| Real payments attempted | **NO** |
| Production databases touched | **NO** |
| Email credentials accessed | **NO** |
| Any secret created, read or stored | **NO** |
| Deployment performed | **NO** — `wrangler deploy` never run |
| Pushed to remote | **NO** |

`.dev.vars.example` contains empty placeholders only and `.dev.vars` is git-ignored. The D1, R2 and KV
bindings in `wrangler.jsonc` are **commented out** with the slice that should enable them named.
`git diff` was inspected for credential-shaped strings before committing.

---

## 6. Known limitations

**By design, per §16 of the brief:**

No D1, no migrations, no persistence. No R2 uploads. No Cloudflare Access — `Astro.locals.operator` falls
back to a hard-coded demo identity in `AdminLayout` (AMPED-04A removes it). No SumUp, no checkout, no
webhook. No email. No QR generation or verification. No check-in concurrency control. No mailing-list
delivery. No deployment.

Every inert control that looks finished carries a `ScaffoldNote` naming its implementing slice.
`grep -rn "ScaffoldNote\|data-mock" src/` enumerates them.

**Scaffold-specific:**

1. **No linter configured.** ESLint's Astro support was not verified against Astro 7 and adding a broken
   lint step would be worse than none. `astro check` provides type and template diagnostics, and
   `.editorconfig` covers formatting. Configuring ESLint + Prettier is a small, well-bounded early task.
2. **Google Fonts is a third-party runtime dependency.** Self-hosting is scheduled in AMPED-11B.
3. **The fixture door service is not atomic and is not persistent** — check-ins live in a module-level Set
   that disappears with the isolate. It carries a doc comment saying so.
4. **Order fixtures and the SALES counters are independently generated,** so the per-order item mix does
   not exactly reconstruct the counters. Both are internally consistent; the admin reads revenue from the
   counters. Real data makes this moot.
5. **Legal copy is a working draft** and is marked as such on the page.
6. **No end-to-end browser test suite.** Route coverage is asserted structurally in `routes.test.ts` and
   rendering was verified manually. Playwright-style E2E belongs with AMPED-12.
7. **Astro 7's compiler is strict** — malformed markup is a build error rather than being auto-corrected.
   Worth knowing before a worker agent starts editing templates.

---

## 7. Recommendations

Full detail in `AMPED-01-ARCHITECTURE-NOTES.md` §4. In brief:

**Needs a supervisor decision before the plan is frozen** — nine V1 recommendations (V1-1 … V1-9). The
two most valuable are **an order confirmation page carrying the tickets** (V1-1) and **self-service
"resend my tickets"** (V1-2): between them they remove most of the support inbox, and the build plan
mentions the confirmation page without specifying a route for it.

**Highest-risk slices** — AMPED-06C (oversell), AMPED-07C (webhook verification and idempotency) and
AMPED-09B (atomic check-in). Each has an explicit concurrency test as its acceptance criterion, and the
DeepSeek plan states that those tests may not be relaxed to make a slice pass.

**Watch for** — `Astro.locals.runtime.env` does not exist on this stack. Any instruction that assumes it
will fail.

---

## 8. Files changed

Everything is new. No pre-existing file was deleted or rewritten except `README.md`, which was a UTF-16
stub containing only the repository name and has been replaced with development documentation.

```
Configuration      package.json, package-lock.json, astro.config.mjs, tsconfig.json,
                   wrangler.jsonc, vitest.config.ts, .gitignore, .editorconfig,
                   .dev.vars.example, .claude/launch.json
Documentation      README.md (rewritten), Docs/AMPED-01-ARCHITECTURE-NOTES.md,
                   Docs/AMPED-DEEPSEEK-BUILD-PLAN.md, Docs/AMPED-01-SCAFFOLD-REPORT.md
Preserved          Docs/Amped Up Music Promotions — V1 Build Plan.md  (UNCHANGED)
Source             87 files under src/ — 28 pages, 32 components, 4 layouts,
                   6 lib modules, 3 type modules, 6 fixture modules, 4 service modules,
                   2 stylesheets, env.d.ts
Tests              5 files, 123 tests
Scripts            scripts/generate-artwork.mjs
Public             43 generated SVGs, favicon.svg, robots.txt
```

Roughly 16,200 lines under `src/`, plus tests and documentation.

---

## 9. Git state

| | |
|---|---|
| Final branch | `claude/amped-01-visual-scaffold` |
| Base | `9cf7a77` on `main` |
| Commits added | 1 |
| History rewritten | **No** |
| Force-push | **No** |
| Pushed | **No** — the governing document does not authorise it |
| Worktree at finish | Clean. `dist/`, `node_modules/`, `.astro/`, `.wrangler/` and `.dev.vars` are ignored |
| `main` | Untouched |

`Docs/Amped Up Music Promotions — V1 Build Plan.md` is committed exactly as supplied.
