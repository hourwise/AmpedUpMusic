/**
 * The seed's SQL, one statement per table.
 *
 * Every statement is a static literal that reads a JSON array of rows from a
 * single bound parameter:
 *
 *     insert into venues (id, name, ...)
 *     select json_extract(value, '$.id'), json_extract(value, '$.name'), ...
 *       from json_each(?1)
 *
 * Why not one INSERT per row with `?` placeholders? Because each `prepare()`
 * and each `bind()` against a D1 binding costs a round trip, and roughly 4,400
 * rows is roughly three minutes of round trips. One statement per table turns
 * the whole seed into sixteen binds. The values are still bound rather than
 * interpolated, so this remains parameterised SQL: the JSON document is the
 * parameter, and nothing here is assembled from strings at runtime.
 *
 * Rules for editing this file:
 *  - the column list in the INSERT and the key list in the SELECT are the same
 *    list in the same order, and the seed tests assert exactly that;
 *  - each `$.key` must be a field of the row shape in ./schema.ts, which the
 *    seed tests assert too. A key matching nothing would write NULL silently,
 *    so the nullable columns the fixtures care about are asserted as well.
 */

import type {
  ArtistRow,
  AuditLogRow,
  CheckInRow,
  EnquiryRow,
  EventArtistRow,
  EventRow,
  MailingListRow,
  MediaAssetRow,
  OrderItemRow,
  OrderRow,
  SocialPostRow,
  TicketRow,
  TicketTypeRow,
  VenueRow,
} from './schema.ts';

/** One statement that writes a batch of rows from a JSON payload. */
export interface BulkStatement<T> {
  /** Static SQL reading the JSON array of rows from `?1`. */
  sql: string;
  /**
   * The rows to serialise. Present so that a statement cannot be applied to a
   * batch of the wrong shape without the type checker noticing.
   */
  rows(rows: readonly T[]): readonly T[];
}

const statement = <T>(sql: string): BulkStatement<T> => ({ sql, rows: (rows) => rows });

export const INSERT_VENUE = statement<VenueRow>(`
  insert into venues (
    id, name, slug, address_line1, address_line2, city, postcode,
    standard_notes, accessibility_info, capacity, website_url, map_url,
    created_at, updated_at
  )
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.name'),
    json_extract(value, '$.slug'),
    json_extract(value, '$.address_line1'),
    json_extract(value, '$.address_line2'),
    json_extract(value, '$.city'),
    json_extract(value, '$.postcode'),
    json_extract(value, '$.standard_notes'),
    json_extract(value, '$.accessibility_info'),
    json_extract(value, '$.capacity'),
    json_extract(value, '$.website_url'),
    json_extract(value, '$.map_url'),
    json_extract(value, '$.created_at'),
    json_extract(value, '$.updated_at')
  from json_each(?1)
`);

export const INSERT_ARTIST = statement<ArtistRow>(`
  insert into artists (
    id, name, slug, tagline, biography, genre, based_in, image_asset_id,
    link_instagram, link_tiktok, link_facebook, link_youtube, link_spotify,
    link_bandcamp, link_soundcloud, link_website, created_at, updated_at
  )
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.name'),
    json_extract(value, '$.slug'),
    json_extract(value, '$.tagline'),
    json_extract(value, '$.biography'),
    json_extract(value, '$.genre'),
    json_extract(value, '$.based_in'),
    json_extract(value, '$.image_asset_id'),
    json_extract(value, '$.link_instagram'),
    json_extract(value, '$.link_tiktok'),
    json_extract(value, '$.link_facebook'),
    json_extract(value, '$.link_youtube'),
    json_extract(value, '$.link_spotify'),
    json_extract(value, '$.link_bandcamp'),
    json_extract(value, '$.link_soundcloud'),
    json_extract(value, '$.link_website'),
    json_extract(value, '$.created_at'),
    json_extract(value, '$.updated_at')
  from json_each(?1)
`);

export const INSERT_EVENT = statement<EventRow>(`
  insert into events (
    id, title, slug, status, strapline, description, venue_id,
    doors_at, starts_at, ends_at, age_restriction, accessibility_notes,
    poster_asset_id, hero_asset_id,
    link_instagram, link_tiktok, link_facebook, link_youtube, link_spotify,
    link_bandcamp, link_soundcloud, link_website,
    photography_credit, photography_gallery_url, photography_photographer_url,
    internal_notes, status_message, rescheduled_to_event_id, published_at,
    created_at, updated_at
  )
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.title'),
    json_extract(value, '$.slug'),
    json_extract(value, '$.status'),
    json_extract(value, '$.strapline'),
    json_extract(value, '$.description'),
    json_extract(value, '$.venue_id'),
    json_extract(value, '$.doors_at'),
    json_extract(value, '$.starts_at'),
    json_extract(value, '$.ends_at'),
    json_extract(value, '$.age_restriction'),
    json_extract(value, '$.accessibility_notes'),
    json_extract(value, '$.poster_asset_id'),
    json_extract(value, '$.hero_asset_id'),
    json_extract(value, '$.link_instagram'),
    json_extract(value, '$.link_tiktok'),
    json_extract(value, '$.link_facebook'),
    json_extract(value, '$.link_youtube'),
    json_extract(value, '$.link_spotify'),
    json_extract(value, '$.link_bandcamp'),
    json_extract(value, '$.link_soundcloud'),
    json_extract(value, '$.link_website'),
    json_extract(value, '$.photography_credit'),
    json_extract(value, '$.photography_gallery_url'),
    json_extract(value, '$.photography_photographer_url'),
    json_extract(value, '$.internal_notes'),
    json_extract(value, '$.status_message'),
    json_extract(value, '$.rescheduled_to_event_id'),
    json_extract(value, '$.published_at'),
    json_extract(value, '$.created_at'),
    json_extract(value, '$.updated_at')
  from json_each(?1)
`);

export const INSERT_EVENT_ARTIST = statement<EventArtistRow>(`
  insert into event_artists (event_id, artist_id, position, billing_note, set_time)
  select
    json_extract(value, '$.event_id'),
    json_extract(value, '$.artist_id'),
    json_extract(value, '$.position'),
    json_extract(value, '$.billing_note'),
    json_extract(value, '$.set_time')
  from json_each(?1)
`);

export const INSERT_TICKET_TYPE = statement<TicketTypeRow>(`
  insert into ticket_types (
    id, event_id, name, description, price_in_pence, capacity, max_per_order,
    sales_open_at, sales_close_at, position, visibility
  )
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.event_id'),
    json_extract(value, '$.name'),
    json_extract(value, '$.description'),
    json_extract(value, '$.price_in_pence'),
    json_extract(value, '$.capacity'),
    json_extract(value, '$.max_per_order'),
    json_extract(value, '$.sales_open_at'),
    json_extract(value, '$.sales_close_at'),
    json_extract(value, '$.position'),
    json_extract(value, '$.visibility')
  from json_each(?1)
`);

export const INSERT_MEDIA_ASSET = statement<MediaAssetRow>(`
  insert into media_assets (
    id, storage_key, url, role, alt, width, height, mime_type, byte_size,
    credit, event_id, artist_id, uploaded_at
  )
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.storage_key'),
    json_extract(value, '$.url'),
    json_extract(value, '$.role'),
    json_extract(value, '$.alt'),
    json_extract(value, '$.width'),
    json_extract(value, '$.height'),
    json_extract(value, '$.mime_type'),
    json_extract(value, '$.byte_size'),
    json_extract(value, '$.credit'),
    json_extract(value, '$.event_id'),
    json_extract(value, '$.artist_id'),
    json_extract(value, '$.uploaded_at')
  from json_each(?1)
`);

export const INSERT_ORDER = statement<OrderRow>(`
  insert into orders (
    id, reference, event_id, customer_name, customer_email, customer_phone,
    status, total_in_pence, fee_in_pence, payment_reference, payment_provider,
    paid_at, reservation_expires_at, marketing_opt_in, created_at, updated_at
  )
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.reference'),
    json_extract(value, '$.event_id'),
    json_extract(value, '$.customer_name'),
    json_extract(value, '$.customer_email'),
    json_extract(value, '$.customer_phone'),
    json_extract(value, '$.status'),
    json_extract(value, '$.total_in_pence'),
    json_extract(value, '$.fee_in_pence'),
    json_extract(value, '$.payment_reference'),
    json_extract(value, '$.payment_provider'),
    json_extract(value, '$.paid_at'),
    json_extract(value, '$.reservation_expires_at'),
    json_extract(value, '$.marketing_opt_in'),
    json_extract(value, '$.created_at'),
    json_extract(value, '$.updated_at')
  from json_each(?1)
`);

export const INSERT_ORDER_ITEM = statement<OrderItemRow>(`
  insert into order_items (
    id, order_id, ticket_type_id, quantity, unit_price_in_pence, ticket_type_name
  )
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.order_id'),
    json_extract(value, '$.ticket_type_id'),
    json_extract(value, '$.quantity'),
    json_extract(value, '$.unit_price_in_pence'),
    json_extract(value, '$.ticket_type_name')
  from json_each(?1)
`);

export const INSERT_TICKET = statement<TicketRow>(`
  insert into tickets (
    id, order_id, event_id, ticket_type_id, reference, token_hash, status,
    attendee_name, is_guest_list, issued_at, checked_in_at
  )
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.order_id'),
    json_extract(value, '$.event_id'),
    json_extract(value, '$.ticket_type_id'),
    json_extract(value, '$.reference'),
    json_extract(value, '$.token_hash'),
    json_extract(value, '$.status'),
    json_extract(value, '$.attendee_name'),
    json_extract(value, '$.is_guest_list'),
    json_extract(value, '$.issued_at'),
    json_extract(value, '$.checked_in_at')
  from json_each(?1)
`);

export const INSERT_CHECKIN = statement<CheckInRow>(`
  insert into checkins (id, ticket_id, event_id, operator_email, method, scanned_at)
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.ticket_id'),
    json_extract(value, '$.event_id'),
    json_extract(value, '$.operator_email'),
    json_extract(value, '$.method'),
    json_extract(value, '$.scanned_at')
  from json_each(?1)
`);

export const INSERT_SOCIAL_POST = statement<SocialPostRow>(`
  insert into social_posts (
    id, event_id, network, url, caption, thumbnail_asset_id, posted_at, featured
  )
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.event_id'),
    json_extract(value, '$.network'),
    json_extract(value, '$.url'),
    json_extract(value, '$.caption'),
    json_extract(value, '$.thumbnail_asset_id'),
    json_extract(value, '$.posted_at'),
    json_extract(value, '$.featured')
  from json_each(?1)
`);

export const INSERT_ENQUIRY = statement<EnquiryRow>(`
  insert into enquiries (
    id, kind, name, email, phone, subject, message, links, status,
    bot_check_passed, received_at
  )
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.kind'),
    json_extract(value, '$.name'),
    json_extract(value, '$.email'),
    json_extract(value, '$.phone'),
    json_extract(value, '$.subject'),
    json_extract(value, '$.message'),
    json_extract(value, '$.links'),
    json_extract(value, '$.status'),
    json_extract(value, '$.bot_check_passed'),
    json_extract(value, '$.received_at')
  from json_each(?1)
`);

export const INSERT_MAILING_LIST = statement<MailingListRow>(`
  insert into mailing_list (
    id, email, name, status, consent_source, consent_at, unsubscribed_at
  )
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.email'),
    json_extract(value, '$.name'),
    json_extract(value, '$.status'),
    json_extract(value, '$.consent_source'),
    json_extract(value, '$.consent_at'),
    json_extract(value, '$.unsubscribed_at')
  from json_each(?1)
`);

export const INSERT_AUDIT_LOG = statement<AuditLogRow>(`
  insert into audit_log (
    id, actor_email, action, entity_type, entity_id, summary, occurred_at
  )
  select
    json_extract(value, '$.id'),
    json_extract(value, '$.actor_email'),
    json_extract(value, '$.action'),
    json_extract(value, '$.entity_type'),
    json_extract(value, '$.entity_id'),
    json_extract(value, '$.summary'),
    json_extract(value, '$.occurred_at')
  from json_each(?1)
`);

// ---------------------------------------------------------------------------
// Artwork pointers
// ---------------------------------------------------------------------------

/**
 * Written after the media rows exist, because `events` and `artists` are
 * inserted before `media_assets` - the schema's only circular references.
 * These are the only two statements in the seed that are not inserts.
 */

export interface ArtistImageLink {
  artist_id: string;
  image_asset_id: string;
}

export const UPDATE_ARTIST_IMAGE = statement<ArtistImageLink>(`
  update artists
     set image_asset_id = (
           select json_extract(link.value, '$.image_asset_id')
             from json_each(?1) as link
            where json_extract(link.value, '$.artist_id') = artists.id
         )
   where id in (select json_extract(link.value, '$.artist_id') from json_each(?1) as link)
`);

export interface EventArtworkLink {
  event_id: string;
  poster_asset_id: string;
  hero_asset_id: string | null;
}

export const UPDATE_EVENT_ARTWORK = statement<EventArtworkLink>(`
  update events
     set poster_asset_id = (
           select json_extract(link.value, '$.poster_asset_id')
             from json_each(?1) as link
            where json_extract(link.value, '$.event_id') = events.id
         ),
         hero_asset_id = (
           select json_extract(link.value, '$.hero_asset_id')
             from json_each(?1) as link
            where json_extract(link.value, '$.event_id') = events.id
         )
   where id in (select json_extract(link.value, '$.event_id') from json_each(?1) as link)
`);
