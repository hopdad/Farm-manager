/**
 * Production limits, applied on the PC (plan §1 "Production limits apply locally"): Vercel
 * fails a function response over 4.5 MB, so outside production every non-streamed API response
 * goes through limitedJson / limitedBytes, and one over MAX_API_RESPONSE_BYTES becomes a 500
 * (logged with the route) instead of passing every local check and failing only on Vercel. Big
 * data is paged or streamed instead (track replay per machine-hour, exports paged).
 * In production they pass through (Vercel enforces its own limit).
 *
 * Streaming routes (/api/storage, /api/realtime) are exempt; src/seams.test.ts checks that every
 * other route handler uses these helpers.
 */
import { tryGetConfig } from '../../config';

/** 4 MiB: under Vercel's 4.5 MB response limit, with room for headers. */
export const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface ResponseLimitOptions {
  /** Shown in the log line (e.g. 'api/fleet'). */
  route?: string;
  /** Default: on unless APP_ENV=production (or the config can't load). */
  enforce?: boolean;
  /** Default MAX_API_RESPONSE_BYTES. */
  limit?: number;
}

function enforced(opts: ResponseLimitOptions): boolean {
  if (opts.enforce !== undefined) return opts.enforce;
  const r = tryGetConfig();
  return !(r.ok && r.config.isProduction);
}

function tooLarge(bytes: number, limit: number, opts: ResponseLimitOptions): Response {
  console.error(
    `[${opts.route ?? 'api'}] response of ${bytes} bytes is over the ${limit}-byte limit (Vercel fails responses over 4.5 MB): page or stream it`,
  );
  return Response.json(
    { error: 'response over 4 MB (Vercel limit 4.5 MB): page or stream it' },
    { status: 500, headers: { 'cache-control': 'no-store' } },
  );
}

/** Response.json with the size guard. */
export function limitedJson(
  body: unknown,
  init: ResponseInit = {},
  opts: ResponseLimitOptions = {},
): Response {
  const text = JSON.stringify(body);
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return limitedBytes(text, { ...init, headers }, opts);
}

/** new Response(body) with the size guard (bytes, or text measured as UTF-8). */
export function limitedBytes(
  body: Uint8Array | string,
  init: ResponseInit = {},
  opts: ResponseLimitOptions = {},
): Response {
  const limit = opts.limit ?? MAX_API_RESPONSE_BYTES;
  const bytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
  if (bytes > limit && enforced(opts)) return tooLarge(bytes, limit, opts);
  return new Response(body as BodyInit, init);
}
