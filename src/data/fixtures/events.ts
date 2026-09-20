/**
 * Mock events, ticket types and sales counters.
 * Replaced by the D1 `events` / `event_artists` / `ticket_types` tables in
 * AMPED-02C and AMPED-02D, and by real inventory in AMPED-06B.
 *
 * The fixture set deliberately covers every state the UI has to handle:
 *
 *   evt_glass_hearts_nov   published, selling fast   <- the "next gig"
 *   evt_ledger_oct         published, sold out
 *   evt_northern_static    published, mixed (early bird gone, GA available)
 *   evt_saltwater_nov      POSTPONED, refunds offered
 *   evt_velvet_antler_dec  published, last few
 *   evt_winter_allday      published, not yet on sale
 *   evt_paper_lions_jan    CANCELLED
 *   evt_brass_tacks_nye    DRAFT, no artwork yet (admin-only)
 *   ...plus four completed events with galleries.
 *
 * Dates are offsets from today (see ../clock.ts) so the scaffold never goes
 * stale: there is always a next gig and always a populated archive.
 */

import type { Event, TicketType } from '@/types/domain.ts';
import { FIXTURE_EPOCH, londonAt } from '../clock.ts';

const base = { createdAt: FIXTURE_EPOCH, updatedAt: FIXTURE_EPOCH };

export const EVENTS: Event[] = [
  // -------------------------------------------------------------------------
  // UPCOMING
  // -------------------------------------------------------------------------
  {
    ...base,
    id: 'evt_glass_hearts_nov',
    title: 'The Glass Hearts',
    slug: 'the-glass-hearts-lomax-rooms',
    status: 'published',
    strapline: 'Amped Up presents',
    description:
      'The Glass Hearts come home. Four of them, a horn section borrowed from two other bands, and the whole of Hold The Line played start to finish for the first time.\n\nMara Veil opens with a solo set and a loop pedal, and Second City Sound plays records until closing. This is the fourth time they have headlined for us and the third time we have had to stop selling tickets early, so do not leave it.',
    venueId: 'ven_lomax',
    doorsAt: londonAt(12, '19:00'),
    startsAt: londonAt(12, '19:45'),
    endsAt: londonAt(12, '23:00'),
    ageRestriction: '16-plus',
    accessibilityNotes:
      'Two accessible viewing positions are held for every Amped Up show at this venue. Email tickets@ampedupmusic.co.uk after booking and we will reserve one.',
    posterAssetId: 'med_poster_glass_hearts',
    heroAssetId: 'med_hero_glass_hearts',
    lineup: [
      { artistId: 'art_glass_hearts', position: 0, setTime: londonAt(12, '21:30') },
      { artistId: 'art_mara_veil', position: 1, billingNote: 'Solo set', setTime: londonAt(12, '20:30') },
      { artistId: 'art_second_city', position: 2, billingNote: 'DJ set until close', setTime: londonAt(12, '22:45') },
    ],
    links: {
      instagram: 'https://example.com/instagram/ampedup/glasshearts',
      facebook: 'https://example.com/facebook/events/glasshearts',
    },
    photography: {
      credit: 'AnyaParallax',
      photographerUrl: 'https://anyaparallax.com',
    },
    publishedAt: FIXTURE_EPOCH,
  },
  {
    ...base,
    id: 'evt_ledger_oct',
    title: 'LEDGER',
    slug: 'ledger-the-cellar',
    status: 'published',
    strapline: 'Amped Up presents',
    description:
      'Two drummers in a room built for ninety people. LEDGER play thirty-two minutes and then it is over.\n\nPaper Lions open. Earplugs are free on the bar and we strongly suggest you take a pair.',
    venueId: 'ven_cellar',
    doorsAt: londonAt(19, '19:30'),
    startsAt: londonAt(19, '20:15'),
    endsAt: londonAt(19, '23:00'),
    ageRestriction: '18-plus',
    posterAssetId: 'med_poster_ledger',
    heroAssetId: 'med_hero_ledger',
    lineup: [
      { artistId: 'art_ledger', position: 0, setTime: londonAt(19, '21:30') },
      { artistId: 'art_paper_lions', position: 1, setTime: londonAt(19, '20:30') },
    ],
    links: { instagram: 'https://example.com/instagram/ampedup/ledger' },
    photography: { credit: 'AnyaParallax', photographerUrl: 'https://anyaparallax.com' },
    publishedAt: FIXTURE_EPOCH,
  },
  {
    ...base,
    id: 'evt_northern_static_oct',
    title: 'Northern Static',
    slug: 'northern-static-ironworks-social',
    status: 'published',
    strapline: 'Amped Up presents',
    description:
      'Northern Static bring the full rig - the one they built out of scaffolding clamps - to the biggest room we use.\n\nHollow Coast support, playing their first Amped Up show since the album came out. Early bird tickets have gone; general admission is still on sale.',
    venueId: 'ven_ironworks',
    doorsAt: londonAt(26, '19:00'),
    startsAt: londonAt(26, '20:00'),
    endsAt: londonAt(26, '23:30'),
    ageRestriction: '14-plus',
    accessibilityNotes:
      'Step-free throughout. Two accessible viewing spaces at the front of house desk - reserve one by emailing tickets@ampedupmusic.co.uk.',
    posterAssetId: 'med_poster_northern_static',
    heroAssetId: 'med_hero_northern_static',
    lineup: [
      { artistId: 'art_northern_static', position: 0, setTime: londonAt(26, '21:45') },
      { artistId: 'art_hollow_coast', position: 1, setTime: londonAt(26, '20:30') },
    ],
    links: {
      instagram: 'https://example.com/instagram/ampedup/northernstatic',
      tiktok: 'https://example.com/tiktok/ampedup/northernstatic',
    },
    photography: { credit: 'AnyaParallax', photographerUrl: 'https://anyaparallax.com' },
    publishedAt: FIXTURE_EPOCH,
  },
  {
    ...base,
    id: 'evt_saltwater_nov',
    title: 'Saltwater Parade',
    slug: 'saltwater-parade-parr-street-hall',
    status: 'postponed',
    strapline: 'Amped Up presents',
    description:
      'Saltwater Parade at Parr Street Hall, with a full band and the balcony open.',
    statusMessage:
      'This show has been postponed. Saltwater Parade have had to pull the date on medical advice and we are working on a new one for the spring. Your tickets remain valid for the rescheduled date. If you would rather have a refund, reply to your confirmation email and we will sort it within five working days - no explanation needed.',
    venueId: 'ven_parr_hall',
    doorsAt: londonAt(33, '19:00'),
    startsAt: londonAt(33, '20:00'),
    endsAt: londonAt(33, '23:00'),
    ageRestriction: 'all-ages',
    posterAssetId: 'med_poster_saltwater',
    lineup: [{ artistId: 'art_saltwater_parade', position: 0 }],
    links: { instagram: 'https://example.com/instagram/ampedup/saltwater' },
    publishedAt: FIXTURE_EPOCH,
  },
  {
    ...base,
    id: 'evt_velvet_antler_dec',
    title: 'Velvet Antler',
    slug: 'velvet-antler-lomax-rooms',
    status: 'published',
    strapline: 'Amped Up presents',
    description:
      'Velvet Antler play one set, no support and no interval. Doors at seven, on stage at eight, and if you are late you will be waiting at the back until the first long one finishes.\n\nMara Veil opens the room with thirty minutes.',
    venueId: 'ven_lomax',
    doorsAt: londonAt(40, '19:00'),
    startsAt: londonAt(40, '20:00'),
    endsAt: londonAt(40, '22:30'),
    ageRestriction: '16-plus',
    posterAssetId: 'med_poster_velvet_antler',
    heroAssetId: 'med_hero_velvet_antler',
    lineup: [
      { artistId: 'art_velvet_antler', position: 0, setTime: londonAt(40, '20:45') },
      { artistId: 'art_mara_veil', position: 1, setTime: londonAt(40, '20:00') },
    ],
    links: { bandcamp: 'https://example.com/bandcamp/velvetantler' },
    photography: { credit: 'AnyaParallax', photographerUrl: 'https://anyaparallax.com' },
    publishedAt: FIXTURE_EPOCH,
  },
  {
    ...base,
    id: 'evt_winter_allday',
    title: 'Amped Up Winter All-Dayer',
    slug: 'amped-up-winter-all-dayer',
    status: 'published',
    strapline: 'Six bands, one room, one ticket',
    description:
      'Our second all-dayer. Doors at two in the afternoon, six bands across one stage, last band off at eleven.\n\nThe full line-up goes up two weeks before tickets open. Early bird tickets are limited to eighty and they will not last.',
    venueId: 'ven_ironworks',
    doorsAt: londonAt(55, '14:00'),
    startsAt: londonAt(55, '14:30'),
    endsAt: londonAt(55, '23:00'),
    ageRestriction: '14-plus',
    posterAssetId: 'med_poster_winter_amp',
    lineup: [
      { artistId: 'art_brass_tacks', position: 0 },
      { artistId: 'art_saltwater_parade', position: 1 },
      { artistId: 'art_paper_lions', position: 2 },
      { artistId: 'art_mara_veil', position: 3 },
      { artistId: 'art_second_city', position: 4, billingNote: 'Between every set' },
    ],
    links: { instagram: 'https://example.com/instagram/ampedup/winterallday' },
    publishedAt: FIXTURE_EPOCH,
  },
  {
    ...base,
    id: 'evt_paper_lions_jan',
    title: 'Paper Lions',
    slug: 'paper-lions-the-cellar',
    status: 'cancelled',
    strapline: 'Amped Up presents',
    description: 'Paper Lions in the smallest room we use.',
    statusMessage:
      'This show has been cancelled. The venue has a licensing problem it could not resolve in time and we were unable to move the date. Everyone who bought a ticket has been refunded in full and should see the money back within five working days. If you have not, email tickets@ampedupmusic.co.uk and we will chase it.',
    venueId: 'ven_cellar',
    doorsAt: londonAt(47, '19:30'),
    startsAt: londonAt(47, '20:15'),
    endsAt: londonAt(47, '23:00'),
    ageRestriction: '18-plus',
    lineup: [{ artistId: 'art_paper_lions', position: 0 }],
    links: {},
    publishedAt: FIXTURE_EPOCH,
  },
  {
    ...base,
    id: 'evt_brass_tacks_nye',
    title: 'Brass Tacks New Year Social',
    slug: 'brass-tacks-new-year-social',
    status: 'draft',
    strapline: 'Amped Up presents',
    description:
      'Seven-piece soul revue, a late licence and a dance floor. Confirming the support and the bar extension before this goes live.',
    venueId: 'ven_parr_hall',
    doorsAt: londonAt(69, '20:00'),
    startsAt: londonAt(69, '21:00'),
    endsAt: londonAt(70, '01:00'),
    ageRestriction: '18-plus',
    internalNotes:
      'Waiting on the late licence before publishing. Ask the venue about the balcony bar. Poster not commissioned yet.',
    lineup: [{ artistId: 'art_brass_tacks', position: 0 }],
    links: {},
  },

  // -------------------------------------------------------------------------
  // COMPLETED
  // -------------------------------------------------------------------------
  {
    ...base,
    id: 'evt_hollow_coast_past',
    title: 'Hollow Coast',
    slug: 'hollow-coast-parr-street-hall',
    status: 'completed',
    strapline: 'Amped Up presents',
    description:
      'Hollow Coast headlined Parr Street Hall with Saltwater Parade supporting. Sold out ten days ahead and the balcony was open for the first time in two years.',
    venueId: 'ven_parr_hall',
    doorsAt: londonAt(-16, '19:00'),
    startsAt: londonAt(-16, '20:00'),
    endsAt: londonAt(-16, '23:00'),
    ageRestriction: 'all-ages',
    posterAssetId: 'med_poster_hollow_coast',
    heroAssetId: 'med_hero_hollow_coast',
    lineup: [
      { artistId: 'art_hollow_coast', position: 0 },
      { artistId: 'art_saltwater_parade', position: 1 },
    ],
    links: { instagram: 'https://example.com/instagram/ampedup/hollowcoast' },
    photography: {
      credit: 'AnyaParallax',
      galleryUrl: 'https://anyaparallax.com/galleries/hollow-coast-parr-street',
      photographerUrl: 'https://anyaparallax.com',
    },
    publishedAt: FIXTURE_EPOCH,
  },
  {
    ...base,
    id: 'evt_brass_tacks_past',
    title: 'Brass Tacks Soul Revue',
    slug: 'brass-tacks-soul-revue-ironworks',
    status: 'completed',
    strapline: 'Amped Up presents',
    description:
      'Seven people, four of them playing brass, and a floor that did not stop for ninety minutes. Second City Sound played records either side.',
    venueId: 'ven_ironworks',
    doorsAt: londonAt(-43, '19:30'),
    startsAt: londonAt(-43, '20:30'),
    endsAt: londonAt(-43, '23:30'),
    ageRestriction: '18-plus',
    posterAssetId: 'med_poster_brass_tacks',
    heroAssetId: 'med_hero_brass_tacks',
    lineup: [
      { artistId: 'art_brass_tacks', position: 0 },
      { artistId: 'art_second_city', position: 1, billingNote: 'DJ set' },
    ],
    links: { facebook: 'https://example.com/facebook/events/brasstacks' },
    photography: {
      credit: 'AnyaParallax',
      galleryUrl: 'https://anyaparallax.com/galleries/brass-tacks-ironworks',
      photographerUrl: 'https://anyaparallax.com',
    },
    publishedAt: FIXTURE_EPOCH,
  },
  {
    ...base,
    id: 'evt_paper_lions_past',
    title: 'Paper Lions',
    slug: 'paper-lions-the-cellar-summer',
    status: 'completed',
    strapline: 'Amped Up presents',
    description:
      'Paper Lions and LEDGER in a room with a low ceiling and no air conditioning. Twenty-two minutes and thirty-two minutes respectively, and everybody went home happy and slightly deaf.',
    venueId: 'ven_cellar',
    doorsAt: londonAt(-71, '19:30'),
    startsAt: londonAt(-71, '20:15'),
    endsAt: londonAt(-71, '23:00'),
    ageRestriction: '18-plus',
    posterAssetId: 'med_poster_paper_lions',
    lineup: [
      { artistId: 'art_paper_lions', position: 0 },
      { artistId: 'art_ledger', position: 1 },
    ],
    links: {},
    photography: {
      credit: 'AnyaParallax',
      galleryUrl: 'https://anyaparallax.com/galleries/paper-lions-cellar',
      photographerUrl: 'https://anyaparallax.com',
    },
    publishedAt: FIXTURE_EPOCH,
  },
  {
    ...base,
    id: 'evt_spring_session_past',
    title: 'Amped Up Spring Session',
    slug: 'amped-up-spring-session',
    status: 'completed',
    strapline: 'Four bands, one ticket',
    description:
      'Our first all-dayer. Four bands, doors at three, and a queue down Sedgewick Street by half past two. The Glass Hearts closed it.',
    venueId: 'ven_lomax',
    doorsAt: londonAt(-106, '15:00'),
    startsAt: londonAt(-106, '15:30'),
    endsAt: londonAt(-106, '23:00'),
    ageRestriction: '14-plus',
    posterAssetId: 'med_poster_spring_amp',
    lineup: [
      { artistId: 'art_glass_hearts', position: 0 },
      { artistId: 'art_northern_static', position: 1 },
      { artistId: 'art_saltwater_parade', position: 2 },
      { artistId: 'art_mara_veil', position: 3 },
    ],
    links: { instagram: 'https://example.com/instagram/ampedup/springsession' },
    photography: {
      credit: 'AnyaParallax',
      galleryUrl: 'https://anyaparallax.com/galleries/amped-up-spring-session',
      photographerUrl: 'https://anyaparallax.com',
    },
    publishedAt: FIXTURE_EPOCH,
  },
];

export const EVENTS_BY_ID = new Map(EVENTS.map((e) => [e.id, e]));

// ---------------------------------------------------------------------------
// Ticket types
// ---------------------------------------------------------------------------

export const TICKET_TYPES: TicketType[] = [
  // The Glass Hearts - selling fast
  { id: 'tt_gh_early', eventId: 'evt_glass_hearts_nov', name: 'Early Bird', description: 'Limited allocation, first 60 only.', priceInPence: 700, capacity: 60, maxPerOrder: 6, position: 0, visibility: 'public', salesCloseAt: londonAt(5, '23:59') },
  { id: 'tt_gh_ga', eventId: 'evt_glass_hearts_nov', name: 'General Admission', description: 'Standing, unreserved.', priceInPence: 1000, capacity: 140, maxPerOrder: 6, position: 1, visibility: 'public' },
  { id: 'tt_gh_guest', eventId: 'evt_glass_hearts_nov', name: 'Guest list', priceInPence: 0, capacity: 20, position: 2, visibility: 'hidden' },

  // LEDGER - sold out
  { id: 'tt_led_ga', eventId: 'evt_ledger_oct', name: 'General Admission', description: 'Standing. The room holds ninety and that is the lot.', priceInPence: 800, capacity: 82, maxPerOrder: 4, position: 0, visibility: 'public' },
  { id: 'tt_led_guest', eventId: 'evt_ledger_oct', name: 'Guest list', priceInPence: 0, capacity: 8, position: 1, visibility: 'hidden' },

  // Northern Static - mixed
  { id: 'tt_ns_early', eventId: 'evt_northern_static_oct', name: 'Early Bird', description: 'Gone. Kept here so you can see it sold.', priceInPence: 900, capacity: 80, maxPerOrder: 6, position: 0, visibility: 'public' },
  { id: 'tt_ns_ga', eventId: 'evt_northern_static_oct', name: 'General Admission', description: 'Standing, unreserved.', priceInPence: 1300, capacity: 240, maxPerOrder: 8, position: 1, visibility: 'public' },
  { id: 'tt_ns_guest', eventId: 'evt_northern_static_oct', name: 'Guest list', priceInPence: 0, capacity: 30, position: 2, visibility: 'hidden' },

  // Saltwater Parade - postponed
  { id: 'tt_sw_ga', eventId: 'evt_saltwater_nov', name: 'General Admission', priceInPence: 1400, capacity: 300, maxPerOrder: 8, position: 0, visibility: 'public' },
  { id: 'tt_sw_seated', eventId: 'evt_saltwater_nov', name: 'Seated balcony', description: 'Numbered seat, balcony level.', priceInPence: 1800, capacity: 140, maxPerOrder: 6, position: 1, visibility: 'public' },

  // Velvet Antler - last few
  { id: 'tt_va_ga', eventId: 'evt_velvet_antler_dec', name: 'General Admission', description: 'Standing, unreserved.', priceInPence: 1200, capacity: 200, maxPerOrder: 6, position: 0, visibility: 'public' },
  { id: 'tt_va_guest', eventId: 'evt_velvet_antler_dec', name: 'Guest list', priceInPence: 0, capacity: 20, position: 1, visibility: 'hidden' },

  // Winter All-Dayer - not yet on sale
  { id: 'tt_wa_early', eventId: 'evt_winter_allday', name: 'Early Bird', description: 'Eighty tickets. On sale with the line-up announcement.', priceInPence: 1800, capacity: 80, maxPerOrder: 6, position: 0, visibility: 'public', salesOpenAt: londonAt(12, '10:00') },
  { id: 'tt_wa_ga', eventId: 'evt_winter_allday', name: 'General Admission', description: 'All six bands, in and out all day.', priceInPence: 2400, capacity: 250, maxPerOrder: 8, position: 1, visibility: 'public', salesOpenAt: londonAt(12, '10:00') },

  // Paper Lions January - cancelled
  { id: 'tt_pl_ga', eventId: 'evt_paper_lions_jan', name: 'General Admission', priceInPence: 700, capacity: 85, maxPerOrder: 4, position: 0, visibility: 'public' },

  // Brass Tacks NYE - draft
  { id: 'tt_bt_ga', eventId: 'evt_brass_tacks_nye', name: 'General Admission', priceInPence: 2200, capacity: 380, maxPerOrder: 8, position: 0, visibility: 'public' },
  { id: 'tt_bt_seated', eventId: 'evt_brass_tacks_nye', name: 'Seated balcony', priceInPence: 2600, capacity: 90, maxPerOrder: 6, position: 1, visibility: 'public' },

  // Completed events
  { id: 'tt_hc_ga', eventId: 'evt_hollow_coast_past', name: 'General Admission', priceInPence: 1200, capacity: 330, maxPerOrder: 8, position: 0, visibility: 'public' },
  { id: 'tt_hc_seated', eventId: 'evt_hollow_coast_past', name: 'Seated balcony', priceInPence: 1600, capacity: 140, maxPerOrder: 6, position: 1, visibility: 'public' },
  { id: 'tt_bp_ga', eventId: 'evt_brass_tacks_past', name: 'General Admission', priceInPence: 1500, capacity: 330, maxPerOrder: 8, position: 0, visibility: 'public' },
  { id: 'tt_pp_ga', eventId: 'evt_paper_lions_past', name: 'General Admission', priceInPence: 600, capacity: 85, maxPerOrder: 4, position: 0, visibility: 'public' },
  { id: 'tt_ss_ga', eventId: 'evt_spring_session_past', name: 'All-day ticket', priceInPence: 1500, capacity: 200, maxPerOrder: 6, position: 0, visibility: 'public' },
];

export const TICKET_TYPES_BY_ID = new Map(TICKET_TYPES.map((t) => [t.id, t]));

/**
 * Sales counters, keyed by ticket type id.
 *
 * `reserved` models in-flight checkouts. Note that The Glass Hearts has four
 * tickets reserved right now: that is what a live checkout looks like, and it
 * is why the availability figures on the public site and the admin dashboard
 * are not simply "capacity minus sold".
 */
export const SALES: Record<string, { sold: number; reserved: number }> = {
  tt_gh_early: { sold: 60, reserved: 0 },
  tt_gh_ga: { sold: 96, reserved: 4 },
  tt_gh_guest: { sold: 11, reserved: 0 },

  tt_led_ga: { sold: 82, reserved: 0 },
  tt_led_guest: { sold: 6, reserved: 0 },

  tt_ns_early: { sold: 80, reserved: 0 },
  tt_ns_ga: { sold: 64, reserved: 2 },
  tt_ns_guest: { sold: 4, reserved: 0 },

  tt_sw_ga: { sold: 118, reserved: 0 },
  tt_sw_seated: { sold: 51, reserved: 0 },

  tt_va_ga: { sold: 186, reserved: 1 },
  tt_va_guest: { sold: 3, reserved: 0 },

  tt_wa_early: { sold: 0, reserved: 0 },
  tt_wa_ga: { sold: 0, reserved: 0 },

  tt_pl_ga: { sold: 0, reserved: 0 },

  tt_bt_ga: { sold: 0, reserved: 0 },
  tt_bt_seated: { sold: 0, reserved: 0 },

  tt_hc_ga: { sold: 330, reserved: 0 },
  tt_hc_seated: { sold: 138, reserved: 0 },
  tt_bp_ga: { sold: 291, reserved: 0 },
  tt_pp_ga: { sold: 85, reserved: 0 },
  tt_ss_ga: { sold: 194, reserved: 0 },
};
