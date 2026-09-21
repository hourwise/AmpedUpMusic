/**
 * POST /api/admin/artists/inline - create an artist and attach them to a gig
 * in one action (AMPED-04C PromotionForm "+ Add artist").
 *
 * The body is the normal artist payload plus the target `eventId`. Artist
 * insert, `event_artists` join and both audit rows run in one D1 batch, so the
 * operator never ends up with an artist that was created but not billed.
 */

import type { APIRoute } from 'astro';
import { getAdminEntityMutations } from '@/services/index.ts';
import { parseArtistInput } from '@/lib/validation.ts';
import { fail, fromError, json, operatorFrom, readJson } from '../gigs/_respond.ts';

export const POST: APIRoute = async ({ request, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  const body = await readJson(request);
  if (!body) return fail(400, 'invalid');

  const { eventId, ...artistBody } = body;
  if (typeof eventId !== 'string' || eventId.trim().length === 0) {
    return fail(400, 'invalid', { eventId: 'Choose a gig for this artist.' });
  }

  const parsed = parseArtistInput(artistBody);
  if (!parsed.ok) return fail(400, 'invalid', parsed.fields);

  try {
    const created = await getAdminEntityMutations().artists.createAndAttachToEvent(
      parsed.value,
      eventId.trim(),
      operator,
    );
    return json({ ok: true, id: created.id, slug: created.slug, position: created.position }, 201);
  } catch (error) {
    return fromError(error);
  }
};
