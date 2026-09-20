/**
 * Shared response/error plumbing for the protected gig admin API (AMPED-04B).
 *
 * Underscore-prefixed, so Astro treats it as a module rather than a route. The
 * admin namespace is protected by the AMPED-04A middleware before any handler
 * here runs; these helpers additionally refuse to work without a verified
 * operator, so a missing locals value can never become an anonymous write.
 */

import type { GigOperator } from '@/services/d1/events.ts';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/validation.ts';

export function operatorFrom(locals: App.Locals): GigOperator | null {
  const operator = locals.operator;
  if (!operator?.email) return null;
  return { email: operator.email, sub: operator.sub };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function fail(status: number, error: string, fields?: Record<string, string>): Response {
  return json(fields ? { ok: false, error, fields } : { ok: false, error }, status);
}

/** Read a JSON body, rejecting anything that is not an object. */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Map a thrown domain error to a safe HTTP response. Anything unexpected is a
 * generic 500: no stack trace, no SQL, no internal message.
 */
export function fromError(error: unknown): Response {
  if (error instanceof ValidationError) return fail(400, 'invalid', error.fields);
  if (error instanceof ConflictError) return fail(409, 'conflict', { status: error.message });
  if (error instanceof NotFoundError) return fail(404, 'not-found');
  return fail(500, 'server-error');
}
