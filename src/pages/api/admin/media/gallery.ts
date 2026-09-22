/**
 * POST /api/admin/media/gallery - upload several gallery photographs to one
 * event in a single operator action (AMPED-05B).
 *
 * multipart/form-data:
 *   eventId   - the target event
 *   manifest  - JSON array, one object per file: { alt, credit? }
 *   files     - one or more file parts, in the same order as the manifest
 *
 * Every file keeps the full AMPED-05A validation (MIME allow-list, magic bytes,
 * 8 MiB, dimension limits); alt text is required per file and is never taken
 * from a filename. The whole batch is bounded (10 files / 40 MiB).
 */

import type { APIRoute } from 'astro';
import { getAdminMediaMutations } from '@/services/index.ts';
import { UploadError, validateUpload, type ValidatedUpload } from '@/lib/upload.ts';
import { ValidationError } from '@/lib/validation.ts';
import { fail, fromError, json, operatorFrom } from '../gigs/_respond.ts';

export const POST: APIRoute = async ({ request, locals }) => {
  const operator = operatorFrom(locals);
  if (!operator) return fail(403, 'forbidden');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, 'invalid', { files: 'Expected a multipart form upload.' });
  }

  const eventId = form.get('eventId');
  if (typeof eventId !== 'string' || eventId.trim().length === 0) {
    return fail(400, 'invalid', { eventId: 'Choose a gig for these photographs.' });
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(typeof form.get('manifest') === 'string' ? (form.get('manifest') as string) : '');
  } catch {
    return fail(400, 'invalid', { manifest: 'The photo details were not valid JSON.' });
  }
  if (!Array.isArray(manifest)) {
    return fail(400, 'invalid', { manifest: 'The photo details must be a list.' });
  }

  const files = form.getAll('files').filter((entry) => typeof (entry as File).arrayBuffer === 'function') as File[];
  if (files.length !== manifest.length) {
    return fail(400, 'invalid', {
      files: 'Each photograph needs exactly one set of details.',
    });
  }

  try {
    const validated: ValidatedUpload[] = [];
    for (const [index, file] of files.entries()) {
      const meta = (manifest[index] ?? {}) as Record<string, unknown>;
      const unknown = Object.keys(meta).filter((key) => key !== 'alt' && key !== 'credit');
      if (unknown.length > 0) {
        return fail(400, 'invalid', { manifest: 'Unsupported photo detail field.' });
      }
      validated.push(
        await validateUpload({
          file,
          role: 'gallery',
          alt: meta.alt,
          credit: meta.credit,
          eventId,
        }),
      );
    }

    const created = await getAdminMediaMutations().uploadGalleryBatch(
      eventId.trim(),
      validated,
      operator,
    );
    return json({ ok: true, ids: created.ids, positions: created.positions }, 201);
  } catch (error) {
    if (error instanceof UploadError) return fail(error.status, 'invalid', error.fields);
    if (error instanceof ValidationError) return fail(400, 'invalid', error.fields);
    return fromError(error);
  }
};
