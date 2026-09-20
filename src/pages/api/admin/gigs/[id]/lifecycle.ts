/**
 * POST /api/admin/gigs/:id/lifecycle - postpone, cancel, complete, archive
 * (AMPED-04B).
 *
 * The caller sends the status it believes the gig is in (`from`); the service
 * applies a conditional update against that status and returns 409 if the gig
 * moved on in the meantime, so a stale admin tab cannot force an illegal
 * transition. Protected by the AMPED-04A `/api/admin/*` middleware.
 */

import type { APIRoute } from 'astro';
import { getAdminGigMutations } from '@/services/index.ts';
import { EVENT_STATUSES, ValidationError } from '@/lib/validation.ts';
import type { EventStatus } from '@/types/domain.ts';
import { fail, fromError, json, operatorFrom, readJson } from '../_respond.ts';

function asStatus(value: unknown): EventStatus | null {
  return typeof value === 'string' && (EVENT_STATUSES as readonly string[]).includes(value)
    ? (value as EventStatus)
    : null;
}

export const POST: APIRoute = async ({ request, params, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const id = params.id;
  if (!id) return fail(404, 'not-found');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const to = asStatus(body.to);
  const from = asStatus(body.from);
  if (!to || !from) {
    return fail(400, 'invalid', { status: 'Unknown lifecycle status.' });
  }

  try {
    await getAdminGigMutations().transition(id, to, from, operator, {
      statusMessage: typeof body.statusMessage === 'string' ? body.statusMessage : undefined,
    });
    return json({ ok: true, id, status: to });
  } catch (error) {
    if (error instanceof ValidationError && error.fields.status) {
      return fail(400, 'invalid', error.fields);
    }
    return fromError(error);
  }
};
