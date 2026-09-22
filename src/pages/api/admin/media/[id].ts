/**
 * DELETE /api/admin/media/:id - remove an uploaded image (AMPED-05A).
 *
 * Compensating delete: the R2 object is buffered, deleted and, if the D1 batch
 * fails, restored, so the database and the bucket cannot silently disagree.
 * Protected by the AMPED-04A middleware.
 */

import type { APIRoute } from 'astro';
import { getAdminMediaMutations } from '@/services/index.ts';
import { fail, fromError, json, operatorFrom } from '../gigs/_respond.ts';

export const DELETE: APIRoute = async ({ params, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const id = params.id;
  if (!id) return fail(404, 'not-found');

  try {
    await getAdminMediaMutations().remove(id, operator);
    return json({ ok: true, id });
  } catch (error) {
    return fromError(error);
  }
};
