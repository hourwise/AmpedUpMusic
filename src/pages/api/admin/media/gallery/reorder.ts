/**
 * POST /api/admin/media/gallery/reorder - persist a new gallery order
 * (AMPED-05B).
 *
 * Body: { eventId, assetIds } where assetIds lists every current gallery asset
 * for the event exactly once, in the requested order. Positions are written as
 * 0..n-1. If the gallery has changed since the page loaded the request is stale
 * and gets 409 rather than silently dropping or inventing a photograph.
 */

import type { APIRoute } from 'astro';
import { getAdminMediaMutations } from '@/services/index.ts';
import { ValidationError } from '@/lib/validation.ts';
import { fail, fromError, json, operatorFrom, readJson } from '../../gigs/_respond.ts';

export const POST: APIRoute = async ({ request, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const unknown = Object.keys(body).filter((key) => key !== 'eventId' && key !== 'assetIds');
  if (unknown.length > 0) return fail(400, 'invalid', { assetIds: 'Unsupported field.' });

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
  if (!eventId) return fail(400, 'invalid', { eventId: 'Choose a gig.' });
  if (!Array.isArray(body.assetIds) || body.assetIds.some((id) => typeof id !== 'string')) {
    return fail(400, 'invalid', { assetIds: 'Send the photograph order as a list of ids.' });
  }

  try {
    await getAdminMediaMutations().reorderGallery(eventId, body.assetIds as string[], operator);
    return json({ ok: true, eventId });
  } catch (error) {
    if (error instanceof ValidationError) return fail(400, 'invalid', error.fields);
    return fromError(error);
  }
};
