/** Protected 08B door mutation. Access + Origin/Fetch-Metadata middleware runs first. */
import type { APIRoute } from 'astro';
import { getTicketCheckIn } from '@/services/index.ts';
import { fail, fromError, json, operatorFrom, readJson } from '../../gigs/_respond.ts';

export const POST: APIRoute = async ({ params, locals, request }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');
  const eventId = params.eventId;
  if (!eventId) return fail(404, 'event-not-found');
  const body = await readJson(request);
  if (typeof body?.token !== 'string' || body.token.length === 0 || body.token.length > 160) {
    return fail(400, 'invalid-token');
  }
  try {
    const result = await getTicketCheckIn().scan(body.token, eventId, operator.email);
    return json({ ok: true, ...result });
  } catch (error) {
    return fromError(error);
  }
};
