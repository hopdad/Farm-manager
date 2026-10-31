/**
 * Replay mode (CONNECTOR_<X>=replay, plan §5; docs/contracts-m1.md §10): the LIVE client runs
 * against recorded or doc-derived fixtures instead of the network, so the HTTP client, paging,
 * the zod schemas and the mappers are all exercised offline and before any vendor account
 * exists. Only the transport changes: the client gets `createReplayFetch(fixtures)` as its
 * `fetch` (VendorHttpOptions.fetch) and a base URL under `REPLAY_ORIGIN`. OAuth is skipped in
 * replay (there is no token endpoint to talk to): the source's replay wiring gives the client a
 * fixed token.
 *
 * FIXTURE LAYOUT (one JSON file = one `ReplayFixture`, validated by `replayFixtureSchema`):
 *
 *   src/connectors/<source>/fixtures/doc-derived/<stream>/<nn>-<name>.json
 *       hand-written from the vendor's PUBLIC API reference; `reference` cites the page(s);
 *       paths and shapes not confirmed by a real response are also listed in
 *       src/connectors/doc-derived.ts ("doc-derived, confirm")
 *   src/connectors/<source>/fixtures/recorded/<stream>/<nn>-<name>.json
 *       `pnpm connectors:record` output (1f): real responses, secrets and tokens scrubbed
 *
 *   src/connectors/<source>/replay.ts imports them STATICALLY (JSON imports ship in the build)
 *   and exports `<source>ReplayFixtures: ReplayFixture[]`, recorded first: for the same request
 *   a recorded exchange wins over a doc-derived one. Fixtures hold no real farm data.
 *
 * MATCHING: the transport never touches the network, whatever host a URL names (doc-derived
 * `nextPage` links can keep the vendor's real host). A request matches an exchange when the
 * method is equal, the URL path (minus the fixture's `basePath`, if it starts with it) equals
 * `request.path`, every key in `request.query` has that exact value (other query parameters,
 * such as cursors and time windows, are ignored), and, when the exchange names a
 * `request.body`, the request's JSON body contains it (1f.2: JSON-RPC APIs such as MyGeotab
 * post every call to one path, told apart only by `method` and `params.typeName`; objects match
 * as a subset, arrays and values whole). First match wins; none -> 404
 * `{ message: 'replay: no fixture for …' }`. Bodies are JSON only: an XML API (ISO 15143-3) is
 * exercised through its stand-in and its parser's unit tests, not replay.
 *
 * TIME-SHIFTING RULE: a fixture was written for one instant, its `anchor`. Replayed at wall
 * time `now`, every instant in the response body moves by
 *     delta = floor((now - anchor) / step) * step,   step = shiftStepSeconds (default 60 s)
 * so the newest data is as old relative to now as it was relative to the anchor, and replays
 * within one step are byte-identical (raw_events dedupe by sha256 holds). What moves:
 *  - every string that is an RFC 3339 date-time (`2026-11-30T13:00:00Z`, `…+00:00`, with or
 *    without fractional seconds), anywhere in the body, keeping its offset and precision;
 *  - the start of an ISO 8601 interval (`2026-11-30T13:00:00+00:00/PT1H`, NWS `validTime`);
 *  - numbers under the property names in `epochMsKeys` (epoch milliseconds).
 * Date-only strings (`2026-11-30`) and everything else stay as written. Request query values
 * are never shifted.
 */
import { z } from 'zod';
import type { ConnectorSource } from './types';

/** Base origin of every replay-mode client (RFC 2606 `.invalid`: can never resolve). */
export const REPLAY_ORIGIN = 'https://replay.invalid';

/** `https://replay.invalid/<source>`: the base URL a replay-mode client uses. */
export function replayBaseUrl(source: ConnectorSource): string {
  return `${REPLAY_ORIGIN}/${source}`;
}

export interface ReplayExchange {
  request: {
    method: 'GET' | 'POST';
    /** Path below the client's base URL, e.g. '/fleet/vehicles/locations/feed'. */
    path: string;
    /** Query parameters that must match exactly (others are ignored). */
    query?: Record<string, string>;
    /**
     * A subset the request's JSON body must contain (objects by key, arrays and values whole),
     * e.g. MyGeotab `{ method: 'GetFeed', params: { typeName: 'LogRecord' } }`.
     */
    body?: Record<string, unknown>;
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    /** JSON body (serialized by the transport). */
    body: unknown;
  };
}

export interface ReplayFixture {
  format: 1;
  source: ConnectorSource;
  /** Stream it feeds, e.g. 'locations', 'fields', 'forecast'. */
  stream: string;
  kind: 'doc-derived' | 'recorded';
  /** Where the shapes come from: doc URL(s), or 'connectors:record <date>'. */
  reference: string;
  /** The instant the fixture treats as "now" (RFC 3339). */
  anchor: string;
  /** Default 60. */
  shiftStepSeconds?: number;
  /** Stripped from request paths before matching (e.g. a vendor's '/platform' prefix). */
  basePath?: string;
  /** Property names whose numeric values are epoch milliseconds (shifted too). */
  epochMsKeys?: string[];
  exchanges: ReplayExchange[];
}

const rfc3339 = z.iso.datetime({ offset: true });

export const replayFixtureSchema = z.strictObject({
  format: z.literal(1),
  source: z.enum([
    'deere',
    'samsara',
    'motive',
    'nws',
    'qbo',
    'bushel',
    'drone',
    'geotab',
    'aemp',
    'terminal',
  ]),
  stream: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  kind: z.enum(['doc-derived', 'recorded']),
  reference: z.string().min(1),
  anchor: rfc3339,
  shiftStepSeconds: z.number().int().positive().max(86_400).optional(),
  basePath: z.string().startsWith('/').optional(),
  epochMsKeys: z.array(z.string().min(1)).optional(),
  exchanges: z
    .array(
      z.strictObject({
        request: z.strictObject({
          method: z.enum(['GET', 'POST']),
          path: z.string().startsWith('/'),
          query: z.record(z.string(), z.string()).optional(),
          body: z.record(z.string(), z.unknown()).optional(),
        }),
        response: z.strictObject({
          status: z.number().int().min(100).max(599),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.unknown(),
        }),
      }),
    )
    .min(1),
}) satisfies z.ZodType<ReplayFixture>;

// ---------------------------------------------------------------------------------------------
// Time shifting
// ---------------------------------------------------------------------------------------------

/** delta (ms) for a fixture replayed at `now` (see the rule above). */
export function replayDeltaMs(
  fixture: Pick<ReplayFixture, 'anchor' | 'shiftStepSeconds'>,
  now: Date,
): number {
  const step = (fixture.shiftStepSeconds ?? 60) * 1000;
  const raw = now.getTime() - Date.parse(fixture.anchor);
  return Math.floor(raw / step) * step;
}

const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})(\/P[0-9A-Z.]+)?$/;

/** Shift one RFC 3339 date-time (or interval start) string by `deltaMs`; other strings unchanged. */
export function shiftInstantString(value: string, deltaMs: number): string {
  const m = DATE_TIME_RE.exec(value);
  if (!m || deltaMs === 0) return value;
  const [, , , , , , sec, frac = '', zone = 'Z', interval = ''] = m;
  const t = Date.parse(value.slice(0, value.length - interval.length));
  if (Number.isNaN(t)) return value;
  const offsetMin = zone === 'Z' ? 0 : offsetMinutes(zone);
  const local = new Date(t + deltaMs + offsetMin * 60_000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const hm = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  // Keep the original precision: seconds only if it had them (or the shift needs them), and
  // the fraction unchanged when the shift is whole seconds (replayDeltaMs always is).
  const s = local.getUTCSeconds();
  const seconds = sec === undefined && s === 0 ? '' : `:${pad(s)}`;
  let fraction = frac;
  if (frac && deltaMs % 1000 !== 0) {
    const digits = frac.length - 1;
    fraction = `.${String(local.getUTCMilliseconds()).padStart(3, '0').padEnd(digits, '0').slice(0, digits)}`;
  }
  return `${date}T${hm}${seconds}${fraction}${zone}${interval}`;
}

function offsetMinutes(zone: string): number {
  const sign = zone.startsWith('-') ? -1 : 1;
  const [h, m] = zone.slice(1).split(':').map(Number);
  return sign * ((h ?? 0) * 60 + (m ?? 0));
}

/** A deep copy of `body` with every instant shifted by `deltaMs` (see the rule above). */
export function shiftInstants(
  body: unknown,
  deltaMs: number,
  epochMsKeys: readonly string[] = [],
): unknown {
  if (deltaMs === 0) return structuredClone(body);
  const epochKeys = new Set(epochMsKeys);
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === 'string') return shiftInstantString(v, deltaMs);
    if (typeof v === 'number' && key !== null && epochKeys.has(key)) return v + deltaMs;
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return walk(body, null);
}

// ---------------------------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------------------------

export interface ReplayFetchOptions {
  /** Wall clock (default: new Date()). */
  now?: () => Date;
}

async function requestParts(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let text: string | null = null;
  if (typeof init?.body === 'string') text = init.body;
  else if (init?.body instanceof URLSearchParams) text = init.body.toString();
  else if (input instanceof Request && method !== 'GET') text = await input.clone().text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined; // not JSON: only exchanges that name no body match
    }
  }
  return { url, method, body };
}

/** Does `got` contain `want` (objects by key, recursively; arrays and values whole)? */
export function containsJson(got: unknown, want: unknown): boolean {
  if (want && typeof want === 'object' && !Array.isArray(want)) {
    if (!got || typeof got !== 'object' || Array.isArray(got)) return false;
    const g = got as Record<string, unknown>;
    return Object.entries(want).every(([k, v]) => containsJson(g[k], v));
  }
  return JSON.stringify(got) === JSON.stringify(want);
}

/** Find the first exchange that answers `method url` (and `body`, see MATCHING above). */
export function matchExchange(
  fixtures: readonly ReplayFixture[],
  method: string,
  url: URL,
  body?: unknown,
): { fixture: ReplayFixture; exchange: ReplayExchange } | null {
  for (const fixture of fixtures) {
    let path = url.pathname;
    const sourcePrefix = `/${fixture.source}`;
    if (url.origin === REPLAY_ORIGIN && path.startsWith(`${sourcePrefix}/`)) {
      path = path.slice(sourcePrefix.length);
    }
    if (fixture.basePath && path.startsWith(`${fixture.basePath}/`)) {
      path = path.slice(fixture.basePath.length);
    }
    for (const exchange of fixture.exchanges) {
      const r = exchange.request;
      if (r.method !== method || r.path !== path) continue;
      const q = r.query ?? {};
      if (!Object.entries(q).every(([k, v]) => url.searchParams.get(k) === v)) continue;
      if (r.body && !containsJson(body, r.body)) continue;
      return { fixture, exchange };
    }
  }
  return null;
}

/**
 * A `fetch` that answers from fixtures (and never touches the network). Pass it as the vendor
 * client's `fetch` in replay mode.
 */
export function createReplayFetch(
  fixtures: readonly ReplayFixture[],
  opts: ReplayFetchOptions = {},
): typeof fetch {
  const now = opts.now ?? (() => new Date());
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { url, method, body: sent } = await requestParts(input, init);
    const hit = matchExchange(fixtures, method, url, sent);
    if (!hit) {
      return Response.json(
        { message: `replay: no fixture for ${method} ${url.pathname}` },
        { status: 404 },
      );
    }
    const { fixture, exchange } = hit;
    const body = shiftInstants(
      exchange.response.body,
      replayDeltaMs(fixture, now()),
      fixture.epochMsKeys,
    );
    return Response.json(body, {
      status: exchange.response.status,
      headers: { 'content-type': 'application/json', ...(exchange.response.headers ?? {}) },
    });
  };
}
