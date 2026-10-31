/**
 * Shape conformance (1f decision 3, docs/contracts-1f.md §8; owner: sync-health): do the vendor
 * stand-in's replies have the shapes of the vendor's own (doc-derived fixtures, scrubbed
 * recordings)? A fixture says what a vendor sends; the stand-in is what sim mode and every
 * contract test run against; when the two drift, sim stops proving anything about the real API.
 *
 *   shapeOf(json)            every path with the JSON types seen there (`values[].links[].rel`:
 *                            string; arrays add `[]`, items merged)
 *   compareShapes(exp, act)  paths whose types disagree (`mismatched`, null fits anything), and
 *                            keys the expected shape has that the actual never sends (`missing`;
 *                            under an empty array nothing can be told, so nothing is reported)
 *   standInRequest(...)      the stand-in URL of a fixture exchange (the stand-in's mount, the
 *                            params a live client always sends, replay-only cursors dropped)
 *
 * The CI conformance test (./conformance.test.ts) runs both fixture kinds against the stand-in on
 * the demo world; `pnpm test:live` would run the recordings against the real API on the PC.
 */

import type { ReplayExchange, ReplayFixture } from './replay';
import { SAMSARA_STAT_TYPES } from './samsara/schemas';

export type JsonType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
export type Shape = Record<string, JsonType[]>;

function typeOf(v: unknown): JsonType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean' ? t : 'object';
}

/** Every path of a JSON value with the types seen there (array items merged under `[]`). */
export function shapeOf(json: unknown): Shape {
  const out = new Map<string, Set<JsonType>>();
  const walk = (v: unknown, p: string) => {
    const t = typeOf(v);
    let set = out.get(p);
    if (!set) {
      set = new Set();
      out.set(p, set);
    }
    set.add(t);
    if (t === 'array') for (const x of v as unknown[]) walk(x, `${p}[]`);
    else if (t === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>))
        walk(x, p ? `${p}.${k}` : k);
    }
  };
  walk(json, '');
  return Object.fromEntries([...out].map(([k, s]) => [k, [...s].sort()]));
}

/** Merge shapes (a fixture's several pages of one endpoint). */
export function mergeShapes(...shapes: Shape[]): Shape {
  const out: Record<string, Set<JsonType>> = {};
  for (const s of shapes) {
    for (const [p, ts] of Object.entries(s)) {
      out[p] ??= new Set();
      for (const t of ts) out[p].add(t);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, s]) => [k, [...s].sort()]));
}

export interface ShapeDiff {
  /** Paths the expected shape has, under a parent the actual has, that the actual never sends. */
  missing: string[];
  /** Paths whose types disagree (null fits anything). */
  mismatched: { path: string; expected: JsonType[]; actual: JsonType[] }[];
}

function parentOf(path: string): string {
  if (path.endsWith('[]')) return path.slice(0, -2);
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(0, i);
}

export function compareShapes(expected: Shape, actual: Shape): ShapeDiff {
  const missing: string[] = [];
  const mismatched: ShapeDiff['mismatched'] = [];
  for (const [path, exp] of Object.entries(expected)) {
    const act = actual[path];
    if (!act) {
      // An empty array has no items to tell from; a missing parent is reported on its own.
      if (path.endsWith('[]')) continue;
      const parent = actual[parentOf(path)];
      if (parent?.includes('object')) missing.push(path);
      continue;
    }
    const e = exp.filter((t) => t !== 'null');
    const a = act.filter((t) => t !== 'null');
    if (e.length && a.length && !e.some((t) => a.includes(t))) {
      mismatched.push({ path, expected: exp, actual: act });
    }
  }
  return { missing, mismatched };
}

/** Query parameters only replay knows (its cursors): never sent to the stand-in. */
const REPLAY_ONLY = new Set(['after']);

/**
 * The stand-in URL of a fixture exchange: the source's mount (`/deere/platform` for a fixture
 * with basePath '/platform', `/deere/isg/…` for the Equipment API, `/samsara/…`), the fixture's
 * query minus replay cursors, plus what the live client always sends (a breadcrumb window, the
 * stats feed's types).
 */
export function standInRequest(
  simUrl: string,
  fixture: Pick<ReplayFixture, 'source' | 'basePath'>,
  exchange: ReplayExchange,
  now: Date,
): URL {
  const base = simUrl.replace(/\/+$/, '');
  const p = exchange.request.path;
  const root =
    fixture.source === 'deere'
      ? p.startsWith('/isg/')
        ? `${base}/deere`
        : `${base}/deere${fixture.basePath ?? ''}`
      : `${base}/${fixture.source}`;
  const u = new URL(`${root}${p}`);
  for (const [k, v] of Object.entries(exchange.request.query ?? {})) {
    if (!REPLAY_ONLY.has(k) && !/^replay-/.test(v)) u.searchParams.set(k, v);
  }
  if (/\/breadcrumbs$/.test(p) && !u.searchParams.has('startDate')) {
    u.searchParams.set('startDate', new Date(now.getTime() - 15 * 60_000).toISOString());
    u.searchParams.set('endDate', now.toISOString());
  }
  if (p === '/fleet/vehicles/stats/feed' && !u.searchParams.has('types')) {
    u.searchParams.set('types', SAMSARA_STAT_TYPES.join(','));
  }
  return u;
}

/**
 * An endpoint's path with its ids replaced by `{}` (`/organizations/{}/fields`), so a recorded
 * exchange (ids hashed) finds the stand-in reply of the same endpoint. A segment is a word when
 * it is letters only (camelCase), else an id (digits, dashes, a uuid, a scrubbed hash).
 */
export function endpointTemplate(path: string): string {
  return path
    .split('/')
    .map((s) => (s === '' || (/^[a-z][A-Za-z]*$/.test(s) && !/^h[0-9a-f]{7,}$/.test(s)) ? s : '{}'))
    .join('/');
}

/** A tolerated difference: the stand-in leaves out a key the vendor sends, with the reason. */
export interface ToleratedGap {
  source: string;
  /** Endpoint templates it applies to (all when absent). */
  endpoints?: RegExp;
  /** The `missing` path (shapeOf notation). */
  path: string;
  why: string;
}

/**
 * Known gaps between the vendors' shapes and the stand-in (each one harmless to the clients and
 * reported to the integrator; a gap that closes simply stops matching).
 */
export const TOLERATED_GAPS: readonly ToleratedGap[] = [
  {
    source: 'deere',
    path: 'values[].links[].@type',
    why: "Deere's links carry '@type': 'Link'; the stand-in's carry rel and uri only (all the clients read)",
  },
  {
    source: 'deere',
    endpoints: /^\/organizations\/\{\}\/fields$/,
    path: 'values[].lastModifiedTime',
    why: "the core stand-in's minimal fields listing; deere-data's fields module serves the full shape",
  },
];

/** `diff.missing` minus the tolerated gaps of this source and endpoint. */
export function untoleratedMissing(
  source: string,
  endpoint: string,
  missing: readonly string[],
  gaps: readonly ToleratedGap[] = TOLERATED_GAPS,
): string[] {
  return missing.filter(
    (p) =>
      !gaps.some(
        (g) => g.source === source && g.path === p && (!g.endpoints || g.endpoints.test(endpoint)),
      ),
  );
}
