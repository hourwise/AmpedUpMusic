/**
 * PATCH /api/admin/gigs/:id - edit a promotion (AMPED-04B)
 * DELETE /api/admin/gigs/:id - delete an eligible draft
 *
 * Protected automatically by the AMPED-04A `/api/admin/*` middleware.
 */

import type { APIRoute } from 'astro';
import { getAdminGigMutations } from '@/services/index.ts';
import { parseGigInput } from '@/lib/validation.ts';
import { fail, fromError, json, operatorFrom, readJson } from './_respond.ts';

export const PATCH: APIRoute = async ({ request, params, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const id = params.id;
  if (!id) return fail(404, 'not-found');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const parsed = parseGigInput(body);
  if (!parsed.ok) return fail(400, 'invalid', parsed.fields);

  try {
    const result = await getAdminGigMutations().update(id, parsed.value, operator);
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
    await getAdminGigMutations().remove(id, operator);
    return json({ ok: true, id });
  } catch (error) {
    return fromError(error);
  }
};
