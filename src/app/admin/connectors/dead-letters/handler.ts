/**
 * POST /admin/connectors/dead-letters (1f, sync-health): requeue or discard dead-lettered raw
 * events without the page, JSON `{ action: 'requeue' | 'discard', ids: [uuid…] }` or
 * `{ action, all: true, source?, stream? }` (./../dead-letters.ts). Framework-free so the DB test
 * calls it under a session:
 *
 *   requireRole(ROLE_FOR.admin) FIRST (401 signed out, 403 for a viewer, driver or operator),
 *   then 403 for a cross-site request, 415 unless application/json, 413 over 16 KiB, 400 for a
 *   bad body, else 200 `{ ok: true, action, count }`. Every answer is JSON and `no-store`.
 */
import type { Executor } from '@/db/exec';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { ROLE_FOR } from '@/platform/auth/types';
import { limitedJson, readLimitedText } from '@/platform/http/limits';
import { isSameOriginRequest } from '@/platform/http/origin';
import { deadLetterRequestSchema, discardDead, requeueDead } from '../dead-letters';

export const MAX_DEAD_LETTER_BODY_BYTES = 16 * 1024;

function json(status: number, body: unknown): Response {
  return limitedJson(
    body,
    { status, headers: { 'cache-control': 'no-store' } },
    { route: 'admin/connectors/dead-letters' },
  );
}

export async function handleDeadLetters(request: Request, ex: Executor): Promise<Response> {
  let by: string;
  try {
    by = (await requireRole(ROLE_FOR.admin)).displayName;
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  if (!isSameOriginRequest(request)) return json(403, { error: 'cross-site request refused' });
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json(415, { error: 'send application/json' });
  }
  const text = await readLimitedText(request, MAX_DEAD_LETTER_BODY_BYTES);
  if (text === null) return json(413, { error: 'body too large' });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return json(400, { error: 'body is not JSON' });
  }
  const parsed = deadLetterRequestSchema.safeParse(value);
  if (!parsed.success) {
    return json(400, {
      error: "expected { action: 'requeue' | 'discard', ids: [...] } or { action, all: true }",
    });
  }
  const { action, ...rest } = parsed.data;
  const sel = rest as Parameters<typeof requeueDead>[1];
  const count = action === 'requeue' ? await requeueDead(ex, sel) : await discardDead(ex, sel, by);
  return json(200, { ok: true, action, count });
}
