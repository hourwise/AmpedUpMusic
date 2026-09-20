/**
 * POST /api/admin/gigs - create a draft promotion (AMPED-04B).
 *
 * Protected automatically by the AMPED-04A `/api/admin/*` middleware. The
 * handler refuses to run without the verified operator it populates.
 */

import type { APIRoute } from 'astro';
import { getAdminGigMutations } from '@/services/index.ts';
import { parseGigInput } from '@/lib/validation.ts';
import { fail, fromError, json, operatorFrom, readJson } from './_respond.ts';

export const POST: APIRoute = async ({ request, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const parsed = parseGigInput(body);
  if (!parsed.ok) return fail(400, 'invalid', parsed.fields);

  try {
    const created = await getAdminGigMutations().create(parsed.value, operator);
    return json({ ok: true, id: created.id, slug: created.slug }, 201);
  } catch (error) {
    return fromError(error);
  }
};
