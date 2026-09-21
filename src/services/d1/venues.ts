/**
 * D1-backed VenueService (AMPED-02B reads, AMPED-04C administration).
 *
 * The venue half of the persistence swap: pages keep calling
 * `getServices().venues.*` exactly as they did against the fixtures, and this
 * module is what answers when `env.DB` is bound.
 *
 * Rules this implementation holds to:
 *  - every statement names its columns explicitly (never `select *`);
 *  - an unknown slug resolves to `null`, never a throw;
 *  - ordering keeps its `localeCompare(..., 'en-GB')` tie-breaking;
 *  - a raw `VenueRow` never leaves this module - callers only ever see the
 *    storage-agnostic `Venue` from src/types/domain.ts.
 *
 * AMPED-04C adds `archived_at` mapping and the write side. Archiving never
 * changes an id or slug and never touches `events.venue_id`, so a retired room
 * stops being offered for new promotions while its history renders unchanged.
 */

import type { VenueRow } from '@/db/schema.ts';
import { slugify } from '@/lib/text.ts';
import {
  ConflictError,
  NotFoundError,
  type ValidatedVenueInput,
} from '@/lib/validation.ts';
import type { Venue } from '@/types/domain.ts';

import type { VenueService } from '../contracts.ts';
import type { GigOperator } from './events.ts';

/**
 * The row shape as selected here. `archived_at` arrives in migration 0007, and
 * src/db is frozen for this slice, so the column is typed locally rather than
 * by editing the accepted schema module.
 */
type VenueRowWithArchive = VenueRow & { archived_at: string | null };

/** The fields the `Venue` contract actually needs. Mirrors the migration. */
const VENUE_COLUMNS = [
  'id',
  'name',
  'slug',
  'address_line1',
  'address_line2',
  'city',
  'postcode',
  'standard_notes',
  'accessibility_info',
  'capacity',
  'website_url',
  'map_url',
  'archived_at',
  'created_at',
  'updated_at',
].join(', ');

const SELECT_VENUES_SQL = `select ${VENUE_COLUMNS} from venues order by name, id`;
const SELECT_VENUE_BY_SLUG_SQL = `select ${VENUE_COLUMNS} from venues where slug = ?1`;
const SELECT_ACTIVE_VENUES_SQL =
  `select ${VENUE_COLUMNS} from venues where archived_at is null order by name, id`;
const SELECT_VENUE_ROW_SQL = `select ${VENUE_COLUMNS} from venues where id = ?1`;

/**
 * Field order is irrelevant to equality, but optional keys are only present
 * when the column holds a value - exactly as the fixtures do it.
 */
export function toVenue(row: VenueRowWithArchive): Venue {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    addressLine1: row.address_line1,
    city: row.city,
    postcode: row.postcode,
    ...(row.address_line2 !== null ? { addressLine2: row.address_line2 } : {}),
    ...(row.standard_notes !== null ? { standardNotes: row.standard_notes } : {}),
    ...(row.accessibility_info !== null ? { accessibilityInfo: row.accessibility_info } : {}),
    ...(row.capacity !== null ? { capacity: row.capacity } : {}),
    ...(row.website_url !== null ? { websiteUrl: row.website_url } : {}),
    ...(row.map_url !== null ? { mapUrl: row.map_url } : {}),
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Identical wording to the fixture service, so page order cannot shift. */
const byName = (a: Venue, b: Venue): number => a.name.localeCompare(b.name, 'en-GB');

class D1VenueService implements VenueService {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<Venue[]> {
    const { results } = await this.db.prepare(SELECT_VENUES_SQL).all<VenueRowWithArchive>();
    return results.map(toVenue).sort(byName);
  }

  /** Active venues only - the new-promotion picker (AMPED-04C). */
  async listActive(): Promise<Venue[]> {
    const { results } = await this.db
      .prepare(SELECT_ACTIVE_VENUES_SQL)
      .all<VenueRowWithArchive>();
    return results.map(toVenue).sort(byName);
  }

  async getBySlug(slug: string): Promise<Venue | null> {
    const row = await this.db
      .prepare(SELECT_VENUE_BY_SLUG_SQL)
      .bind(slug)
      .first<VenueRowWithArchive>();
    return row ? toVenue(row) : null;
  }
}

/** The read service plus the active-only read the admin picker uses. */
export type VenueReadService = VenueService & { listActive(): Promise<Venue[]> };

/** Build the D1 venue service against a resolved binding. */
export function createD1VenueService(db: D1Database): VenueReadService {
  return new D1VenueService(db);
}

// ---------------------------------------------------------------------------
// AMPED-04C - venue administration (writes)
// ---------------------------------------------------------------------------

export interface VenueMutationService {
  create(input: ValidatedVenueInput, operator: GigOperator): Promise<{ id: string; slug: string }>;
  update(id: string, input: ValidatedVenueInput, operator: GigOperator): Promise<{ slug: string }>;
  archive(id: string, operator: GigOperator): Promise<void>;
  remove(id: string, operator: GigOperator): Promise<void>;
}

type IdFactory = (prefix: string) => string;
const defaultId: IdFactory = (prefix) => `${prefix}_${crypto.randomUUID()}`;

const SELECT_VENUE_REFERENCES_SQL = 'select count(*) as n from events where venue_id = ?1';
const AUDIT_SQL =
  'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
  'values (?1, ?2, ?3, ?4, ?5, ?6, ?7)';

class D1VenueMutations implements VenueMutationService {
  private lastStamp = 0;

  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: IdFactory = defaultId,
  ) {}

  async create(
    input: ValidatedVenueInput,
    operator: GigOperator,
  ): Promise<{ id: string; slug: string }> {
    const id = this.newId('ven');
    const slug = await this.uniqueSlug(slugify(input.name));
    const at = this.stamp();
    await this.db.batch([
      this.db
        .prepare(
          `insert into venues (
             id, name, slug, address_line1, address_line2, city, postcode,
             standard_notes, accessibility_info, capacity, website_url, map_url,
             created_at, updated_at
           ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`,
        )
        .bind(
          id,
          input.name,
          slug,
          input.addressLine1,
          input.addressLine2 ?? null,
          input.city,
          input.postcode,
          input.standardNotes ?? null,
          input.accessibilityInfo,
          input.capacity ?? null,
          input.websiteUrl ?? null,
          input.mapUrl ?? null,
          at,
        ),
      this.audit(this.newId('aud'), operator.email, 'venue.created', id, `Created "${input.name}"`, at),
    ]);
    return { id, slug };
  }

  async update(
    id: string,
    input: ValidatedVenueInput,
    operator: GigOperator,
  ): Promise<{ slug: string }> {
    const row = await this.db
      .prepare(SELECT_VENUE_ROW_SQL)
      .bind(id)
      .first<VenueRowWithArchive>();
    if (!row) throw new NotFoundError('That venue does not exist.');
    if (row.archived_at !== null) {
      throw new ConflictError('This venue is archived and cannot be edited.');
    }

    const at = this.stamp();
    await this.db.batch([
      this.db
        .prepare(
          `update venues set name = ?1, address_line1 = ?2, address_line2 = ?3,
             city = ?4, postcode = ?5, standard_notes = ?6, accessibility_info = ?7,
             capacity = ?8, website_url = ?9, map_url = ?10, updated_at = ?11
           where id = ?12`,
        )
        .bind(
          input.name,
          input.addressLine1,
          input.addressLine2 ?? null,
          input.city,
          input.postcode,
          input.standardNotes ?? null,
          input.accessibilityInfo,
          input.capacity ?? null,
          input.websiteUrl ?? null,
          input.mapUrl ?? null,
          at,
          id,
        ),
      this.audit(this.newId('aud'), operator.email, 'venue.updated', id, `Edited "${input.name}"`, at),
    ]);
    return { slug: row.slug };
  }

  async archive(id: string, operator: GigOperator): Promise<void> {
    const at = this.stamp();
    const update = this.db
      .prepare(
        'update venues set archived_at = ?1, updated_at = ?1 where id = ?2 and archived_at is null',
      )
      .bind(at, id);
    const audit = this.db
      .prepare(
        'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
          'select ?1, ?2, ?3, ?4, ?5, ?6, ?7 where exists (select 1 from venues where id = ?5 and archived_at = ?8)',
      )
      .bind(this.newId('aud'), operator.email, 'venue.archived', 'venue', id, `Archived "${id}"`, at, at);

    const results = await this.db.batch([update, audit]);
    if (((results[0]?.meta?.changes ?? 0) as number) === 0) {
      const row = await this.db.prepare(SELECT_VENUE_ROW_SQL).bind(id).first();
      if (!row) throw new NotFoundError('That venue does not exist.');
      throw new ConflictError('This venue is already archived.');
    }
  }

  async remove(id: string, operator: GigOperator): Promise<void> {
    const references = await this.db
      .prepare(SELECT_VENUE_REFERENCES_SQL)
      .bind(id)
      .first<{ n: number }>();
    if ((references?.n ?? 0) > 0) {
      throw new ConflictError('This venue hosts gigs and can only be archived.');
    }

    const at = this.stamp();
    const del = this.db
      .prepare(
        'delete from venues where id = ?1 and not exists (select 1 from events where venue_id = ?1)',
      )
      .bind(id);
    const audit = this.db
      .prepare(
        'insert into audit_log (id, actor_email, action, entity_type, entity_id, summary, occurred_at) ' +
          'select ?1, ?2, ?3, ?4, ?5, ?6, ?7 where not exists (select 1 from venues where id = ?5)',
      )
      .bind(this.newId('aud'), operator.email, 'venue.deleted', 'venue', id, `Deleted "${id}"`, at);

    const results = await this.db.batch([del, audit]);
    if (((results[0]?.meta?.changes ?? 0) as number) === 0) {
      const row = await this.db.prepare(SELECT_VENUE_ROW_SQL).bind(id).first();
      if (!row) throw new NotFoundError('That venue does not exist.');
      throw new ConflictError('This venue is referenced and can only be archived.');
    }
  }

  // -- helpers -------------------------------------------------------------

  private audit(
    id: string,
    actorEmail: string,
    action: string,
    entityId: string,
    summary: string,
    at: string,
  ): D1PreparedStatement {
    return this.db.prepare(AUDIT_SQL).bind(id, actorEmail, action, 'venue', entityId, summary, at);
  }

  private stamp(): string {
    const value = Math.max(this.now().getTime(), this.lastStamp + 1);
    this.lastStamp = value;
    return new Date(value).toISOString();
  }

  private async uniqueSlug(base: string): Promise<string> {
    const seed = base.length > 0 ? base : 'venue';
    let candidate = seed;
    for (let suffix = 2; suffix < 500; suffix += 1) {
      const row = await this.db
        .prepare('select id from venues where slug = ?1')
        .bind(candidate)
        .first<{ id: string }>();
      if (!row) return candidate;
      candidate = `${seed}-${suffix}`;
    }
    throw new ConflictError('Could not find an available URL for that name.');
  }
}

/** Build the D1 venue mutation service against a resolved binding. */
export function createD1VenueMutations(
  db: D1Database,
  clock?: () => Date,
  newId?: IdFactory,
): VenueMutationService {
  return new D1VenueMutations(db, clock, newId);
}
