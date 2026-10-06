/**
 * Row shapes for the V1 D1 schema.
 *
 * These mirror `src/types/domain.ts` column for column, with the database's
 * snake_case names. They are storage shapes, not domain shapes: nothing in
 * src/services or src/components should return one to a caller. The D1
 * repositories due in AMPED-02B..03A map a row to its domain type and do not
 * leak the row.
 *
 * Keeping the names identical to the columns means a mistyped or missing
 * column is a compile error in the seed and in the tests, and a `select`
 * advisory against `*` is one field list away from being verified by the
 * type checker.
 *
 * Three conventions come straight from the migration files:
 *  - money is an integer number of pence in a `*_pence` column;
 *  - timestamps are canonical ISO-8601 UTC strings;
 *  - booleans are `0 | 1`.
 *
 * `schema_migrations` is the migration runner's own ledger; its shape is
 * `AppliedMigration` in ./migrations.ts and it is deliberately not duplicated
 * here.
 */

/** A boolean as SQLite stores it. */
export type SqliteBool = 0 | 1;

/** ISO-8601 UTC instant, e.g. "2026-11-14T19:30:00.000Z". */
export type IsoDateTime = string;

// --- 0001 venues, artists --------------------------------------------------

export interface VenueRow {
  id: string;
  name: string;
  slug: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  postcode: string;
  standard_notes: string | null;
  accessibility_info: string | null;
  capacity: number | null;
  website_url: string | null;
  map_url: string | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface ArtistRow {
  id: string;
  name: string;
  slug: string;
  tagline: string | null;
  biography: string | null;
  genre: string | null;
  based_in: string | null;
  image_asset_id: string | null;
  link_instagram: string | null;
  link_tiktok: string | null;
  link_facebook: string | null;
  link_youtube: string | null;
  link_spotify: string | null;
  link_bandcamp: string | null;
  link_soundcloud: string | null;
  link_website: string | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

// --- 0002 events, event_artists --------------------------------------------

export interface EventRow {
  id: string;
  title: string;
  slug: string;
  status: 'draft' | 'published' | 'postponed' | 'cancelled' | 'completed' | 'archived';
  strapline: string | null;
  description: string;
  venue_id: string;
  doors_at: IsoDateTime;
  starts_at: IsoDateTime;
  ends_at: IsoDateTime | null;
  age_restriction: 'all-ages' | '14-plus' | '16-plus' | '18-plus';
  accessibility_notes: string | null;
  poster_asset_id: string | null;
  hero_asset_id: string | null;
  link_instagram: string | null;
  link_tiktok: string | null;
  link_facebook: string | null;
  link_youtube: string | null;
  link_spotify: string | null;
  link_bandcamp: string | null;
  link_soundcloud: string | null;
  link_website: string | null;
  photography_credit: string | null;
  photography_gallery_url: string | null;
  photography_photographer_url: string | null;
  internal_notes: string | null;
  status_message: string | null;
  rescheduled_to_event_id: string | null;
  published_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface EventArtistRow {
  event_id: string;
  artist_id: string;
  position: number;
  billing_note: string | null;
  set_time: IsoDateTime | null;
}

// --- 0003 media_assets, social_posts ---------------------------------------

export interface MediaAssetRow {
  id: string;
  storage_key: string;
  url: string;
  role: 'poster' | 'hero' | 'gallery' | 'artist' | 'venue' | 'og';
  alt: string;
  width: number | null;
  height: number | null;
  mime_type: string;
  byte_size: number | null;
  credit: string | null;
  event_id: string | null;
  artist_id: string | null;
  uploaded_at: IsoDateTime;
}

export interface SocialPostRow {
  id: string;
  event_id: string | null;
  network:
    | 'instagram'
    | 'tiktok'
    | 'facebook'
    | 'youtube'
    | 'spotify'
    | 'bandcamp'
    | 'soundcloud'
    | 'website';
  url: string;
  caption: string | null;
  thumbnail_asset_id: string | null;
  posted_at: IsoDateTime | null;
  featured: SqliteBool;
}

// --- 0004 ticket_types, orders, order_items, tickets, checkins -------------

export interface TicketTypeRow {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  price_in_pence: number;
  capacity: number;
  max_per_order: number | null;
  sales_open_at: IsoDateTime | null;
  sales_close_at: IsoDateTime | null;
  position: number;
  visibility: 'public' | 'hidden';
}

export interface OrderRow {
  id: string;
  reference: string;
  event_id: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  status:
    | 'pending'
    | 'awaiting_payment'
    | 'paid'
    | 'cancelled'
    | 'expired'
    | 'refunded'
    | 'partially_refunded';
  total_in_pence: number;
  fee_in_pence: number;
  payment_reference: string | null;
  payment_provider: 'sumup' | 'mock' | 'cash' | 'comp' | null;
  paid_at: IsoDateTime | null;
  tickets_fulfilled_at: IsoDateTime | null;
  reservation_expires_at: IsoDateTime | null;
  marketing_opt_in: SqliteBool;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  ticket_type_id: string;
  quantity: number;
  unit_price_in_pence: number;
  ticket_type_name: string;
}

export interface TicketRow {
  id: string;
  order_id: string;
  event_id: string;
  ticket_type_id: string;
  order_item_id: string | null;
  unit_ordinal: number | null;
  reference: string;
  token_hash: string | null;
  credential_id: string | null;
  status: 'issued' | 'checked_in' | 'void' | 'refunded';
  attendee_name: string | null;
  is_guest_list: SqliteBool;
  issued_at: IsoDateTime;
  checked_in_at: IsoDateTime | null;
}

export interface CheckInRow {
  id: string;
  ticket_id: string;
  event_id: string;
  operator_email: string;
  method: 'qr' | 'manual' | 'guest-list';
  scanned_at: IsoDateTime;
}

// --- 0005 enquiries, mailing_list ------------------------------------------

export interface EnquiryRow {
  id: string;
  kind: 'artist' | 'venue' | 'promoter' | 'general' | 'press';
  name: string;
  email: string;
  phone: string | null;
  subject: string | null;
  message: string;
  links: string | null;
  status: 'new' | 'read' | 'replied' | 'archived' | 'spam';
  bot_check_passed: SqliteBool;
  received_at: IsoDateTime;
}

export interface MailingListRow {
  id: string;
  email: string;
  name: string | null;
  status: 'subscribed' | 'unsubscribed' | 'bounced' | 'pending';
  consent_source: string;
  consent_at: IsoDateTime;
  unsubscribed_at: IsoDateTime | null;
}

// --- 0006 audit_log, processed_webhooks ------------------------------------

export interface AuditLogRow {
  id: string;
  actor_email: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  occurred_at: IsoDateTime;
}

export interface ProcessedWebhookRow {
  id: string;
  provider: string;
  provider_event_id: string;
  received_at: IsoDateTime;
  processed_at: IsoDateTime | null;
}

/** Every table this schema owns, in migration order. Used by the tests. */
export const V1_TABLES: readonly string[] = [
  'venues',
  'artists',
  'events',
  'event_artists',
  'media_assets',
  'social_posts',
  'ticket_types',
  'orders',
  'order_items',
  'tickets',
  'checkins',
  'enquiries',
  'mailing_list',
  'audit_log',
  'processed_webhooks',
  // AMPED-07D2-2 - durable financial exceptions.
  'payment_discrepancies',
  'payment_discrepancy_events',
  'schema_migrations',
];
