/**
 * GET /media/:id - serve an uploaded image (AMPED-05A).
 *
 * The R2 bucket stays private: this route is the only way an uploaded image
 * reaches the public site. It is identifier-addressed (asset ids are random,
 * so the store is not enumerable), returns the stored MIME with `nosniff`, and
 * never exposes the storage key or R2 credentials. The route reads through the
 * service layer and does not import `cloudflare:workers`.
 *
 * Visibility rule: any existing asset id is served. Assets are addressed by an
 * unguessable id, and drafts/attachments are governed by the pages that
 * reference them rather than by a second authorization system here.
 *
 * Cache: objects are immutable - a new upload is a new id and a new key - so
 * the response is safe to cache for a year.
 */

import type { APIRoute } from 'astro';
import { getPublicMediaObject } from '@/services/index.ts';

export const GET: APIRoute = async ({ params }) => {
  const id = params.id;
  if (!id) return new Response('Not found', { status: 404 });

  let object: Awaited<ReturnType<typeof getPublicMediaObject>>;
  try {
    object = await getPublicMediaObject(id);
  } catch {
    // Bindings unavailable (for example a locally misconfigured runtime).
    return new Response('Service unavailable', { status: 503 });
  }

  if (!object) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': object.mime,
      'Content-Length': String(object.byteSize),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
