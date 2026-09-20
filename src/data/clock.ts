/**
 * Fixture clock.
 *
 * Fixture dates are expressed as offsets from today rather than as fixed
 * calendar dates, so the scaffold never rots: the "next gig" is always about
 * a fortnight away and the archive is always genuinely in the past, whenever
 * anyone happens to open it.
 *
 * This file exists only to support the mock data layer. AMPED-02A onwards
 * reads real timestamps from D1 and nothing should import it.
 */

const TZ = 'Europe/London';

/** Milliseconds Europe/London is ahead of UTC at the given instant. */
function londonOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00';

  // `hour` can come back as "24" for midnight in some runtimes.
  const hour = get('hour') === '24' ? '00' : get('hour');
  const asUtc = Date.parse(
    `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}Z`,
  );
  return asUtc - at.getTime();
}

/**
 * The UTC instant at which the London wall clock reads `hhmm` on the day that
 * is `dayOffset` days from today.
 *
 * The offset is resolved twice because the first guess can land on the wrong
 * side of a DST transition; the second pass settles it.
 */
export function londonAt(dayOffset: number, hhmm: string): string {
  const day = new Date();
  day.setUTCHours(12, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() + dayOffset);

  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(day);
  let guess = Date.parse(`${ymd}T${hhmm}:00Z`);
  for (let i = 0; i < 2; i += 1) {
    guess = Date.parse(`${ymd}T${hhmm}:00Z`) - londonOffsetMs(new Date(guess));
  }
  return new Date(guess).toISOString();
}

/** An instant `days` days (and optionally `hours`) from now. */
export function fromNow(days: number, hours = 0): string {
  return new Date(Date.now() + days * 86_400_000 + hours * 3_600_000).toISOString();
}

/** The instant the fixtures were loaded. Used for `createdAt` style fields. */
export const FIXTURE_EPOCH = new Date().toISOString();
