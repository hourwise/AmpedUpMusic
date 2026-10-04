/** Small, dependency-free text helpers shared by the site and admin. */

import type { AgeRestriction, EnquiryKind, EventStatus, OrderStatus, SocialNetwork } from '@/types/domain.ts';

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  const cut = input.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).trimEnd()}...`;
}

/** Splits a description into paragraphs on blank lines. */
export function paragraphs(input: string): string[] {
  return input
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export const AGE_RESTRICTION_LABEL: Record<AgeRestriction, string> = {
  'all-ages': 'All ages welcome',
  '14-plus': '14+ (under 16s with an adult)',
  '16-plus': '16+',
  '18-plus': '18+ (photo ID required)',
};

export const AGE_RESTRICTION_SHORT: Record<AgeRestriction, string> = {
  'all-ages': 'All ages',
  '14-plus': '14+',
  '16-plus': '16+',
  '18-plus': '18+',
};

export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  postponed: 'Postponed',
  cancelled: 'Cancelled',
  completed: 'Completed',
  archived: 'Archived',
};

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'Pending',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
  expired: 'Expired',
  refunded: 'Refunded',
  partially_refunded: 'Part refunded',
};

/**
 * Payment discrepancies, in words an operator can act on (AMPED-07D2-3).
 *
 * The enum values are for the database. These are for a person who has to
 * decide what to do about somebody's money, so they say what happened rather
 * than naming a state.
 */
export const DISCREPANCY_KIND_LABEL: Record<string, string> = {
  paid_after_expiry: 'Payment received after the reservation expired',
  paid_order_expired: 'Payment found for an order that had already expired',
  amount_mismatch: 'Payment amount does not match the order',
  correlation_mismatch: 'Payment could not be safely matched to the order',
};

/** What the operator should actually do next. */
export const DISCREPANCY_ACTION_LABEL: Record<string, string> = {
  paid_after_expiry:
    'The tickets went back on sale before this payment could be applied, so the order was not completed. Check the payment in SumUp and refund it there.',
  paid_order_expired:
    'This order had already expired when the payment was found. Check the payment in SumUp and refund it there.',
  amount_mismatch:
    'SumUp and Amped Up disagree about what was charged. Compare the two amounts in SumUp before deciding what to refund.',
  correlation_mismatch:
    'A completed payment could not be matched to this order safely. Investigate in SumUp before refunding anything.',
};

export const DISCREPANCY_STATE_LABEL: Record<string, string> = {
  open: 'Needs attention',
  resolved_manually: 'Resolved by operator',
  dismissed: 'Dismissed',
  refund_requested: 'Refund requested',
  refund_confirmed: 'Refund confirmed',
  refund_failed: 'Refund failed',
};

export const ENQUIRY_KIND_LABEL: Record<EnquiryKind, string> = {
  artist: 'Artist',
  venue: 'Venue',
  promoter: 'Promoter',
  general: 'General',
  press: 'Press',
};

export const SOCIAL_LABEL: Record<SocialNetwork, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  youtube: 'YouTube',
  spotify: 'Spotify',
  bandcamp: 'Bandcamp',
  soundcloud: 'SoundCloud',
  website: 'Website',
};

/** Orders the social links consistently wherever they appear. */
export const SOCIAL_ORDER: readonly SocialNetwork[] = [
  'instagram',
  'tiktok',
  'facebook',
  'youtube',
  'spotify',
  'bandcamp',
  'soundcloud',
  'website',
];

/** Turns "0" into "headline" etc. for lineup billing. */
export function billingFor(position: number): 'headline' | 'support' | 'opener' {
  if (position === 0) return 'headline';
  if (position === 1) return 'support';
  return 'opener';
}

/** Initials for avatar fallbacks, e.g. "The Glass Hearts" -> "GH". */
export function initials(name: string): string {
  const words = name.replace(/^(the|a|an)\s+/i, '').split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

/** Pluralise without pulling in a library. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}
