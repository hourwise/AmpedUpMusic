/**
 * Money handling. Every amount in this codebase is an integer number of pence.
 *
 * Floating point pounds are banned. `0.1 + 0.2 !== 0.3` is an amusing
 * curiosity in a blog post and a refund dispute in a ticketing system.
 */

import type { Pence } from '@/types/domain.ts';

const GBP = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const GBP_WHOLE = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** "£10.00" */
export function formatPence(pence: Pence): string {
  return GBP.format(pence / 100);
}

/**
 * "£10" for round amounts, "£8.50" otherwise. Used where price is a headline
 * rather than a line item - posters and ticket buttons read better without
 * a redundant ".00".
 */
export function formatPenceCompact(pence: Pence): string {
  return pence % 100 === 0 ? GBP_WHOLE.format(pence / 100) : GBP.format(pence / 100);
}

/** Free tickets are a real case (guest list, comps). Say so rather than "£0.00". */
export function formatPriceLabel(pence: Pence): string {
  return pence === 0 ? 'Free' : formatPenceCompact(pence);
}

/** Parses "10", "10.00", "£10.00", " 8.5 " into pence. Returns null if invalid. */
export function parsePoundsToPence(input: string): Pence | null {
  const cleaned = input.trim().replace(/^£/, '').replace(/,/g, '');
  if (cleaned === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  const pennies = (fraction + '00').slice(0, 2);
  return Number(whole) * 100 + Number(pennies);
}

export function sumPence(amounts: readonly Pence[]): Pence {
  return amounts.reduce((total, amount) => total + amount, 0);
}
