/**
 * PATCH /api/admin/artists/:id - edit an artist (AMPED-04C)
 * DELETE /api/admin/artists/:id - delete an unreferenced artist
 *
 * A referenced artist cannot be hard-deleted; the service returns 409 and the
 * operator archives instead. An archived artist cannot be edited.
 */

import type { APIRoute } from 'astro';
import { getAdminEntityMutations } from '@/services/index.ts';
import { parseArtistInput } from '@/lib/validation.ts';
import { fail, fromError, json, operatorFrom, readJson } from '../gigs/_respond.ts';

export const PATCH: APIRoute = async ({ request, params, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const id = params.id;
  if (!id) return fail(404, 'not-found');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const parsed = parseArtistInput(body);
  if (!parsed.ok) return fail(400, 'invalid', parsed.fields);

  try {
    const result = await getAdminEntityMutations().artists.update(id, parsed.value, operator);
    return json({ ok: true, id, slug: result.slug });
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
    await getAdminEntityMutations().artists.remove(id, operator);
    return json({ ok: true, id });
  } catch (error) {
    return fromError(error);
  }
};
