/**
 * The field panel's routes (framework-free; the DB tests call them under runWithSession):
 *
 *  GET /api/fields/<id> → 200 `FieldDetail` (contract: src/domain/fields.ts), private data:
 *    requireRole(ROLE_FOR.viewPrivate) first (401/403 JSON otherwise), `Cache-Control: private,
 *    no-store`, and the session's effective role in `X-Farm-Role` (the panel shows the notes
 *    editor from it; the server re-checks on save). 404 for an unknown or malformed id, 503 when
 *    the database is unavailable. One query, one round trip (src/db/queries/fields.ts).
 *
 *  PUT /api/fields/<id>/notes, JSON `{ text: string | null, version }` → requireRole(
 *    ROLE_FOR.editFieldNotes) first (manager+), then: 403 for a cross-site request (an Origin
 *    that isn't this host), 415 unless application/json, 413 over 256 KiB, 400 for a bad body,
 *    404 unknown field, 409 `{ error, notes }` when someone saved since `version` (nothing
 *    written), else 200 `{ notes }` and `fields`/`updated` `{ fieldId, parts: ['notes'] }` is
 *    published in the same transaction. Every answer is `no-store` and JSON (limitedJson).
 */
import type { Db } from '@/db/client';
import type { Executor } from '@/db/exec';
import { fieldDetail, saveFieldNotes } from '@/db/queries/fields';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { ROLE_FOR } from '@/platform/auth/types';
import { limitedJson, readLimitedText } from '@/platform/http/limits';
import { parseSaveNotesBody } from '@/ui/fields/notes';
import { FIELD_ROLE_HEADER } from '@/ui/fields/protocol';

/** Notes are at most 10 000 characters; JSON escaping can triple that. */
export const MAX_NOTES_BODY_BYTES = 256 * 1024;

const NO_STORE = { 'cache-control': 'no-store' } as const;

function json(status: number, body: unknown, headers: Record<string, string> = NO_STORE): Response {
  return limitedJson(body, { status, headers }, { route: 'api/fields' });
}

/**
 * Is the request from a page of this app (or not from a browser page at all)? Browsers send
 * `Origin` on every PUT; it must name the host the request came to (the LAN address, localhost,
 * or the production domain behind Vercel's x-forwarded-host).
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return host !== null && new URL(origin).host === host.split(',')[0]?.trim();
  } catch {
    return false;
  }
}

export async function handleFieldDetail(
  fieldId: string,
  ex: Executor,
  now: Date = new Date(),
): Promise<Response> {
  let role: string;
  try {
    role = (await requireRole(ROLE_FOR.viewPrivate)).role;
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  try {
    const detail = await fieldDetail(ex, fieldId, now);
    if (!detail) return json(404, { error: 'field not found' });
    return limitedJson(
      detail,
      { headers: { 'cache-control': 'private, no-store', [FIELD_ROLE_HEADER]: role } },
      { route: 'api/fields' },
    );
  } catch (e) {
    console.error('[api/fields]', (e as Error).message);
    return json(503, { error: 'field data unavailable' });
  }
}

export async function handleSaveNotes(
  request: Request,
  fieldId: string,
  db: Db,
): Promise<Response> {
  let appUserId: string | null;
  try {
    appUserId = (await requireRole(ROLE_FOR.editFieldNotes)).appUserId;
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  if (!isSameOriginRequest(request)) return json(403, { error: 'cross-site request refused' });
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    return json(415, { error: 'send the notes as application/json' });
  }
  const text = await readLimitedText(request, MAX_NOTES_BODY_BYTES);
  if (text === null) return json(413, { error: 'request body too large' });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'body is not valid JSON' });
  }
  const parsed = parseSaveNotesBody(body);
  if (!parsed.ok) return json(400, { error: parsed.error });

  try {
    const r = await saveFieldNotes(db, {
      fieldId,
      text: parsed.text,
      version: parsed.version,
      appUserId,
    });
    switch (r.status) {
      case 'saved':
        return json(200, { notes: r.notes });
      case 'conflict':
        return json(409, {
          error: 'someone else changed these notes; review theirs and save again',
          notes: r.notes,
        });
      case 'not_found':
        return json(404, { error: 'field not found' });
    }
  } catch (e) {
    console.error('[api/fields/notes]', (e as Error).message);
    return json(503, { error: 'notes could not be saved; try again' });
  }
}
