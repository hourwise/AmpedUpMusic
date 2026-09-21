/**
 * POST /api/admin/venues - create a venue (AMPED-04C).
 *
 * Accessibility information is required by the validator; a venue cannot be
 * created without it. Protected by the AMPED-04A `/api/admin/*` middleware.
 */

import type { APIRoute } from 'astro';
import { getAdminEntityMutations } from '@/services/index.ts';
import { parseVenueInput } from '@/lib/validation.ts';
import { fail, fromError, json, operatorFrom, readJson } from '../gigs/_respond.ts';

export const POST: APIRoute = async ({ request, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const parsed = parseVenueInput(body);
  if (!parsed.ok) return fail(400, 'invalid', parsed.fields);

  try {
    const created = await getAdminEntityMutations().venues.create(parsed.value, operator);
    return json({ ok: true, id: created.id, slug: created.slug }, 201);
  } catch (error) {
    return fromError(error);
  }
};
