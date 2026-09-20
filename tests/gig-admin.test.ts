/**
 * AMPED-04B - gig create, edit, publish and lifecycle.
 *
 * Exercises the write seam the protected API calls: src/lib/validation.ts and
 * the D1 mutation service in src/services/d1/events.ts, against a throwaway
 * migrated and seeded database. Route protection itself is covered by
 * tests/access.test.ts; this file additionally enumerates the new API files to
 * prove they fall inside the protected namespace.
 */

import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openEphemeralDatabase } from '../src/db/local.ts';
import { migrate } from '../src/db/migrations.ts';
import { applySeed } from '../src/db/seed.ts';
import { createServices } from '../src/services/index.ts';
import { createD1GigMutations, type GigMutationService } from '../src/services/d1/events.ts';
import {
  assessReadiness,
  isAllowedTransition,
  londonLocalToUtcIso,
  parseGigInput,
  ConflictError,
  ValidationError,
  type ValidatedGigInput,
} from '../src/lib/validation.ts';
import { parsePoundsToPence } from '../src/lib/money.ts';
import { isProtectedPath } from '../src/lib/access.ts';
import type { Services } from '../src/services/contracts.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');
const OPERATOR = { email: 'anya@ampedupmusicpromo.co.uk', sub: 'access-subject-1' };

/** `datetime-local` value for an instant, in Europe/London. */
function toLocalInput(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

// Keep probe gigs comfortably in the future relative to the real clock: the
// public read path decides past/upcoming from the actual current time.
const PROBE_START = new Date(Date.now() + 120 * 86_400_000);

function draftPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Probe Gig',
    strapline: 'Amped Up presents',
    description: 'A probe gig used by the AMPED-04B tests to exercise real writes.',
    venueId: 'ven_lomax',
    doorsAt: toLocalInput(new Date(PROBE_START.getTime() - 30 * 60_000).toISOString()),
    startsAt: toLocalInput(PROBE_START.toISOString()),
    endsAt: toLocalInput(new Date(PROBE_START.getTime() + 3 * 3_600_000).toISOString()),
    ageRestriction: '16-plus',
    accessibilityNotes: 'Level access at the probe venue entrance.',
    internalNotes: 'Probe internal note.',
    links: { instagram: 'https://example.com/ig' },
    photographyCredit: 'AnyaParallax',
    lineup: ['art_glass_hearts'],
    ticketTypes: [{ name: 'General Admission', price: '10', capacity: '100', max: '6' }],
    guestList: '10',
    ...overrides,
  };
}

function parseOrThrow(payload: Record<string, unknown>): ValidatedGigInput {
  const parsed = parseGigInput(payload);
  if (!parsed.ok) throw new Error(`unexpected invalid payload: ${JSON.stringify(parsed.fields)}`);
  return parsed.value;
}

describe('money parsing', () => {
  it('parses pounds to integer pence and rejects impossible values', () => {
    expect(parsePoundsToPence('10')).toBe(1000);
    expect(parsePoundsToPence('10.00')).toBe(1000);
    expect(parsePoundsToPence('0')).toBe(0);
    expect(parsePoundsToPence('8.5')).toBe(850);
    expect(parsePoundsToPence('£10.00')).toBe(1000);
    expect(parsePoundsToPence('10.999')).toBeNull();
    expect(parsePoundsToPence('-5')).toBeNull();
    expect(parsePoundsToPence('ten')).toBeNull();
    expect(parsePoundsToPence('')).toBeNull();
  });
});

describe('Europe/London local time conversion', () => {
  it('stores winter GMT wall time as the same UTC hour', () => {
    expect(londonLocalToUtcIso('2026-01-15T19:30')).toBe('2026-01-15T19:30:00.000Z');
  });

  it('stores summer BST wall time one hour earlier in UTC', () => {
    expect(londonLocalToUtcIso('2026-06-15T19:30')).toBe('2026-06-15T18:30:00.000Z');
  });

  it('rejects a malformed or impossible local time', () => {
    expect(londonLocalToUtcIso('2026-02-31T10:00')).toBeNull();
    expect(londonLocalToUtcIso('not a date')).toBeNull();
    expect(londonLocalToUtcIso('')).toBeNull();
  });

  it('rejects the nonexistent spring-forward hour rather than shifting it', () => {
    // 2026-03-29: London clocks jump 01:00 -> 02:00, so 01:30 never happens.
    expect(londonLocalToUtcIso('2026-03-29T01:30')).toBeNull();
  });
});

describe('status transitions', () => {
  it('allows the V1 transitions and refuses the invented ones', () => {
    expect(isAllowedTransition('draft', 'published')).toBe(true);
    expect(isAllowedTransition('draft', 'archived')).toBe(true);
    expect(isAllowedTransition('published', 'postponed')).toBe(true);
    expect(isAllowedTransition('published', 'cancelled')).toBe(true);
    expect(isAllowedTransition('published', 'completed')).toBe(true);
    expect(isAllowedTransition('postponed', 'archived')).toBe(true);
    expect(isAllowedTransition('cancelled', 'archived')).toBe(true);
    expect(isAllowedTransition('completed', 'archived')).toBe(true);

    expect(isAllowedTransition('cancelled', 'published')).toBe(false);
    expect(isAllowedTransition('postponed', 'published')).toBe(false);
    expect(isAllowedTransition('published', 'draft')).toBe(false);
    expect(isAllowedTransition('archived', 'published')).toBe(false);
    // A same-status edit is not a transition.
    expect(isAllowedTransition('published', 'published')).toBe(true);
  });
});

describe('gig administration against D1', () => {
  let database: Awaited<ReturnType<typeof openEphemeralDatabase>>;
  let db: D1Database;
  let services: Services;
  let mutations: GigMutationService;
  let counter = 0;

  beforeAll(async () => {
    database = await openEphemeralDatabase();
    db = database.db;
    await migrate(db);
    await applySeed(db);
    services = createServices(db);
    mutations = createD1GigMutations(
      db,
      () => FIXED_NOW,
      (prefix) => `${prefix}_probe${++counter}`,
    );
  });

  afterAll(async () => {
    await database.dispose();
  });

  async function auditFor(eventId: string) {
    const { results } = await db
      .prepare('select action, actor_email, summary from audit_log where entity_id = ? order by occurred_at')
      .bind(eventId)
      .all<{ action: string; actor_email: string; summary: string }>();
    return results;
  }

  async function createDraft(overrides: Record<string, unknown> = {}) {
    const input = parseOrThrow(draftPayload(overrides));
    return mutations.create(input, OPERATOR);
  }

  it('creates a draft with a generated unique slug and an audit row', async () => {
    const created = await createDraft({ title: 'The Probe Headliners' });
    const row = await db
      .prepare('select status, slug, published_at from events where id = ?')
      .bind(created.id)
      .first<{ status: string; slug: string; published_at: string | null }>();

    expect(row?.status).toBe('draft');
    expect(row?.published_at).toBeNull();
    expect(created.slug).toBe('the-probe-headliners');

    const audit = await auditFor(created.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('event.created');
    expect(audit[0]?.actor_email).toBe(OPERATOR.email);
  });

  it('handles a slug collision deterministically', async () => {
    const first = await createDraft({ title: 'Collision Night' });
    const second = await createDraft({ title: 'Collision Night' });

    expect(first.slug).toBe('collision-night');
    expect(second.slug).toBe('collision-night-2');
    expect(second.id).not.toBe(first.id);
  });

  it('rejects invalid input before any write', async () => {
    const before = await db.prepare('select count(*) as n from events').first<{ n: number }>();

    const bad = parseGigInput(draftPayload({ title: 'x' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.fields.title).toBeTruthy();

    const badMoney = parseGigInput(
      draftPayload({ ticketTypes: [{ name: 'GA', price: '10.999', capacity: '10' }] }),
    );
    expect(badMoney.ok).toBe(false);
    if (!badMoney.ok) expect(Object.keys(badMoney.fields).some((k) => k.includes('price'))).toBe(true);

    const badDate = parseGigInput(draftPayload({ startsAt: '2026-03-29T01:30' }));
    expect(badDate.ok).toBe(false);

    const after = await db.prepare('select count(*) as n from events').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('refuses a venue that does not exist', async () => {
    const input = parseOrThrow(draftPayload({ venueId: 'ven_not_real' }));
    await expect(mutations.create(input, OPERATOR)).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not leave a half-created event when a child insert fails', async () => {
    const input = parseOrThrow(
      draftPayload({
        title: 'Atomic Probe',
        linkInstagram: undefined,
        lineup: ['art_not_real'],
      }),
    );
    await expect(mutations.create(input, OPERATOR)).rejects.toBeInstanceOf(ValidationError);

    const row = await db.prepare("select id from events where slug = 'atomic-probe'").first();
    expect(row).toBeNull();
  });

  it('edits a draft and regenerates its slug, and writes audit', async () => {
    const created = await createDraft({ title: 'Draft Before Edit' });
    const input = parseOrThrow(draftPayload({ title: 'Draft After Edit' }));
    await mutations.update(created.id, input, OPERATOR);

    const row = await db
      .prepare('select title, slug from events where id = ?')
      .bind(created.id)
      .first<{ title: string; slug: string }>();
    expect(row?.title).toBe('Draft After Edit');
    expect(row?.slug).toBe('draft-after-edit');

    const audit = await auditFor(created.id);
    expect(audit.map((entry) => entry.action)).toContain('event.updated');
  });

  it('publishes a draft once it is ready, and the public read path sees it', async () => {
    const created = await createDraft({ title: 'Ready To Publish' });
    await mutations.publish(created.id, OPERATOR);

    const view = await services.events.getBySlug('ready-to-publish');
    expect(view).not.toBeNull();
    expect(view?.status).toBe('published');
    expect((await services.events.listUpcoming()).some((event) => event.id === created.id)).toBe(
      true,
    );

    const audit = await auditFor(created.id);
    expect(audit.some((entry) => entry.action === 'event.published')).toBe(true);
  });

  it('refuses to publish an unready draft', async () => {
    const input = parseOrThrow(
      draftPayload({ title: 'Not Ready', lineup: [], ticketTypes: [] }),
    );
    const created = await mutations.create(input, OPERATOR);

    await expect(mutations.publish(created.id, OPERATOR)).rejects.toBeInstanceOf(ValidationError);
    const row = await db.prepare('select status from events where id = ?').bind(created.id).first<{ status: string }>();
    expect(row?.status).toBe('draft');
  });

  it('keeps a published slug stable across a title edit', async () => {
    const created = await createDraft({ title: 'Stable Slug Gig' });
    await mutations.publish(created.id, OPERATOR);

    const renamed = parseOrThrow(draftPayload({ title: 'Renamed After Publish' }));
    const result = await mutations.update(created.id, renamed, OPERATOR);

    expect(result.slug).toBe('stable-slug-gig');
    const row = await db.prepare('select slug from events where id = ?').bind(created.id).first<{ slug: string }>();
    expect(row?.slug).toBe('stable-slug-gig');
    expect(await services.events.getBySlug('stable-slug-gig')).not.toBeNull();
    expect(await services.events.getBySlug('renamed-after-publish')).toBeNull();
  });

  it('enforces the capacity floor against sold and held stock', async () => {
    const summary = await services.admin.salesSummary('evt_glass_hearts_nov');
    expect(summary.sold).toBeGreaterThan(0);

    const event = await services.admin.getById('evt_glass_hearts_nov');
    expect(event).not.toBeNull();
    const publicType = event!.ticketTypes.find((type) => type.id === 'tt_gh_ga');
    expect(publicType).toBeDefined();
    const committed = publicType!.inventory.sold + publicType!.inventory.reserved;

    const build = (capacity: number) =>
      parseOrThrow({
        title: event!.title,
        strapline: event!.strapline,
        description: event!.description,
        venueId: event!.venue.id,
        doorsAt: toLocalInput(event!.doorsAt),
        startsAt: toLocalInput(event!.startsAt),
        endsAt: event!.endsAt ? toLocalInput(event!.endsAt) : undefined,
        ageRestriction: event!.ageRestriction,
        accessibilityNotes: event!.accessibilityNotes,
        guestList: '11',
        lineup: event!.lineup.map((entry) => entry.artist.id),
        ticketTypes: event!.ticketTypes.map((ticket) => ({
          id: ticket.id,
          name: ticket.name,
          price: (ticket.priceInPence / 100).toFixed(2),
          capacity: String(ticket.id === 'tt_gh_ga' ? capacity : ticket.inventory.capacity),
          max: String(ticket.maxPerOrder),
        })),
      });

    await expect(
      mutations.update('evt_glass_hearts_nov', build(committed - 1), OPERATOR),
    ).rejects.toBeInstanceOf(ConflictError);

    // Raising capacity is allowed.
    await mutations.update('evt_glass_hearts_nov', build(committed + 50), OPERATOR);
    const after = await db
      .prepare('select capacity from ticket_types where id = ?')
      .bind('tt_gh_ga')
      .first<{ capacity: number }>();
    expect(after?.capacity).toBe(committed + 50);
  });

  it('does not rewrite captured order-item price or name when a ticket type is edited', async () => {
    const before = await db
      .prepare(
        "select unit_price_in_pence, ticket_type_name from order_items where ticket_type_id = 'tt_gh_ga' limit 1",
      )
      .first<{ unit_price_in_pence: number; ticket_type_name: string }>();
    expect(before).toBeTruthy();

    const event = await services.admin.getById('evt_glass_hearts_nov');
    const input = parseOrThrow({
      title: event!.title,
      description: event!.description,
      venueId: event!.venue.id,
      doorsAt: toLocalInput(event!.doorsAt),
      startsAt: toLocalInput(event!.startsAt),
      endsAt: event!.endsAt ? toLocalInput(event!.endsAt) : undefined,
      ageRestriction: event!.ageRestriction,
      guestList: '11',
      lineup: event!.lineup.map((entry) => entry.artist.id),
      ticketTypes: event!.ticketTypes.map((ticket) => ({
        id: ticket.id,
        name: `${ticket.name} (renamed)`,
        price: '12.00',
        capacity: String(ticket.inventory.capacity),
        max: String(ticket.maxPerOrder),
      })),
    });
    await mutations.update('evt_glass_hearts_nov', input, OPERATOR);

    const after = await db
      .prepare(
        "select unit_price_in_pence, ticket_type_name from order_items where ticket_type_id = 'tt_gh_ga' limit 1",
      )
      .first<{ unit_price_in_pence: number; ticket_type_name: string }>();
    expect(after).toEqual(before);
  });

  it('applies legal lifecycle transitions and audits them', async () => {
    const created = await createDraft({ title: 'Lifecycle Gig' });
    await mutations.publish(created.id, OPERATOR);

    await mutations.transition(created.id, 'postponed', 'published', OPERATOR, {
      statusMessage: 'Moved to a new date.',
    });
    let row = await db.prepare('select status, status_message from events where id = ?').bind(created.id).first<{ status: string; status_message: string }>();
    expect(row?.status).toBe('postponed');
    expect(row?.status_message).toBe('Moved to a new date.');

    await mutations.transition(created.id, 'archived', 'postponed', OPERATOR);
    const archived = await db
      .prepare('select status from events where id = ?')
      .bind(created.id)
      .first<{ status: string }>();
    expect(archived?.status).toBe('archived');

    const audit = await auditFor(created.id);
    expect(audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['event.published', 'event.postponed', 'event.archived']),
    );
  });

  it('refuses an illegal transition without mutating state', async () => {
    const created = await createDraft({ title: 'Illegal Transition' });
    await mutations.publish(created.id, OPERATOR);

    await expect(
      mutations.transition(created.id, 'draft', 'published', OPERATOR),
    ).rejects.toBeInstanceOf(ValidationError);

    const row = await db.prepare('select status from events where id = ?').bind(created.id).first<{ status: string }>();
    expect(row?.status).toBe('published');
  });

  it('requires a message to cancel or postpone', async () => {
    const created = await createDraft({ title: 'Needs Message' });
    await mutations.publish(created.id, OPERATOR);

    await expect(
      mutations.transition(created.id, 'cancelled', 'published', OPERATOR),
    ).rejects.toBeInstanceOf(ValidationError);
    const row = await db.prepare('select status from events where id = ?').bind(created.id).first<{ status: string }>();
    expect(row?.status).toBe('published');
  });

  it('treats a stale expected status as a conflict, not a silent overwrite', async () => {
    const created = await createDraft({ title: 'Stale Request' });
    await mutations.publish(created.id, OPERATOR);

    // The gig is published; a stale tab that still thinks it is a draft tries
    // to publish again. The transition is legal, but the expected-from guard
    // fails, so the audit records nothing.
    await expect(
      mutations.transition(created.id, 'published', 'draft', OPERATOR),
    ).rejects.toBeInstanceOf(ConflictError);

    // Exactly one publish audit: the stale request recorded nothing.
    const audit = await auditFor(created.id);
    expect(audit.filter((entry) => entry.action === 'event.published')).toHaveLength(1);
  });

  it('lets cancellation stop public sales and keep the gig visible as cancelled', async () => {
    const created = await createDraft({ title: 'Cancelled On Sale' });
    await mutations.publish(created.id, OPERATOR);
    expect((await services.events.listOnSale()).some((event) => event.id === created.id)).toBe(true);

    await mutations.transition(created.id, 'cancelled', 'published', OPERATOR, {
      statusMessage: 'The venue has closed.',
    });

    const view = await services.events.getBySlug('cancelled-on-sale');
    expect(view?.status).toBe('cancelled');
    expect(view?.onSale).toBe(false);
    expect(view?.ticketTypes.every((ticket) => !ticket.purchasable)).toBe(true);
    // The gig stays visible in the diary, wearing its cancelled notice.
    expect((await services.events.listUpcoming()).some((event) => event.id === created.id)).toBe(true);
  });

  it('deletes a bare draft but never one with commercial history', async () => {
    const bare = await createDraft({ title: 'Deletable Draft' });
    await mutations.remove(bare.id, OPERATOR);
    expect(await db.prepare('select id from events where id = ?').bind(bare.id).first()).toBeNull();
    expect((await auditFor(bare.id)).some((entry) => entry.action === 'event.deleted')).toBe(true);

    const withOrder = await createDraft({ title: 'Draft With Order' });
    await db
      .prepare(
        `insert into orders (id, reference, event_id, customer_name, customer_email, status, total_in_pence, fee_in_pence, paid_at, marketing_opt_in, created_at, updated_at)
         values ('ord_probe', 'AMP-PROBE-1', ?, 'Probe Buyer', 'probe@example.com', 'paid', 1000, 0, ?, 0, ?, ?)`,
      )
      .bind(withOrder.id, FIXED_NOW.toISOString(), FIXED_NOW.toISOString(), FIXED_NOW.toISOString())
      .run();

    await expect(mutations.remove(withOrder.id, OPERATOR)).rejects.toBeInstanceOf(ConflictError);
    expect(await db.prepare('select id from events where id = ?').bind(withOrder.id).first()).not.toBeNull();
  });

  it('refuses to hard-delete a published gig', async () => {
    const created = await createDraft({ title: 'Published Not Deletable' });
    await mutations.publish(created.id, OPERATOR);

    await expect(mutations.remove(created.id, OPERATOR)).rejects.toBeInstanceOf(ConflictError);
    expect(await db.prepare('select id from events where id = ?').bind(created.id).first()).not.toBeNull();
  });

  it('records the verified operator and never a token in the audit log', async () => {
    const created = await createDraft({ title: 'Audit Identity' });
    const audit = await auditFor(created.id);

    expect(audit[0]?.actor_email).toBe(OPERATOR.email);
    const raw = JSON.stringify(audit);
    expect(raw).not.toMatch(/eyJ|bearer|jwt|token/i);
  });

  it('reports readiness with artwork as a warning, not a blocker', async () => {
    const created = await createDraft({ title: 'Readiness Probe' });
    const report = await mutations.readiness(created.id);
    expect(report.ready).toBe(true);
    expect(report.warnings.some((warning) => /poster/i.test(warning))).toBe(true);

    const empty = parseOrThrow(draftPayload({ title: 'Empty Readiness', lineup: [], ticketTypes: [] }));
    const emptyCreated = await mutations.create(empty, OPERATOR);
    const emptyReport = await mutations.readiness(emptyCreated.id);
    expect(emptyReport.ready).toBe(false);
    expect(emptyReport.blockers.length).toBeGreaterThan(0);
  });

  it('keeps assessReadiness honest about a missing line-up and tickets', async () => {
    const created = await createDraft({ title: 'Assess Probe' });
    const view = await services.admin.getById(created.id);
    const report = assessReadiness(view!, view!.venue.accessibilityInfo);
    expect(report.ready).toBe(true);
  });
});

describe('API route protection', () => {
  function routeFiles(dir: string): string[] {
    if (!statSync(dir, { throwIfNoEntry: false })) return [];
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return routeFiles(full);
      return /\.(ts|astro)$/.test(entry) && !entry.startsWith('_') ? [full] : [];
    });
  }

  function toRoutePath(file: string): string {
    const relative = file
      .slice(join(root, 'src', 'pages').length)
      .replace(/\\/g, '/')
      .replace(/\.(ts|astro)$/, '')
      .replace(/\/index$/, '');
    return relative.replace(/\[([^\]]+)\]/g, ':$1') || '/';
  }

  it('places every new gig admin API route inside the protected namespace', () => {
    const files = routeFiles(join(root, 'src', 'pages', 'api', 'admin'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const route = toRoutePath(file);
      expect(isProtectedPath(route), `${file} -> ${route}`).toBe(true);
    }
    expect(isProtectedPath('/api/admin/gigs')).toBe(true);
    expect(isProtectedPath('/api/admin/gigs/evt_1/publish')).toBe(true);
    expect(isProtectedPath('/api/admin/gigs/evt_1/lifecycle')).toBe(true);
  });
});
