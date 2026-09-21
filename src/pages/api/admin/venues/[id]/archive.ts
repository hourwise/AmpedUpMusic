/**
 * POST /api/admin/venues/:id/archive - retire a venue from new-promotion
 * pickers (AMPED-04C).
 *
 * One-way in V1. `archived_at` comes from the server clock. Already-archived
 * returns 409.
 */

import type { APIRoute } from 'astro';
import { getAdminEntityMutations } from '@/services/index.ts';
import { fail, fromError, json, operatorFrom } from '../../gigs/_respond.ts';

export const POST: APIRoute = async ({ params, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const id = params.id;
  if (!id) return fail(404, 'not-found');

  try {
    await getAdminEntityMutations().venues.archive(id, operator);
    return json({ ok: true, id, archived: true });
  } catch (error) {
    return fromError(error);
  }
};
