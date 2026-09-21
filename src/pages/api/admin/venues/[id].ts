/**
 * PATCH /api/admin/venues/:id - edit a venue (AMPED-04C)
 * DELETE /api/admin/venues/:id - delete an unreferenced venue
 *
 * A venue that hosts any gig cannot be hard-deleted; the service returns 409
 * and the operator archives instead. An archived venue cannot be edited.
 */

import type { APIRoute } from 'astro';
import { getAdminEntityMutations } from '@/services/index.ts';
import { parseVenueInput } from '@/lib/validation.ts';
import { fail, fromError, json, operatorFrom, readJson } from '../gigs/_respond.ts';

export const PATCH: APIRoute = async ({ request, params, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const id = params.id;
  if (!id) return fail(404, 'not-found');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const parsed = parseVenueInput(body);
  if (!parsed.ok) return fail(400, 'invalid', parsed.fields);

  try {
    const result = await getAdminEntityMutations().venues.update(id, parsed.value, operator);
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
    await getAdminEntityMutations().venues.remove(id, operator);
    return json({ ok: true, id });
  } catch (error) {
    return fromError(error);
  }
};
