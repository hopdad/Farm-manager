/**
 * The HTTP layer every vendor client uses (sim mode = the same code against the stand-in).
 *
 *  - Per-attempt timeout plus the job's AbortSignal (ctx.signal aborts at the deadline).
 *  - Retries: network errors, timeouts and 5xx back off briefly (250 ms, 500 ms …); 429/503
 *    with a short `Retry-After` (<= maxInlineRetryAfterSeconds) wait it out in-process;
 *    a longer one is thrown as `VendorHttpError.retryAfterSeconds`, which runSyncStep turns into
 *    the stream's next_run_at (contracts §8 `retryAfterFrom`). No retry may cross the deadline.
 *  - Errors carry the vendor, status and request PATH only (never tokens or query strings).
 *  - `vendorJson()` validates the body with the shared zod schema (stand-in and real alike).
 *  - `onCall` (1f): one `VendorCall` per attempt sent (retries count), for the per-source call
 *    counts and the call budget (ingest.api_calls_daily, decision 4). The default does nothing;
 *    a hook that throws is ignored (counting never fails a vendor call).
 *  - `withCallStream(stream, fn)` (1f fix): label every call made inside `fn` with a stream
 *    (`VendorCall.stream`), for calls made OUTSIDE a sync step: the CLIs (`connectors:record` →
 *    'record'; the deferred `deere:backfill` → 'backfill') and anything else that isn't
 *    runSyncStep.
 *    sync-health's counter counts those under that stream and flushes them when `fn` settles
 *    (inside a step, the step's stream wins). Frozen export (docs/contracts-1f.md §5.0).
 *
 * The call counter (sync-health, docs/contracts-1f.md §5.5): every attempt is also added to the
 * ambient `CallTally` of the scope it runs in, with no client or job changes:
 *  - inside `runSyncStep` (`withCallTally(tally, spec.stream, …)`): the step's tally, flushed by
 *    the step into ingest.api_calls_daily under its source, stream and mode;
 *  - inside `withCallStream(stream, fn)`: a tally of its own, handed to the installed
 *    `CallTallySink` when `fn` settles (`installCallCounting`, src/connectors/call-budget.ts:
 *    the CLIs install it before they start; with none installed the tally is dropped, so unit
 *    tests never need a database);
 *  - anywhere else: not counted (no scope).
 * The UTC day of a call is the client's clock (`VendorHttpOptions.now`, the job's clock).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { z } from 'zod';

/** One HTTP attempt sent to a vendor (what the call counter sees). */
export interface VendorCall {
  vendor: string;
  method: string;
  /** Request path only (no host, no query string: cursors and codes stay out). */
  path: string;
  /** HTTP status; null when no answer came (network error, timeout, abort). */
  status: number | null;
  /** ok = 2xx (or 3xx with redirect 'manual'); rate_limited = 429; error = anything else. */
  outcome: 'ok' | 'rate_limited' | 'error';
  /** 0 for the first attempt, 1 for the first retry, … */
  attempt: number;
  /** Wall time of the attempt. */
  ms: number;
  /** The `withCallStream` label the call was made under, or null (none, or inside a step). */
  stream: string | null;
}

/** Calls of one vendor under one stream on one UTC day (what ingest.api_calls_daily adds up). */
export interface CallTallyRow {
  vendor: string;
  stream: string;
  /** UTC day of the calls, 'YYYY-MM-DD'. */
  day: string;
  /** Every attempt, retries included. */
  calls: number;
  /** Non-2xx answers other than 429, and attempts with no answer. */
  errors: number;
  /** 429s. */
  rateLimited: number;
}

/** An in-memory count of vendor calls (one per attempt), keyed by vendor, stream and UTC day. */
export class CallTally {
  private readonly rowsByKey = new Map<string, CallTallyRow>();

  /** Count one attempt under `stream`, on the UTC day of `at`. */
  add(call: Pick<VendorCall, 'vendor' | 'outcome'>, stream: string, at: Date): void {
    const day = Number.isNaN(at.getTime())
      ? new Date().toISOString().slice(0, 10)
      : at.toISOString().slice(0, 10);
    const key = `${call.vendor}\u0000${stream}\u0000${day}`;
    let row = this.rowsByKey.get(key);
    if (!row) {
      row = { vendor: call.vendor, stream, day, calls: 0, errors: 0, rateLimited: 0 };
      this.rowsByKey.set(key, row);
    }
    row.calls++;
    if (call.outcome === 'error') row.errors++;
    else if (call.outcome === 'rate_limited') row.rateLimited++;
  }

  /** Attempts counted so far. */
  get total(): number {
    let n = 0;
    for (const r of this.rowsByKey.values()) n += r.calls;
    return n;
  }

  /** A copy of the rows. */
  rows(): CallTallyRow[] {
    return [...this.rowsByKey.values()].map((r) => ({ ...r }));
  }

  /** The rows, leaving the tally empty (a flush). */
  drain(): CallTallyRow[] {
    const out = this.rows();
    this.rowsByKey.clear();
    return out;
  }
}

/** Where `withCallStream`'s tally goes when `fn` settles (sync-health: ingest.api_calls_daily). */
export type CallTallySink = (rows: CallTallyRow[]) => Promise<void>;

let callTallySink: CallTallySink | null = null;

/**
 * Install (or with null, remove) the sink `withCallStream` flushes into; returns the previous
 * one. `installCallCounting` (src/connectors/call-budget.ts) is the app's: the CLIs call it.
 */
export function setCallTallySink(sink: CallTallySink | null): CallTallySink | null {
  const previous = callTallySink;
  callTallySink = sink;
  return previous;
}

interface CallScope {
  /** The `withCallStream` label (VendorCall.stream); null inside a sync step. */
  label: string | null;
  /** Where attempts are counted, and under which stream. */
  tally: CallTally;
  tallyStream: string;
}

const callScope = new AsyncLocalStorage<CallScope>();

async function flushTally(tally: CallTally, sink: CallTallySink | null): Promise<void> {
  if (!sink || tally.total === 0) return;
  const rows = tally.drain();
  try {
    await sink(rows);
  } catch (e) {
    // Counting never fails the work it counts.
    console.warn(`[http] call counts not saved: ${(e as Error).message}`);
  }
}

/**
 * Run `fn` with every vendor call inside it labelled `stream` (the CLIs: 'backfill', 'record').
 * Nests: the innermost label wins. sync-health counts the calls under that stream and hands them
 * to the installed sink (`installCallCounting`) when `fn` settles (docs/contracts-1f.md §5.5);
 * a sync step inside `fn` counts its own calls under its own stream.
 */
export function withCallStream<T>(stream: string, fn: () => Promise<T>): Promise<T> {
  const tally = new CallTally();
  return callScope.run({ label: stream, tally, tallyStream: stream }, async () => {
    try {
      return await fn();
    } finally {
      await flushTally(tally, callTallySink);
    }
  });
}

/**
 * Run `fn` with every vendor call inside it counted in `tally` under `stream`, unlabelled
 * (`VendorCall.stream` null): runSyncStep's scope. The caller flushes the tally.
 */
export function withCallTally<T>(
  tally: CallTally,
  stream: string,
  fn: () => Promise<T>,
): Promise<T> {
  return callScope.run({ label: null, tally, tallyStream: stream }, fn);
}

/** The current `withCallStream` label, or null (none, or inside a sync step). */
export function currentCallStream(): string | null {
  return callScope.getStore()?.label ?? null;
}

/** Called once per attempt; must not throw (a throw is caught and ignored) and must be cheap. */
export type VendorCallHook = (call: VendorCall) => void;

/** The default hook: counts nothing. */
export const noopVendorCallHook: VendorCallHook = () => {};

export interface VendorHttpOptions {
  /** 'samsara', 'deere', … (error messages, logs). */
  vendor: string;
  /** The job's signal: aborting stops the request and any retry wait. */
  signal?: AbortSignal;
  /** No retry wait may end after this (default: none). */
  deadline?: Date;
  now?: () => Date;
  /** Per attempt. Default 15 000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** Wait out a Retry-After up to this many seconds in-process. Default 2. */
  maxInlineRetryAfterSeconds?: number;
  /** First backoff for network errors / 5xx. Default 250 ms (doubles). */
  baseBackoffMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Call counter (1f): one call per attempt. Default `noopVendorCallHook`. */
  onCall?: VendorCallHook;
}

/** A non-2xx answer. `retryAfterSeconds` is set from a 429/503 Retry-After header. */
export class VendorHttpError extends Error {
  readonly vendor: string;
  readonly status: number;
  readonly path: string;
  readonly retryAfterSeconds?: number;
  /** Short vendor message from the body (message / error_description / errors[0].message). */
  readonly detail?: string;
  /** OAuth `error` code from the body (invalid_grant, …) when present. */
  readonly oauthError?: string;
  /**
   * The few response headers that explain a refusal (KEPT_ERROR_HEADERS, lower-case names):
   * Deere's `x-deere-terms-location` (terms to accept, not an approval), `www-authenticate`
   * (CNH's APIM names the missing subscription key there).
   */
  readonly headers?: Readonly<Record<string, string>>;
  constructor(init: {
    vendor: string;
    status: number;
    path: string;
    retryAfterSeconds?: number;
    detail?: string;
    oauthError?: string;
    headers?: Readonly<Record<string, string>>;
  }) {
    super(
      `${init.vendor} ${init.path}: HTTP ${init.status}${init.detail ? ` (${init.detail})` : ''}`,
    );
    this.name = 'VendorHttpError';
    this.vendor = init.vendor;
    this.status = init.status;
    this.path = init.path;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.detail = init.detail;
    this.oauthError = init.oauthError;
    if (init.headers && Object.keys(init.headers).length) this.headers = init.headers;
  }
}

/** Response headers a VendorHttpError keeps (no tokens or cookies are ever among them). */
export const KEPT_ERROR_HEADERS = ['x-deere-terms-location', 'www-authenticate'] as const;

function keptHeaders(h: Headers): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const k of KEPT_ERROR_HEADERS) {
    const v = h.get(k);
    if (v) out[k] = v.length > 500 ? v.slice(0, 500) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The vendor couldn't be reached (connection refused/reset, DNS, timeout). */
export class VendorNetworkError extends Error {
  readonly vendor: string;
  readonly path: string;
  constructor(vendor: string, path: string, reason: string, options?: { cause?: unknown }) {
    super(`${vendor} ${path}: ${reason}`, options);
    this.name = 'VendorNetworkError';
    this.vendor = vendor;
    this.path = path;
  }
}

/** The body didn't match the schema (the vendor changed, or the stand-in is wrong). */
export class VendorResponseError extends Error {
  readonly vendor: string;
  readonly path: string;
  constructor(vendor: string, path: string, reason: string) {
    super(`${vendor} ${path}: unexpected response (${reason})`);
    this.name = 'VendorResponseError';
    this.vendor = vendor;
    this.path = path;
  }
}

/**
 * Retry-After: delta-seconds or an HTTP-date → whole seconds from `now` (undefined if
 * absent/bad). Fractional delta-seconds round up: Samsara sends `0.40235` and Terminal `0.62`
 * (their rate-limit docs), and `Date.parse('1.5')` would otherwise read a date in 2001.
 */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.ceil(Number(v));
  if (/^[\d.]+$/.test(v)) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.ceil((t - now.getTime()) / 1000));
}

/** A short, secret-free message from an error body. */
export function errorDetail(body: string): { detail?: string; oauthError?: string } {
  const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 197)}...` : s);
  try {
    const parsed = JSON.parse(body) as unknown;
    // Deere's Equipment API answers a bare array of errors ([{ code, message, … }]).
    const j = (Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return {};
    const errors = j.errors as { message?: unknown }[] | undefined;
    const msg =
      (typeof j.error_description === 'string' && j.error_description) ||
      (typeof j.message === 'string' && j.message) ||
      (typeof j.error_message === 'string' && j.error_message) ||
      (Array.isArray(errors) && typeof errors[0]?.message === 'string' && errors[0].message) ||
      (typeof j.error === 'string' && j.error) ||
      undefined;
    return {
      detail: msg ? clip(msg) : undefined,
      oauthError: typeof j.error === 'string' ? j.error : undefined,
    };
  } catch {
    return {};
  }
}

/** Path of a URL for messages (no host, no query: cursors and codes stay out of logs). */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '(bad url)';
  }
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

/**
 * fetch with timeouts and retries. Returns the response when it is 2xx (or 3xx with
 * `redirect: 'manual'`); throws VendorHttpError for other statuses, VendorNetworkError when
 * unreachable, and the signal's reason when the caller aborted.
 */
export async function vendorFetch(
  url: string,
  init: RequestInit,
  opts: VendorHttpOptions,
): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRetries = opts.maxRetries ?? 2;
  const inlineMax = opts.maxInlineRetryAfterSeconds ?? 2;
  const backoff = opts.baseBackoffMs ?? 250;
  const path = pathOf(url);
  const onCall = opts.onCall ?? noopVendorCallHook;
  const method = (init.method ?? 'GET').toUpperCase();
  const count = (attempt: number, startedAt: number, status: number | null, ok: boolean) => {
    const scope = callScope.getStore();
    const call: VendorCall = {
      vendor: opts.vendor,
      method,
      path,
      status,
      outcome: ok ? 'ok' : status === 429 ? 'rate_limited' : 'error',
      attempt,
      ms: Math.max(0, Date.now() - startedAt),
      stream: scope?.label ?? null,
    };
    try {
      onCall(call);
    } catch {
      // Counting never fails a vendor call.
    }
    try {
      scope?.tally.add(call, scope.tallyStream, now());
    } catch {
      // Nor does the ambient counter.
    }
  };

  /** Can we wait `ms` and still finish before the deadline? */
  const fits = (ms: number) =>
    !opts.deadline || now().getTime() + ms + 1_000 < opts.deadline.getTime();

  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    const startedAt = Date.now();
    try {
      res = await doFetch(url, { ...init, signal });
    } catch (e) {
      count(attempt, startedAt, null, false);
      if (opts.signal?.aborted) throw opts.signal.reason ?? e;
      const reason = timeout.aborted
        ? `timed out after ${timeoutMs} ms`
        : `unreachable (${(e as Error & { cause?: { code?: string } }).cause?.code ?? (e as Error).message})`;
      const wait = backoff * 2 ** attempt;
      if (attempt < maxRetries && fits(wait)) {
        await sleep(wait, opts.signal);
        continue;
      }
      throw new VendorNetworkError(opts.vendor, path, reason, { cause: e });
    }
    const passed = res.ok || (init.redirect === 'manual' && res.status >= 300 && res.status < 400);
    count(attempt, startedAt, res.status, passed);
    if (passed) return res;
    const body = await res.text().catch(() => '');
    const retryAfter =
      res.status === 429 || res.status === 503
        ? parseRetryAfter(res.headers.get('retry-after'), now())
        : undefined;
    if (attempt < maxRetries) {
      if (retryAfter !== undefined && retryAfter <= inlineMax && fits(retryAfter * 1000)) {
        await sleep(retryAfter * 1000, opts.signal);
        continue;
      }
      if (retryAfter === undefined && RETRYABLE_STATUS.has(res.status)) {
        const wait = backoff * 2 ** attempt;
        if (fits(wait)) {
          await sleep(wait, opts.signal);
          continue;
        }
      }
    }
    throw new VendorHttpError({
      vendor: opts.vendor,
      status: res.status,
      path,
      retryAfterSeconds: retryAfter,
      ...errorDetail(body),
      headers: keptHeaders(res.headers),
    });
  }
}

/** vendorFetch + JSON + zod validation of the body. */
export async function vendorJson<S extends z.ZodType>(
  schema: S,
  url: string,
  init: RequestInit,
  opts: VendorHttpOptions,
): Promise<z.infer<S>> {
  const res = await vendorFetch(url, init, opts);
  const text = await res.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new VendorResponseError(opts.vendor, pathOf(url), 'body is not JSON');
  }
  const r = schema.safeParse(value);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new VendorResponseError(
      opts.vendor,
      pathOf(url),
      i ? `${i.path.join('.') || '(root)'}: ${i.message}` : 'schema mismatch',
    );
  }
  return r.data;
}
