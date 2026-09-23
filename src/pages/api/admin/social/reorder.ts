/**
 * POST /api/admin/social/reorder - set the featured homepage order (AMPED-05C).
 *
 * Body: { ids: [...] } where the array order IS the requested order and the ids
 * are exactly the current featured set. Duplicates are 400; a stale, missing,
 * unknown or non-featured set is 409. No client position numbers are accepted.
 */

import type { APIRoute } from 'astro';
import { getAdminSocial } from '@/services/index.ts';
import { fail, fromError, json, operatorFrom, readJson } from '../gigs/_respond.ts';

export const POST: APIRoute = async ({ request, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const unknown = Object.keys(body).filter((key) => key !== 'ids');
  if (unknown.length > 0) return fail(400, 'invalid', { ids: 'Unsupported field.' });

  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
    return fail(400, 'invalid', { ids: 'Send the featured order as a list of ids.' });
  }

  try {
    await getAdminSocial().reorder(body.ids as string[], operator);
    return json({ ok: true });
  } catch (error) {
    return fromError(error);
  }
};
