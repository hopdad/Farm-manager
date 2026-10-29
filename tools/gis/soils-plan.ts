/**
 * How `pnpm gis:soils` splits a survey area into SDA requests (pure; unit-tested). Owner: soils.
 *
 * SDA answers at most 100,000 rows and 32 MB of JSON per query, and a query that passes a limit
 * may come back empty or short rather than failing (./soils-sda.ts). So:
 *  - components go in mukey batches small enough to stay far below the row limit;
 *  - polygons go in mukey batches sized from the per-mukey polygon and vertex counts SDA reports
 *    first (WKT is about 40 bytes a vertex), with a budget well under the 32 MB limit;
 *  - a map unit too big for one reply on its own is read in pages (keyset on mupolygonkey);
 *  - when a reply has fewer polygons than counted (or fails), the batch is split in two and
 *    retried, down to one map unit, which then pages with ever smaller pages (`splitTask`).
 */
import { SDA_MAX_RESPONSE_BYTES, SDA_MAX_ROWS } from './soils-sda';

/** WKT text per vertex ("-83.987654321 41.987654321, " with SQL Server's precision). */
export const WKT_BYTES_PER_VERTEX = 40;
/** JSON row overhead per polygon (keys, quotes, POLYGON ((…)) wrapper). */
export const POLYGON_ROW_BYTES = 96;

export interface BatchLimits {
  /** Estimated reply bytes per polygon request. */
  maxBytes: number;
  /** Polygons per request. */
  maxRows: number;
  /** Map units per polygon request (keeps the IN list short). */
  maxMukeys: number;
  /** Map units per component request. */
  componentMukeys: number;
}

/** A quarter of SDA's size limit and a fifth of its row limit: room for estimate error. */
export const DEFAULT_LIMITS: BatchLimits = {
  maxBytes: Math.floor(SDA_MAX_RESPONSE_BYTES / 4),
  maxRows: Math.floor(SDA_MAX_ROWS / 5),
  maxMukeys: 400,
  componentMukeys: 250,
};

export interface MukeySize {
  mukey: string;
  polygons: number;
  vertices: number;
}

export type PolygonTask =
  /** All polygons of these map units in one reply. */
  | { kind: 'mukeys'; mukeys: string[]; polygons: number; bytes: number }
  /** One map unit read `pageSize` polygons at a time. */
  | { kind: 'paged'; mukey: string; polygons: number; bytes: number; pageSize: number };

export function estimateBytes(s: Pick<MukeySize, 'polygons' | 'vertices'>): number {
  return s.polygons * POLYGON_ROW_BYTES + s.vertices * WKT_BYTES_PER_VERTEX;
}

/** Numeric order for digit keys of any length. */
export function compareKeys(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function pageSizeFor(s: Pick<MukeySize, 'polygons' | 'vertices'>, limits: BatchLimits): number {
  const perPolygon = Math.max(1, estimateBytes(s) / Math.max(1, s.polygons));
  return Math.max(1, Math.min(limits.maxRows, Math.floor(limits.maxBytes / perPolygon)));
}

/** Greedy batches in mukey order; map units without polygons are skipped. */
export function planPolygonTasks(
  sizes: readonly MukeySize[],
  limits: BatchLimits = DEFAULT_LIMITS,
): PolygonTask[] {
  const tasks: PolygonTask[] = [];
  let cur: { mukeys: string[]; polygons: number; bytes: number } | null = null;
  const flush = () => {
    if (cur && cur.mukeys.length > 0) tasks.push({ kind: 'mukeys', ...cur });
    cur = null;
  };
  for (const s of [...sizes].sort((a, b) => compareKeys(a.mukey, b.mukey))) {
    if (s.polygons <= 0) continue;
    const bytes = estimateBytes(s);
    if (bytes > limits.maxBytes || s.polygons > limits.maxRows) {
      flush();
      tasks.push({
        kind: 'paged',
        mukey: s.mukey,
        polygons: s.polygons,
        bytes,
        pageSize: pageSizeFor(s, limits),
      });
      continue;
    }
    const c: { mukeys: string[]; polygons: number; bytes: number } = cur ?? {
      mukeys: [],
      polygons: 0,
      bytes: 0,
    };
    if (
      c.mukeys.length > 0 &&
      (c.bytes + bytes > limits.maxBytes ||
        c.polygons + s.polygons > limits.maxRows ||
        c.mukeys.length >= limits.maxMukeys)
    ) {
      flush();
      cur = { mukeys: [s.mukey], polygons: s.polygons, bytes };
    } else {
      c.mukeys.push(s.mukey);
      c.polygons += s.polygons;
      c.bytes += bytes;
      cur = c;
    }
  }
  flush();
  return tasks;
}

/**
 * A smaller version of a task whose reply failed or came back short: two halves of a batch; a
 * single map unit becomes paged at half its count; a paged task halves its page. Null when it
 * can't get any smaller (one polygon per page).
 */
export function splitTask(
  task: PolygonTask,
  sizes: ReadonlyMap<string, MukeySize>,
): PolygonTask[] | null {
  if (task.kind === 'paged') {
    if (task.pageSize <= 1) return null;
    return [{ ...task, pageSize: Math.max(1, Math.floor(task.pageSize / 2)) }];
  }
  if (task.mukeys.length === 1) {
    const mukey = task.mukeys[0] as string;
    return [
      {
        kind: 'paged',
        mukey,
        polygons: task.polygons,
        bytes: task.bytes,
        pageSize: Math.max(1, Math.ceil(task.polygons / 2)),
      },
    ];
  }
  const mid = Math.ceil(task.mukeys.length / 2);
  return [task.mukeys.slice(0, mid), task.mukeys.slice(mid)].map((mukeys) => {
    let polygons = 0;
    let bytes = 0;
    for (const k of mukeys) {
      const s = sizes.get(k);
      polygons += s?.polygons ?? 0;
      bytes += s ? estimateBytes(s) : 0;
    }
    return { kind: 'mukeys' as const, mukeys, polygons, bytes };
  });
}

/** Map units in groups of `size` (component requests), in mukey order. */
export function chunkKeys(keys: readonly string[], size: number): string[][] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const sorted = [...keys].sort(compareKeys);
  const out: string[][] = [];
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
  return out;
}
