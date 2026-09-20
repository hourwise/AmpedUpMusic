/**
 * Mock social posts, enquiries and mailing list subscribers.
 * Replaced in AMPED-05C (social), AMPED-10A (enquiries) and AMPED-10B (mailing list).
 *
 * The social model is deliberately manual: an operator pastes a URL and picks
 * a network. V1 does not crawl Instagram or TikTok, because those APIs change
 * without warning and a broken crawler on the homepage is worse than no
 * homepage social strip at all.
 */

import type { Enquiry, MailingListSubscriber, SocialPost } from '@/types/domain.ts';
import { fromNow } from '../clock.ts';

export const SOCIAL_POSTS: SocialPost[] = [
  {
    id: 'soc_01',
    eventId: 'evt_glass_hearts_nov',
    network: 'instagram',
    url: 'https://example.com/instagram/p/ampedup-glasshearts-announce',
    caption: 'THE GLASS HEARTS. Lomax Rooms. Early birds are nearly gone and we have not even announced the support yet.',
    thumbnailAssetId: 'med_social_01',
    postedAt: fromNow(-6),
    featured: true,
  },
  {
    id: 'soc_02',
    eventId: 'evt_ledger_oct',
    network: 'tiktok',
    url: 'https://example.com/tiktok/@ampedupmusic/video/ledger-soundcheck',
    caption: 'Two drummers. Ninety capacity. Sold out in four days. Sorry.',
    thumbnailAssetId: 'med_social_02',
    postedAt: fromNow(-11),
    featured: true,
  },
  {
    id: 'soc_03',
    eventId: 'evt_hollow_coast_past',
    network: 'instagram',
    url: 'https://example.com/instagram/p/ampedup-hollowcoast-gallery',
    caption: 'Hollow Coast at Parr Street Hall. Full gallery by AnyaParallax is up now.',
    thumbnailAssetId: 'med_social_03',
    postedAt: fromNow(-16),
    featured: true,
  },
  {
    id: 'soc_04',
    eventId: 'evt_northern_static_oct',
    network: 'instagram',
    url: 'https://example.com/instagram/p/ampedup-northernstatic-rig',
    caption: 'Northern Static are bringing the scaffolding rig to Ironworks. Early birds have gone; GA is on sale.',
    thumbnailAssetId: 'med_social_04',
    postedAt: fromNow(-3),
    featured: true,
  },
  {
    id: 'soc_05',
    eventId: 'evt_brass_tacks_past',
    network: 'facebook',
    url: 'https://example.com/facebook/ampedup/posts/brasstacks-thankyou',
    caption: 'Three hundred of you, one brass section and a floor that did not stop. Thank you.',
    postedAt: fromNow(-44),
    featured: false,
  },
  {
    id: 'soc_06',
    network: 'youtube',
    url: 'https://example.com/youtube/watch?v=ampedup-spring-session-recap',
    caption: 'Spring Session, two minutes, all four bands.',
    postedAt: fromNow(-108),
    featured: false,
  },
];

export const ENQUIRIES: Enquiry[] = [
  {
    id: 'enq_01',
    kind: 'artist',
    name: 'Rhiannon Teale',
    email: 'rhiannon@example.com',
    subject: 'Cold Harbour Radio - four piece from Chorley',
    message:
      'We have an EP out in February and we are looking for a support slot in the North West. We can bring about forty people on a Friday. Links below - happy to send the unmastered tracks if that helps.',
    links: 'https://example.com/bandcamp/coldharbourradio',
    status: 'new',
    botCheckPassed: true,
    receivedAt: fromNow(-0.4),
  },
  {
    id: 'enq_02',
    kind: 'venue',
    name: 'Denise Okonkwo',
    email: 'bookings@example.com',
    phone: '01772 000000',
    subject: 'The Sedgewick Vaults - 120 capacity, available Thursdays',
    message:
      'We have just finished refitting the back room and we are looking for promoters. Full PA, in-house engineer, step-free entrance. Would you like to come and look at it?',
    status: 'new',
    botCheckPassed: true,
    receivedAt: fromNow(-1.2),
  },
  {
    id: 'enq_03',
    kind: 'general',
    name: 'Marcus Hale',
    email: 'marcus.hale@example.com',
    subject: 'Accessible viewing at The Lomax Rooms',
    message:
      'I have a ticket for The Glass Hearts and I use a wheelchair. The venue page mentions accessible viewing positions - could you reserve one? Order reference is AMP-26-00712.',
    status: 'read',
    botCheckPassed: true,
    receivedAt: fromNow(-2.6),
  },
  {
    id: 'enq_04',
    kind: 'press',
    name: 'Sofia Marchetti',
    email: 'sofia@example.com',
    subject: 'Photo pass request - Northern Static',
    message: 'Writing a live review for a regional music site. Would there be a photo pass available for the first three songs?',
    status: 'replied',
    botCheckPassed: true,
    receivedAt: fromNow(-5.1),
  },
  {
    id: 'enq_05',
    kind: 'promoter',
    name: 'Hidden Track Collective',
    email: 'hello@example.com',
    subject: 'Co-promotion - all-dayer next summer',
    message:
      'We run a small festival in the Ribble Valley and wondered whether you would be interested in co-promoting a stage. No pressure, no deadline, just putting it in front of you.',
    status: 'read',
    botCheckPassed: true,
    receivedAt: fromNow(-9.3),
  },
  {
    id: 'enq_06',
    kind: 'general',
    name: 'Win A Free iPhone',
    email: 'noreply@example.com',
    message: 'CONGRATULATIONS you have been selected click here immediately to claim',
    status: 'spam',
    botCheckPassed: false,
    receivedAt: fromNow(-12.8),
  },
];

const SUBSCRIBER_NAMES: ReadonlyArray<[string, string]> = [
  ['Aisha Okafor', 'aisha.okafor@example.com'],
  ['Tom Whitfield', 'tom.whitfield@example.com'],
  ['Priya Nair', 'priya.nair@example.com'],
  ['Callum Docherty', 'callum.docherty@example.com'],
  ['Nia Brennan', 'nia.brennan@example.com'],
  ['Dan Hale', 'dan.hale@example.com'],
  ['Yusuf Iqbal', 'yusuf.iqbal@example.com'],
  ['Erin Moss', 'erin.moss@example.com'],
  ['Marcus Ainsworth', 'marcus.ainsworth@example.com'],
  ['Bea Kowalski', 'bea.kowalski@example.com'],
  ['Owen Pryce', 'owen.pryce@example.com'],
  ['Jade Sutcliffe', 'jade.sutcliffe@example.com'],
  ['Rory Bannerman', 'rory.bannerman@example.com'],
  ['Lena Ferris', 'lena.ferris@example.com'],
  ['Sam Hollis', 'sam.hollis@example.com'],
  ['Fiona Dunne', 'fiona.dunne@example.com'],
  ['Idris Achebe', 'idris.achebe@example.com'],
  ['Kelly Rowntree', 'kelly.rowntree@example.com'],
  ['Nathan Garvey', 'nathan.garvey@example.com'],
  ['Rosa Petrova', 'rosa.petrova@example.com'],
];

const CONSENT_SOURCES = ['checkout', 'homepage-footer', 'gig-page', 'door-signup'];

export const SUBSCRIBERS: MailingListSubscriber[] = SUBSCRIBER_NAMES.map(([name, email], index) => {
  const status: MailingListSubscriber['status'] =
    index === 17 ? 'unsubscribed' : index === 19 ? 'bounced' : 'subscribed';
  return {
    id: `sub_${index.toString().padStart(3, '0')}`,
    email,
    name,
    status,
    consentSource: CONSENT_SOURCES[index % CONSENT_SOURCES.length]!,
    consentAt: fromNow(-(index * 4 + 2)),
    unsubscribedAt: status === 'unsubscribed' ? fromNow(-6) : undefined,
  };
});

/** Growth series for the admin mailing list sparkline: subscribers per month. */
export const SUBSCRIBER_GROWTH: ReadonlyArray<{ label: string; count: number }> = [
  { label: 'Apr', count: 41 },
  { label: 'May', count: 58 },
  { label: 'Jun', count: 77 },
  { label: 'Jul', count: 96 },
  { label: 'Aug', count: 134 },
  { label: 'Sep', count: 171 },
];
