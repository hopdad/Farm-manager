/**
 * /api/tile-lines (plan 1d "tile_lines … draw tool"): the draw tool's reads and writes,
 * framework-free (Web Request/Response, a pg Pool) so DB tests drive them with runWithSession.
 *
 *  GET    /api/tile-lines?bbox=w,s,e,n | ?fieldId=<uuid>   viewer+: lines + canEdit
 *  POST   /api/tile-lines                                  manager+: draw a new line
 *  PATCH  /api/tile-lines/<id>  { version, …changes }      manager+: edit attributes / shape
 *  DELETE /api/tile-lines/<id>?version=<v>                 manager+
 *
 * requireRole runs FIRST, on the server (ROLE_FOR.editTileLines for writes); the browser's
 * `canEdit` is a hint. Bodies are read through readLimitedText (4 MB), validated with the zod
 * schemas in src/db/queries/tile-lines-schema.ts. Every write runs in one transaction that also
 * publishes `layers`/`updated { key: 'tile_lines' }` (delivered on commit). Responses are
 * `no-store` (private data) and go through limitedJson.
 */
import type pg from 'pg';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { ROLE_FOR, roleAtLeast } from '@/platform/auth/types';
import { limitedJson, readLimitedText } from '@/platform/http/limits';
import {
  createTileLine,
  deleteTileLine,
  listTileLines,
  TileLineConflictError,
  TileLineFieldError,
  TileLineNotFoundError,
  TileLineReadOnlyError,
  updateTileLine,
} from '../../../db/queries/tile-lines';
import {
  createTileLineSchema,
  parseBbox,
  type TileLinesResponse,
  updateTileLineSchema,
} from '../../../db/queries/tile-lines-schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { 'cache-control': 'no-store' };

function json(body: unknown, status = 200): Response {
  return limitedJson(body, { status, headers: NO_STORE }, { route: 'api/tile-lines' });
}

const error = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  json({ error: message, ...extra }, status);

/** Map the query layer's errors to statuses; rethrow anything else. */
function writeError(e: unknown): Response {
  const auth = authErrorResponse(e);
  if (auth) return auth;
  if (e instanceof TileLineNotFoundError) return error(404, e.message);
  if (e instanceof TileLineConflictError) return error(409, e.message);
  if (e instanceof TileLineReadOnlyError) return error(403, e.message);
  if (e instanceof TileLineFieldError) return error(400, e.message);
  throw e;
}

async function inTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  const text = await readLimitedText(request);
  if (text === null) return { ok: false, res: error(413, 'request body over 4 MB') };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, res: error(400, 'body is not JSON') };
  }
}

export async function handleListTileLines(request: Request, pool: pg.Pool): Promise<Response> {
  let canEdit: boolean;
  try {
    const session = await requireRole(ROLE_FOR.viewPrivate);
    canEdit = roleAtLeast(session.role, ROLE_FOR.editTileLines);
  } catch (e) {
    return writeError(e);
  }
  const q = new URL(request.url).searchParams;
  const fieldId = q.get('fieldId');
  const bbox = parseBbox(q.get('bbox'));
  if (q.has('bbox') && !bbox)
    return error(400, 'bbox must be w,s,e,n in degrees (at most 2° wide)');
  if (fieldId !== null && !UUID_RE.test(fieldId)) return error(400, 'bad fieldId');
  if (!bbox && !fieldId) return error(400, 'give bbox=w,s,e,n or fieldId=<uuid>');
  const r = await listTileLines(pool, { bbox: bbox ?? undefined, fieldId: fieldId ?? undefined });
  const body: TileLinesResponse = { lines: r.lines, canEdit, truncated: r.truncated };
  return json(body);
}

export async function handleCreateTileLine(request: Request, pool: pg.Pool): Promise<Response> {
  try {
    const session = await requireRole(ROLE_FOR.editTileLines);
    const body = await readJson(request);
    if (!body.ok) return body.res;
    const parsed = createTileLineSchema.safeParse(body.value);
    if (!parsed.success) return error(400, 'invalid tile line', { issues: parsed.error.issues });
    const line = await inTransaction(pool, (c) => createTileLine(c, parsed.data, session));
    return json({ line }, 201);
  } catch (e) {
    return writeError(e);
  }
}

export async function handleUpdateTileLine(
  request: Request,
  id: string,
  pool: pg.Pool,
): Promise<Response> {
  try {
    await requireRole(ROLE_FOR.editTileLines);
    if (!UUID_RE.test(id)) return error(404, 'no such tile line');
    const body = await readJson(request);
    if (!body.ok) return body.res;
    const parsed = updateTileLineSchema.safeParse(body.value);
    if (!parsed.success) return error(400, 'invalid change', { issues: parsed.error.issues });
    const line = await inTransaction(pool, (c) => updateTileLine(c, id, parsed.data));
    return json({ line });
  } catch (e) {
    return writeError(e);
  }
}

export async function handleDeleteTileLine(
  request: Request,
  id: string,
  pool: pg.Pool,
): Promise<Response> {
  try {
    await requireRole(ROLE_FOR.editTileLines);
    if (!UUID_RE.test(id)) return error(404, 'no such tile line');
    const version = new URL(request.url).searchParams.get('version');
    if (!version) return error(400, 'give ?version= (the line as you last saw it)');
    await inTransaction(pool, (c) => deleteTileLine(c, id, version));
    return json({ ok: true });
  } catch (e) {
    return writeError(e);
  }
}
