/**
 * D1-backed VenueService (AMPED-02B).
 *
 * The venue half of the persistence swap: pages keep calling
 * `getServices().venues.*` exactly as they did against the fixtures, and this
 * module is what answers when `env.DB` is bound.
 *
 * Rules this implementation holds to:
 *  - every statement names its columns explicitly (never `select *`), so a new
 *    column cannot leak into a view by accident;
 *  - the slug query is parameterised;
 *  - an unknown slug resolves to `null`, never a throw;
 *  - ordering matches `MockVenueService` exactly, including its
 *    `localeCompare(..., 'en-GB')` tie-breaking;
 *  - a raw `VenueRow` never leaves this module - callers only ever see the
 *    storage-agnostic `Venue` from src/types/domain.ts.
 */

import type { VenueRow } from '@/db/schema.ts';
import type { Venue } from '@/types/domain.ts';

import type { VenueService } from '../contracts.ts';

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
  'created_at',
  'updated_at',
].join(', ');

const SELECT_VENUES_SQL = `select ${VENUE_COLUMNS} from venues order by name, id`;
const SELECT_VENUE_BY_SLUG_SQL = `select ${VENUE_COLUMNS} from venues where slug = ?1`;

/**
 * Field order is irrelevant to equality, but optional keys are only present
 * when the column holds a value - exactly as the fixtures do it. A missing
 * `addressLine2` must be absent, not `null`, or the swap would be observable.
 */
function toVenue(row: VenueRow): Venue {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Identical wording to the fixture service, so page order cannot shift. */
const byName = (a: Venue, b: Venue): number => a.name.localeCompare(b.name, 'en-GB');

class D1VenueService implements VenueService {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<Venue[]> {
    const { results } = await this.db.prepare(SELECT_VENUES_SQL).all<VenueRow>();
    return results.map(toVenue).sort(byName);
  }

  async getBySlug(slug: string): Promise<Venue | null> {
    const row = await this.db.prepare(SELECT_VENUE_BY_SLUG_SQL).bind(slug).first<VenueRow>();
    return row ? toVenue(row) : null;
  }
}

/** Build the D1 venue service against a resolved binding. */
export function createD1VenueService(db: D1Database): VenueService {
  return new D1VenueService(db);
}
