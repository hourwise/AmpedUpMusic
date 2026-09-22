/**
 * POST /api/admin/media/photography - update an event's photography credit and
 * links (AMPED-05B).
 *
 * Body: { eventId, credit?, galleryUrl?, photographerUrl? }. Unknown fields are
 * rejected. URLs must be http(s); a blank value clears the column. This writes
 * only the three photography columns on the event - never its title, date,
 * status, tickets, venue or line-up.
 */

import type { APIRoute } from 'astro';
import { getAdminMediaMutations, type PhotographyFields } from '@/services/index.ts';
import { isHttpUrl } from '@/services/d1/media.ts';
import { fail, fromError, json, operatorFrom, readJson } from '../gigs/_respond.ts';

const ALLOWED = ['eventId', 'credit', 'galleryUrl', 'photographerUrl'];

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

const validUrl = isHttpUrl;

export const POST: APIRoute = async ({ request, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const unknown = Object.keys(body).filter((key) => !ALLOWED.includes(key));
  if (unknown.length > 0) return fail(400, 'invalid', { [unknown[0]!]: 'Unsupported field.' });

  const eventId = clean(body.eventId);
  if (!eventId) return fail(400, 'invalid', { eventId: 'Choose a gig.' });

  const fields: PhotographyFields = {};
  const credit = clean(body.credit);
  const galleryUrl = clean(body.galleryUrl);
  const photographerUrl = clean(body.photographerUrl);

  if (credit) {
    if (credit.length > 200) return fail(400, 'invalid', { credit: 'That credit is too long.' });
    fields.credit = credit;
  }
  if (galleryUrl) {
    if (!validUrl(galleryUrl)) return fail(400, 'invalid', { galleryUrl: 'Use a full https:// link.' });
    fields.galleryUrl = galleryUrl;
  }
  if (photographerUrl) {
    if (!validUrl(photographerUrl)) {
      return fail(400, 'invalid', { photographerUrl: 'Use a full https:// link.' });
    }
    fields.photographerUrl = photographerUrl;
  }

  try {
    await getAdminMediaMutations().updatePhotography(eventId, fields, operator);
    return json({ ok: true, eventId });
  } catch (error) {
    return fromError(error);
  }
};
