/**
 * Site-wide constants and navigation.
 *
 * Navigation lives here rather than in the header markup so that the footer,
 * mobile menu, sitemap and the route-coverage test all read the same list.
 * A route added to the site without appearing here will fail tests/routes.test.ts.
 */

export const SITE = {
  name: 'Amped Up Music Promotions',
  shortName: 'Amped Up',
  url: 'https://ampedupmusic.co.uk',
  tagline: 'Live music, properly promoted.',
  description:
    'Amped Up Music Promotions puts on independent live music across the North West. Gig listings, tickets and everything you need for the night.',
  email: 'hello@ampedupmusic.co.uk',
  ticketsEmail: 'tickets@ampedupmusic.co.uk',
  locale: 'en-GB',
  region: 'North West England',
  social: {
    instagram: 'https://instagram.com/ampedupmusicpromotions',
    tiktok: 'https://tiktok.com/@ampedupmusic',
    facebook: 'https://facebook.com/ampedupmusicpromotions',
    youtube: 'https://youtube.com/@ampedupmusic',
  },
  photographyPartner: {
    name: 'AnyaParallax',
    url: 'https://anyaparallax.com',
    blurb: 'Every Amped Up night is shot by AnyaParallax. Full galleries go up within a week.',
  },
} as const;

export interface NavItem {
  label: string;
  href: string;
  /** Shown in the primary header nav. Everything else is footer-only. */
  primary?: boolean;
  description?: string;
}

export const PUBLIC_NAV: readonly NavItem[] = [
  { label: 'Gigs', href: '/gigs', primary: true, description: 'Every upcoming Amped Up night' },
  { label: 'Tickets', href: '/tickets', primary: true, description: 'What is on sale right now' },
  { label: 'Artists', href: '/artists', primary: true, description: 'Bands and acts we have put on' },
  { label: 'Gallery', href: '/gallery', primary: true, description: 'Photographs from the shows' },
  { label: 'Past gigs', href: '/past-gigs', primary: true, description: 'The archive' },
  { label: 'About', href: '/about', primary: true, description: 'Who we are' },
  { label: 'Promote with us', href: '/promote-with-us', description: 'Artists and venues' },
  { label: 'Contact', href: '/contact', description: 'Get in touch' },
];

export const FOOTER_LEGAL_NAV: readonly NavItem[] = [
  { label: 'Ticket terms', href: '/ticket-terms' },
  { label: 'Privacy', href: '/privacy' },
  { label: 'Accessibility', href: '/accessibility' },
];

export interface AdminNavItem extends NavItem {
  /** Inline SVG key, see src/components/admin/AdminIcon.astro */
  icon: string;
  /** Door Mode is pulled out of the normal chrome on purpose. */
  standalone?: boolean;
}

export const ADMIN_NAV: readonly AdminNavItem[] = [
  { label: 'Dashboard', href: '/admin', icon: 'dashboard' },
  { label: 'Gigs', href: '/admin/gigs', icon: 'calendar' },
  { label: 'Orders', href: '/admin/orders', icon: 'receipt' },
  // AMPED-07D2-3. Next to Orders because that is where an operator goes
  // when somebody says they have been charged and has no ticket.
  { label: 'Payments', href: '/admin/discrepancies', icon: 'receipt' },
  { label: 'Artists', href: '/admin/artists', icon: 'artist' },
  { label: 'Venues', href: '/admin/venues', icon: 'venue' },
  { label: 'Photos', href: '/admin/media', icon: 'photo' },
  { label: 'Socials', href: '/admin/social', icon: 'photo' },
  { label: 'Enquiries', href: '/admin/enquiries', icon: 'inbox' },
  { label: 'Mailing list', href: '/admin/mailing-list', icon: 'mail' },
  { label: 'Door Mode', href: '/admin/door', icon: 'scan', standalone: true },
];
