/**
 * HTTP for the GIS tools: fetch with a timeout and a few retries (network errors, 429, 5xx),
 * and streaming downloads to a file. Node's global fetch; behind a proxy run with
 * NODE_USE_ENV_PROXY=1 (Node 24 then honours HTTPS_PROXY).
 */
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  retries?: number;
  timeoutMs?: number;
  /** Base backoff in ms (doubles per attempt). */
  backoffMs?: number;
  fetch?: FetchLike;
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `GET ${url} → HTTP ${status}`);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 429 || status >= 500;

/** fetch(url) with retries; resolves with the first non-retryable response (any status). */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const doFetch = opts.fetch ?? fetch;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep((opts.backoffMs ?? 500) * 2 ** (attempt - 1));
    try {
      const res = await doFetch(url, {
        ...init,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (!retryable(res.status) || attempt === retries) return res;
      lastError = new HttpError(url, res.status);
      await res.body?.cancel();
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`GET ${url} failed: ${describeError(lastError)}`);
}

/** Download url to dest (streamed). Throws HttpError for a non-2xx status; removes partial files. */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: RetryOptions = {},
): Promise<number> {
  const res = await fetchWithRetry(url, {}, opts);
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new HttpError(url, res.status);
  }
  let bytes = 0;
  const counted = Readable.fromWeb(res.body as never).on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  try {
    await pipeline(counted, createWriteStream(dest));
  } catch (e) {
    await rm(dest, { force: true });
    throw e;
  }
  return bytes;
}

/** A readable reason, including undici's `cause` (ECONNREFUSED, proxy 403, TLS…). */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as Error & { cause?: unknown }).cause;
  const c = cause instanceof Error ? `: ${cause.message}` : cause ? `: ${String(cause)}` : '';
  return `${e.message}${c}`;
}
