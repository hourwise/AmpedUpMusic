/**
 * POST /api/admin/gigs/duplicate - copy a promotion into a clean draft
 * (AMPED-04D, revised).
 *
 * The client sends only the source id and the operator-chosen NEW doors and
 * start times. All reusable structure is read from D1; the source event, its
 * commercial history and its dates are never accepted from the client and are
 * never modified. Protected by the AMPED-04A `/api/admin/*` middleware.
 */

import type { APIRoute } from 'astro';
import { getAdminGigMutations } from '@/services/index.ts';
import { parseDuplicateInput } from '@/lib/validation.ts';
import { fail, fromError, json, operatorFrom, readJson } from './_respond.ts';

export const POST: APIRoute = async ({ request, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const parsed = parseDuplicateInput(body);
  if (!parsed.ok) return fail(400, 'invalid', parsed.fields);

  try {
    const created = await getAdminGigMutations().duplicate(
      parsed.value.sourceEventId,
      { doorsAt: parsed.value.doorsAt, startsAt: parsed.value.startsAt },
      operator,
    );
    return json({ ok: true, id: created.id, slug: created.slug }, 201);
  } catch (error) {
    return fromError(error);
  }
};
