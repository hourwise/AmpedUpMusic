/**
 * POST /api/admin/artists - create an artist (AMPED-04C).
 *
 * Protected automatically by the AMPED-04A `/api/admin/*` middleware. Unknown
 * payload fields are rejected by the validator, not ignored.
 */

import type { APIRoute } from 'astro';
import { getAdminEntityMutations } from '@/services/index.ts';
import { parseArtistInput } from '@/lib/validation.ts';
import { fail, fromError, json, operatorFrom, readJson } from '../gigs/_respond.ts';

export const POST: APIRoute = async ({ request, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const parsed = parseArtistInput(body);
  if (!parsed.ok) return fail(400, 'invalid', parsed.fields);

  try {
    const created = await getAdminEntityMutations().artists.create(parsed.value, operator);
    return json({ ok: true, id: created.id, slug: created.slug }, 201);
  } catch (error) {
    return fromError(error);
  }
};
