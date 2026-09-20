/**
 * Money is integer pence everywhere. These tests exist mainly to stop anyone
 * "simplifying" the representation to a float later.
 */
import { describe, expect, it } from 'vitest';
import {
  formatPence,
  formatPenceCompact,
  formatPriceLabel,
  parsePoundsToPence,
  sumPence,
} from '../src/lib/money.ts';

describe('formatPence', () => {
  it('always shows two decimal places', () => {
    expect(formatPence(1000)).toBe('£10.00');
    expect(formatPence(850)).toBe('£8.50');
    expect(formatPence(0)).toBe('£0.00');
  });

  it('handles amounts above a thousand pounds', () => {
    expect(formatPence(123_456)).toBe('£1,234.56');
  });
});

describe('formatPenceCompact', () => {
  it('drops the pence on round amounts', () => {
    expect(formatPenceCompact(1000)).toBe('£10');
    expect(formatPenceCompact(700)).toBe('£7');
  });

  it('keeps the pence when there are any', () => {
    expect(formatPenceCompact(850)).toBe('£8.50');
    expect(formatPenceCompact(1205)).toBe('£12.05');
  });
});

describe('formatPriceLabel', () => {
  it('says Free rather than showing zero pounds', () => {
    // Guest list and comp tickets are genuinely free, and "£0.00" on a ticket
    // panel reads like a bug.
    expect(formatPriceLabel(0)).toBe('Free');
  });

  it('falls through to the compact format otherwise', () => {
    expect(formatPriceLabel(1200)).toBe('£12');
  });
});

describe('parsePoundsToPence', () => {
  it('accepts the shapes an operator will actually type', () => {
    expect(parsePoundsToPence('10')).toBe(1000);
    expect(parsePoundsToPence('10.00')).toBe(1000);
    expect(parsePoundsToPence('8.50')).toBe(850);
    expect(parsePoundsToPence('£12.99')).toBe(1299);
    expect(parsePoundsToPence('  7 ')).toBe(700);
    expect(parsePoundsToPence('1,250')).toBe(125_000);
  });

  it('treats a single decimal place as tenths of a pound', () => {
    expect(parsePoundsToPence('8.5')).toBe(850);
  });

  it('rejects anything it cannot be sure about', () => {
    expect(parsePoundsToPence('')).toBeNull();
    expect(parsePoundsToPence('ten')).toBeNull();
    expect(parsePoundsToPence('10.999')).toBeNull();
    expect(parsePoundsToPence('-5')).toBeNull();
    expect(parsePoundsToPence('10p')).toBeNull();
  });

  it('never returns a fractional value', () => {
    for (const input of ['0', '0.01', '3.33', '99.99']) {
      const pence = parsePoundsToPence(input);
      expect(pence).not.toBeNull();
      expect(Number.isInteger(pence)).toBe(true);
    }
  });
});

describe('sumPence', () => {
  it('adds without floating point error', () => {
    // The whole reason for integer pence: 0.1 + 0.2 in pounds is not 0.3.
    expect(sumPence([10, 20])).toBe(30);
    expect(sumPence([700, 700, 1000, 1000])).toBe(3400);
    expect(sumPence([])).toBe(0);
  });
});
