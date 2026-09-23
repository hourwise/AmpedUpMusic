/**
 * POST /api/admin/social - curate a social post (AMPED-05C).
 *
 * The operator supplies the URL, network and optional presentation fields; the
 * application stores exactly that. Nothing is fetched, crawled or scraped, and
 * the URL is only validated. Protected by the AMPED-04A `/api/admin/*`
 * middleware and the verified operator.
 */

import type { APIRoute } from 'astro';
import { getAdminSocial } from '@/services/index.ts';
import { parseSocialPayload } from '@/services/d1/social.ts';
import { fail, fromError, json, operatorFrom, readJson } from '../gigs/_respond.ts';

export const POST: APIRoute = async ({ request, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const parsed = parseSocialPayload(body);
  if (!parsed.ok) return fail(400, 'invalid', parsed.fields);

  try {
    const created = await getAdminSocial().create(parsed.value, operator);
    return json({ ok: true, id: created.id }, 201);
  } catch (error) {
    return fromError(error);
  }
};
