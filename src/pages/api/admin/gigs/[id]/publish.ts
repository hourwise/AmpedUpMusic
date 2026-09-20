/**
 * POST /api/admin/gigs/:id/publish - move a draft onto the public site
 * (AMPED-04B).
 *
 * Readiness is re-derived from stored state inside the mutation service; the
 * client's copy of the form is never trusted to decide what is publishable.
 * Protected automatically by the AMPED-04A `/api/admin/*` middleware.
 */

import type { APIRoute } from 'astro';
import { getAdminGigMutations } from '@/services/index.ts';
import { fail, fromError, json, operatorFrom } from '../_respond.ts';

export const POST: APIRoute = async ({ params, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const id = params.id;
  if (!id) return fail(404, 'not-found');

  try {
    await getAdminGigMutations().publish(id, operator);
    return json({ ok: true, id, status: 'published' });
  } catch (error) {
    return fromError(error);
  }
};
