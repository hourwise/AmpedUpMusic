/**
 * POST /api/admin/media - upload an image (AMPED-05A).
 *
 * multipart/form-data: file, role, alt, and optionally credit, eventId or
 * artistId. The file is validated from its bytes before anything is stored; the
 * object key is generated server-side. Protected by the AMPED-04A middleware.
 */

import type { APIRoute } from 'astro';
import { getAdminMediaMutations } from '@/services/index.ts';
import { UploadError, validateUpload } from '@/lib/upload.ts';
import { fail, fromError, json, operatorFrom } from '../gigs/_respond.ts';

export const POST: APIRoute = async ({ request, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, 'invalid', { file: 'Expected a multipart form upload.' });
  }

  const file = form.get('file');
  if (!file || typeof (file as File).arrayBuffer !== 'function') {
    return fail(400, 'invalid', { file: 'Choose an image to upload.' });
  }

  try {
    const validated = await validateUpload({
      file: file as File,
      alt: form.get('alt'),
      role: form.get('role'),
      credit: form.get('credit'),
      eventId: form.get('eventId'),
      artistId: form.get('artistId'),
    });
    const created = await getAdminMediaMutations().upload(validated, operator);
    return json({ ok: true, id: created.id, url: created.url }, 201);
  } catch (error) {
    if (error instanceof UploadError) return fail(error.status, 'invalid', error.fields);
    return fromError(error);
  }
};
