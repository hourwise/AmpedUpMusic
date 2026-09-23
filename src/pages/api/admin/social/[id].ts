/**
 * PATCH /api/admin/social/:id - edit or feature/unfeature a curated post
 * DELETE /api/admin/social/:id - remove a curated post
 * (AMPED-05C)
 *
 * Only the accepted mutable fields are written; featured_position is never
 * accepted from the client - it follows the feature/unfeature semantics.
 */

import type { APIRoute } from 'astro';
import { getAdminSocial } from '@/services/index.ts';
import { parseSocialPayload } from '@/services/d1/social.ts';
import { fail, fromError, json, operatorFrom, readJson } from '../gigs/_respond.ts';

export const PATCH: APIRoute = async ({ request, params, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const id = params.id;
  if (!id) return fail(404, 'not-found');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const parsed = parseSocialPayload(body);
  if (!parsed.ok) return fail(400, 'invalid', parsed.fields);

  try {
    await getAdminSocial().update(id, parsed.value, operator);
    return json({ ok: true, id });
  } catch (error) {
    return fromError(error);
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const id = params.id;
  if (!id) return fail(404, 'not-found');

  try {
    await getAdminSocial().remove(id, operator);
    return json({ ok: true, id });
  } catch (error) {
    return fromError(error);
  }
};
