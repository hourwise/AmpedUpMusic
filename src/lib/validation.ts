/**
 * Server-side validation for AMPED-04B gig administration.
 *
 * The browser form is a convenience; this module is the authority. Nothing
 * reaches the database without passing through here first, and nothing here
 * silently coerces a suspicious value into a plausible one - it rejects.
 *
 * Two conversions matter most and are deliberately explicit:
 *
 *  - Money: `parsePoundsToPence` (src/lib/money.ts) turns "10", "10.00" or
 *    "£8.50" into integer pence and returns null for anything else, including
 *    "10.999". Nothing is ever stored as a float.
 *  - Time: a `datetime-local` field carries no timezone. Amped Up events are
 *    in the UK, so the wall-clock value is interpreted as Europe/London and
 *    stored as a canonical UTC ISO string. A local time that does not exist
 *    (the spring-forward hour) is rejected rather than quietly shifted.
 */

import type { AgeRestriction, EventStatus, Pence } from '@/types/domain.ts';
import type { EventView } from '@/types/view.ts';
import { parsePoundsToPence } from './money.ts';

export const EVENT_STATUSES: readonly EventStatus[] = [
  'draft',
  'published',
  'postponed',
  'cancelled',
  'completed',
  'archived',
];

export const AGE_RESTRICTIONS: readonly AgeRestriction[] = [
  'all-ages',
  '14-plus',
  '16-plus',
  '18-plus',
];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Invalid input. `fields` maps a field path to a safe, non-sensitive message. */
export class ValidationError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super('Validation failed.');
    this.name = 'ValidationError';
  }
}

/** The request conflicts with current authoritative state (status, capacity...). */
export class ConflictError extends Error {
  constructor(message = 'Conflict.') {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Not found.') {
    super(message);
    this.name = 'NotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Europe/London <-> UTC
// ---------------------------------------------------------------------------

const LONDON_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Offset of Europe/London from UTC at an instant, in milliseconds. */
function londonOffsetMs(instant: Date): number {
  const parts = LONDON_PARTS.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const hour = get('hour') === 24 ? 0 : get('hour');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - instant.getTime();
}

function londonWallClock(instant: Date): string {
  const parts = LONDON_PARTS.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

/**
 * Interpret a `datetime-local` value as Europe/London and return canonical UTC.
 *
 * Returns null for a malformed value or a wall-clock time that does not exist
 * in London (the hour skipped by the spring DST change). An ambiguous value
 * (the hour repeated by the autumn change) resolves deterministically to the
 * first, British Summer Time occurrence.
 */
export function londonLocalToUtcIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const naiveMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));

  let offset = londonOffsetMs(new Date(naiveMs));
  let utcMs = naiveMs - offset;
  const refined = londonOffsetMs(new Date(utcMs));
  if (refined !== offset) {
    offset = refined;
    utcMs = naiveMs - offset;
  }

  const result = new Date(utcMs);
  // Round-trip: if the wall clock we get back is not the one submitted, the
  // requested local time does not exist (DST gap or an impossible calendar
  // date such as 31 February, which Date.UTC would otherwise roll forward).
  if (londonWallClock(result) !== `${year}-${month}-${day}T${hour}:${minute}`) return null;
  return result.toISOString();
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clean(value: unknown): string {
  return asString(value).trim();
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ValidatedTicketType {
  /** Present when editing an existing definition. */
  id?: string;
  name: string;
  description?: string;
  priceInPence: Pence;
  capacity: number;
  maxPerOrder?: number;
  salesOpenAt?: string;
  salesCloseAt?: string;
  visibility: 'public' | 'hidden';
}

export interface ValidatedGigInput {
  title: string;
  strapline?: string;
  description: string;
  venueId: string;
  doorsAt: string;
  startsAt: string;
  endsAt?: string;
  ageRestriction: AgeRestriction;
  accessibilityNotes?: string;
  internalNotes?: string;
  links: {
    instagram?: string;
    tiktok?: string;
    facebook?: string;
    youtube?: string;
  };
  photographyCredit?: string;
  photographyGalleryUrl?: string;
  /** Artist ids in running order, headline first. */
  lineup: string[];
  /** Public ticket types. Hidden/guest-list places are configured separately. */
  ticketTypes: ValidatedTicketType[];
  /**
   * Guest-list places, stored as the hidden ticket type. Kept apart from the
   * public types because the operator form presents it apart, and because a
   * hidden type must never appear on the website.
   */
  guestList: number;
}

interface ParseResult {
  value?: ValidatedGigInput;
  fields: Record<string, string>;
}

/**
 * Validate a create/update payload. An edit that omits ticket types leaves the
 * existing definitions alone (the caller decides via `ticketTypes === undefined`),
 * which is why the parser exposes `ticketTypes` even when empty.
 */
export function parseGigInput(payload: unknown): { ok: true; value: ValidatedGigInput } | { ok: false; fields: Record<string, string> } {
  const result = parseGig(payload);
  if (result.value) return { ok: true, value: result.value };
  return { ok: false, fields: result.fields };
}

function parseGig(payload: unknown): ParseResult {
  const fields: Record<string, string> = {};
  const body = (payload ?? {}) as Record<string, unknown>;

  const title = clean(body.title);
  if (title.length < 2) fields.title = 'Give the gig a title of at least 2 characters.';
  else if (title.length > 160) fields.title = 'The title is too long.';
  else fields.title = fields.title ?? '';

  const description = clean(body.description);
  if (description.length < 20) {
    fields.description = 'Write at least a sentence or two about the gig.';
  } else if (description.length > 4000) {
    fields.description = 'The description is too long.';
  }

  const venueId = clean(body.venueId);
  if (!/^[A-Za-z0-9_-]+$/.test(venueId)) fields.venueId = 'Choose a venue.';

  const ageRestriction = clean(body.ageRestriction) as AgeRestriction;
  if (!AGE_RESTRICTIONS.includes(ageRestriction)) fields.ageRestriction = 'Choose an age restriction.';

  const doorsAt = parseRequiredLocal(body.doorsAt, 'doorsAt', fields, 'Enter a doors time.');
  const startsAt = parseRequiredLocal(body.startsAt, 'startsAt', fields, 'Enter the first act time.');

  let endsAt: string | undefined;
  const endsRaw = clean(body.endsAt);
  if (endsRaw.length > 0) {
    const parsed = londonLocalToUtcIso(endsRaw);
    if (!parsed) fields.endsAt = 'That curfew is not a valid local time.';
    else endsAt = parsed;
  }

  if (doorsAt && startsAt && doorsAt > startsAt) {
    fields.doorsAt = 'Doors cannot open after the first act.';
  }
  if (endsAt && startsAt && endsAt <= startsAt) {
    fields.endsAt = 'The curfew must be after the first act.';
  }

  const strapline = clean(body.strapline);
  const accessibilityNotes = clean(body.accessibilityNotes);
  const internalNotes = clean(body.internalNotes);

  const linksBody = (body.links ?? {}) as Record<string, unknown>;
  const links: ValidatedGigInput['links'] = {};
  for (const network of ['instagram', 'tiktok', 'facebook', 'youtube'] as const) {
    const url = clean(linksBody[network]);
    if (url.length === 0) continue;
    if (!isUrl(url)) fields[`links.${network}`] = 'Use a full https:// link.';
    else links[network] = url;
  }

  const photographyGalleryUrl = clean(body.photographyGalleryUrl);
  if (photographyGalleryUrl.length > 0 && !isUrl(photographyGalleryUrl)) {
    fields.photographyGalleryUrl = 'Use a full https:// link.';
  }

  const lineup = parseLineup(body.lineup, fields);
  const ticketTypes = parseTicketTypes(body.ticketTypes, fields);

  const guestRaw = asString(body.guestList).trim();
  let guestList = 0;
  if (guestRaw !== '') {
    const parsedGuest = Number(guestRaw);
    if (!Number.isInteger(parsedGuest) || parsedGuest < 0) {
      fields.guestList = 'Guest list places is a whole number, zero or more.';
    } else {
      guestList = parsedGuest;
    }
  }

  const hasErrors = Object.values(fields).some(Boolean);
  if (hasErrors) return { fields };

  return {
    fields,
    value: {
      title,
      ...(strapline ? { strapline } : {}),
      description,
      venueId,
      doorsAt: doorsAt as string,
      startsAt: startsAt as string,
      ...(endsAt ? { endsAt } : {}),
      ageRestriction,
      ...(accessibilityNotes ? { accessibilityNotes } : {}),
      ...(internalNotes ? { internalNotes } : {}),
      links,
      ...(clean(body.photographyCredit) ? { photographyCredit: clean(body.photographyCredit) } : {}),
      ...(photographyGalleryUrl ? { photographyGalleryUrl } : {}),
      lineup,
      ticketTypes,
      guestList,
    },
  };
}

function parseRequiredLocal(
  value: unknown,
  field: string,
  fields: Record<string, string>,
  message: string,
): string | undefined {
  const raw = clean(value);
  if (raw.length === 0) {
    fields[field] = message;
    return undefined;
  }
  const parsed = londonLocalToUtcIso(raw);
  if (!parsed) {
    fields[field] = 'That is not a valid local date and time.';
    return undefined;
  }
  return parsed;
}

function parseLineup(value: unknown, fields: Record<string, string>): string[] {
  const raw = Array.isArray(value)
    ? value
    : asString(value).split(',');
  const ids = raw.map((entry) => clean(entry)).filter((entry) => entry.length > 0);

  if (ids.length > 30) {
    fields.lineup = 'That is more acts than a sensible bill.';
    return [];
  }
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      fields.lineup = 'One of the acts is not valid.';
      return [];
    }
  }
  return [...new Set(ids)];
}

function parseTicketTypes(value: unknown, fields: Record<string, string>): ValidatedTicketType[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 20) {
    fields.tickets = 'That is more ticket types than this form supports.';
    return [];
  }

  const out: ValidatedTicketType[] = [];
  value.forEach((entry, index) => {
    const ticket = (entry ?? {}) as Record<string, unknown>;
    const key = `tickets.${index}`;

    const name = clean(ticket.name);
    if (name.length === 0) fields[`${key}.name`] = 'Name this ticket type.';

    const price = parsePoundsToPence(asString(ticket.price));
    if (price === null) fields[`${key}.price`] = 'Enter a price like 10 or 8.50.';

    const capacityRaw = asString(ticket.capacity).trim();
    const capacity = Number(capacityRaw);
    if (capacityRaw === '' || !Number.isInteger(capacity) || capacity < 0) {
      fields[`${key}.capacity`] = 'How many is a whole number, zero or more.';
    }

    let maxPerOrder: number | undefined;
    const maxRaw = asString(ticket.max).trim();
    if (maxRaw !== '') {
      const parsedMax = Number(maxRaw);
      if (!Number.isInteger(parsedMax) || parsedMax < 1) {
        fields[`${key}.max`] = 'Max per order is a whole number, one or more.';
      } else {
        maxPerOrder = parsedMax;
      }
    }

    let salesOpenAt: string | undefined;
    const openRaw = clean(ticket.opens);
    if (openRaw.length > 0) {
      const parsed = londonLocalToUtcIso(openRaw);
      if (!parsed) fields[`${key}.opens`] = 'That is not a valid local date and time.';
      else salesOpenAt = parsed;
    }

    let salesCloseAt: string | undefined;
    const closeRaw = clean(ticket.closes);
    if (closeRaw.length > 0) {
      const parsed = londonLocalToUtcIso(closeRaw);
      if (!parsed) fields[`${key}.closes`] = 'That is not a valid local date and time.';
      else salesCloseAt = parsed;
    }

    if (salesOpenAt && salesCloseAt && salesCloseAt <= salesOpenAt) {
      fields[`${key}.closes`] = 'Sales must close after they open.';
    }

    const visibility = ticket.visibility === 'hidden' ? 'hidden' : 'public';
    const id = clean(ticket.id) || undefined;

    if (!Object.entries(fields).some(([field, message]) => message && field.startsWith(key))) {
      out.push({
        ...(id ? { id } : {}),
        name,
        description: clean(ticket.description) || undefined,
        priceInPence: price as number,
        capacity,
        ...(maxPerOrder !== undefined ? { maxPerOrder } : {}),
        ...(salesOpenAt ? { salesOpenAt } : {}),
        ...(salesCloseAt ? { salesCloseAt } : {}),
        visibility,
      });
    }
  });

  return out;
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  draft: ['published', 'archived'],
  published: ['postponed', 'cancelled', 'completed', 'archived'],
  postponed: ['archived'],
  cancelled: ['archived'],
  completed: ['archived'],
  archived: [],
};

export function isAllowedTransition(from: EventStatus, to: EventStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Publish readiness
// ---------------------------------------------------------------------------

export interface ReadinessReport {
  ready: boolean;
  blockers: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// AMPED-04C - artist and venue administration
// ---------------------------------------------------------------------------

/**
 * Unknown fields are rejected rather than ignored (the standing policy for new
 * admin mutation APIs). `prefix` keeps nested field errors addressable.
 */
function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  fields: Record<string, string>,
  prefix = '',
): boolean {
  let rejected = false;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      fields[`${prefix}${key}`] = 'Unsupported field.';
      rejected = true;
    }
  }
  return rejected;
}

const SOCIAL_NETWORKS = [
  'instagram',
  'tiktok',
  'facebook',
  'youtube',
  'spotify',
  'bandcamp',
  'soundcloud',
  'website',
] as const;

export type SocialNetworkKey = (typeof SOCIAL_NETWORKS)[number];

export interface ValidatedArtistInput {
  name: string;
  tagline?: string;
  biography?: string;
  genre?: string;
  basedIn?: string;
  links: Partial<Record<SocialNetworkKey, string>>;
}

export interface ValidatedVenueInput {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  postcode: string;
  standardNotes?: string;
  accessibilityInfo: string;
  capacity?: number;
  websiteUrl?: string;
  mapUrl?: string;
}

/** Validate an artist create/update payload against an explicit allowlist. */
export function parseArtistInput(
  payload: unknown,
): { ok: true; value: ValidatedArtistInput } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const body = (payload ?? {}) as Record<string, unknown>;

  rejectUnknownKeys(
    body,
    ['name', 'tagline', 'biography', 'genre', 'basedIn', 'links'],
    fields,
  );

  const name = clean(body.name);
  if (name.length < 1) fields.name = 'An artist needs a name.';
  else if (name.length > 160) fields.name = 'That name is too long.';

  const linksBody = (body.links ?? {}) as Record<string, unknown>;
  if (typeof body.links === 'object' && body.links !== null) {
    rejectUnknownKeys(linksBody, SOCIAL_NETWORKS, fields, 'links.');
  }
  const links: ValidatedArtistInput['links'] = {};
  for (const network of SOCIAL_NETWORKS) {
    const url = clean(linksBody[network]);
    if (url.length === 0) continue;
    if (!isUrl(url)) fields[`links.${network}`] = 'Use a full https:// link.';
    else links[network] = url;
  }

  if (Object.values(fields).some(Boolean)) return { ok: false, fields };

  const tagline = clean(body.tagline);
  const biography = clean(body.biography);
  const genre = clean(body.genre);
  const basedIn = clean(body.basedIn);

  return {
    ok: true,
    value: {
      name,
      ...(tagline ? { tagline } : {}),
      ...(biography ? { biography } : {}),
      ...(genre ? { genre } : {}),
      ...(basedIn ? { basedIn } : {}),
      links,
    },
  };
}

/** Validate a venue create/update payload against an explicit allowlist. */
export function parseVenueInput(
  payload: unknown,
): { ok: true; value: ValidatedVenueInput } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const body = (payload ?? {}) as Record<string, unknown>;

  rejectUnknownKeys(
    body,
    [
      'name',
      'addressLine1',
      'addressLine2',
      'city',
      'postcode',
      'standardNotes',
      'accessibilityInfo',
      'capacity',
      'websiteUrl',
      'mapUrl',
    ],
    fields,
  );

  const name = clean(body.name);
  if (name.length < 1) fields.name = 'A venue needs a name.';

  const addressLine1 = clean(body.addressLine1);
  if (addressLine1.length < 1) fields.addressLine1 = 'Add the street address.';

  const city = clean(body.city);
  if (city.length < 1) fields.city = 'Add the town or city.';

  const postcode = clean(body.postcode);
  if (postcode.length < 1) fields.postcode = 'Add the postcode.';

  // Accessibility is required and must be a real value; a blank or
  // whitespace-only string is a failure, not something to fill in for them.
  const accessibilityInfo = asString(body.accessibilityInfo).trim();
  if (accessibilityInfo.length < 1) {
    fields.accessibilityInfo =
      'Access information is required. If there is none to add, say so plainly.';
  }

  let capacity: number | undefined;
  const capacityRaw = asString(body.capacity).trim();
  if (capacityRaw !== '') {
    const parsed = Number(capacityRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      fields.capacity = 'Capacity is a whole number, zero or more.';
    } else {
      capacity = parsed;
    }
  }

  for (const key of ['websiteUrl', 'mapUrl'] as const) {
    const url = clean(body[key]);
    if (url.length > 0 && !isUrl(url)) fields[key] = 'Use a full https:// link.';
  }

  if (Object.values(fields).some(Boolean)) return { ok: false, fields };

  const addressLine2 = clean(body.addressLine2);
  const standardNotes = clean(body.standardNotes);
  const websiteUrl = clean(body.websiteUrl);
  const mapUrl = clean(body.mapUrl);

  return {
    ok: true,
    value: {
      name,
      addressLine1,
      ...(addressLine2 ? { addressLine2 } : {}),
      city,
      postcode,
      ...(standardNotes ? { standardNotes } : {}),
      accessibilityInfo,
      ...(capacity !== undefined ? { capacity } : {}),
      ...(websiteUrl ? { websiteUrl } : {}),
      ...(mapUrl ? { mapUrl } : {}),
    },
  };
}

/**
 * What must be true before a draft can go on sale. Derived from the stored
 * event, not from the form, and never blocks on artwork: R2 upload is
 * AMPED-05A, so a missing poster is a warning until then.
 */
export function assessReadiness(
  event: EventView,
  venueAccessibilityInfo: string | undefined,
): ReadinessReport {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!event.title || event.title.trim().length < 2) blockers.push('Add a gig title.');
  if (!event.description || event.description.trim().length < 20) {
    blockers.push('Write an about-the-gig description.');
  }
  if (!event.venue?.id) blockers.push('Choose a venue.');
  if (!event.startsAt) blockers.push('Set the first act time.');
  if (event.endsAt && event.endsAt <= event.startsAt) blockers.push('The curfew must be after the start.');
  if (event.lineup.length === 0) blockers.push('Add at least one act to the line-up.');
  if (!AGE_RESTRICTIONS.includes(event.ageRestriction)) blockers.push('Set the age restriction.');

  const hasAccessInfo = Boolean(event.accessibilityNotes?.trim()) || Boolean(venueAccessibilityInfo?.trim());
  if (!hasAccessInfo) blockers.push('Add access notes, or check the venue has standing information.');

  const publicTypes = event.ticketTypes;
  if (publicTypes.length === 0) blockers.push('Add at least one public ticket type.');
  for (const ticket of publicTypes) {
    if (ticket.inventory.capacity < 1) blockers.push(`${ticket.name} has no allocation.`);
  }

  if (!event.posterUrl) warnings.push('No poster uploaded yet - artwork can be added later.');

  return { ready: blockers.length === 0, blockers, warnings };
}
