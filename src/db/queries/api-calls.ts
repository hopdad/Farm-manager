/**
 * Vendor call counts (1f decision 4, docs/contracts-1f.md §3.1 and §5.5; owner: sync-health):
 * ingest.api_calls_daily (calls, errors and 429s per source, stream, connector mode and UTC day)
 * and each stream's measured calls per run in ingest.sync_state.extra (`callsPerRun`, merged,
 * never replacing the object).
 *
 * The budget math reads sandbox/live rows only (src/connectors/call-budget.ts): a day of sim or
 * replay never counts against a real budget.
 */
import { COUNTED_MODES, type CountedMode, type Mode } from '../../connectors/types';
import { type Executor, exec } from '../exec';

/** One upsert into ingest.api_calls_daily (the counts are added to the day's row). */
export interface ApiCallRow {
  source: string;
  stream: string;
  mode: CountedMode;
  /** UTC day 'YYYY-MM-DD'. */
  day: string;
  calls: number;
  errors: number;
  rateLimited: number;
}

export function isCountedMode(m: string | null | undefined): m is CountedMode {
  return (COUNTED_MODES as readonly string[]).includes(m ?? '');
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Add `rows` to ingest.api_calls_daily in one statement (`on conflict … do update set calls =
 * calls + excluded.calls, …`). Rows with nothing to add, an uncounted mode or a bad day are
 * dropped; equal keys are summed first (one row per key in the statement).
 */
export async function upsertApiCalls(ex: Executor, rows: readonly ApiCallRow[]): Promise<number> {
  const merged = new Map<string, ApiCallRow>();
  for (const r of rows) {
    if (!isCountedMode(r.mode) || !DAY_RE.test(r.day) || !r.source) continue;
    const calls = Math.max(0, Math.trunc(r.calls));
    if (calls === 0) continue;
    const key = `${r.source}\u0000${r.stream}\u0000${r.mode}\u0000${r.day}`;
    const cur = merged.get(key) ?? { ...r, calls: 0, errors: 0, rateLimited: 0 };
    cur.calls += calls;
    cur.errors += Math.max(0, Math.trunc(r.errors));
    cur.rateLimited += Math.max(0, Math.trunc(r.rateLimited));
    merged.set(key, cur);
  }
  if (merged.size === 0) return 0;
  const payload = [...merged.values()].map((r) => ({
    s: r.source,
    t: r.stream,
    m: r.mode,
    d: r.day,
    c: r.calls,
    e: r.errors,
    r: r.rateLimited,
  }));
  const res = await exec(
    ex,
    `insert into ingest.api_calls_daily (source, stream, mode, day, calls, errors, rate_limited)
     select x->>'s', x->>'t', x->>'m', (x->>'d')::date, (x->>'c')::int, (x->>'e')::int, (x->>'r')::int
       from jsonb_array_elements($1::jsonb) as x
     on conflict (source, stream, mode, day) do update
       set calls = api_calls_daily.calls + excluded.calls,
           errors = api_calls_daily.errors + excluded.errors,
           rate_limited = api_calls_daily.rate_limited + excluded.rate_limited,
           updated_at = now()`,
    [JSON.stringify(payload)],
  );
  return res.rowCount;
}

/** Calls per stream of one source and mode on one UTC day (the budget split's D). */
export async function streamCallsOn(
  ex: Executor,
  source: string,
  mode: Mode,
  day: string,
): Promise<Record<string, number>> {
  const r = await exec<{ stream: string; calls: number }>(
    ex,
    `select stream, calls from ingest.api_calls_daily
      where source = $1 and mode = $2 and day = $3::date`,
    [source, mode, day],
  );
  return Object.fromEntries(r.rows.map((x) => [x.stream, Number(x.calls)]));
}

/** One ingest.api_calls_daily row, as /admin/connectors reads it. */
export interface ApiCallCount {
  source: string;
  stream: string;
  mode: CountedMode;
  day: string;
  calls: number;
  errors: number;
  rateLimited: number;
  updatedAt: Date;
}

/** Every row of these UTC days, by source, mode, stream. */
export async function apiCallsOn(ex: Executor, days: readonly string[]): Promise<ApiCallCount[]> {
  const r = await exec<Record<string, unknown>>(
    ex,
    `select source, stream, mode, to_char(day, 'YYYY-MM-DD') as day, calls, errors, rate_limited,
            updated_at
       from ingest.api_calls_daily
      where day = any($1::date[])
      order by source, mode, stream, day`,
    [days],
  );
  return r.rows.map((x) => ({
    source: String(x.source),
    stream: String(x.stream),
    mode: x.mode as CountedMode,
    day: String(x.day),
    calls: Number(x.calls),
    errors: Number(x.errors),
    rateLimited: Number(x.rate_limited),
    updatedAt: x.updated_at instanceof Date ? x.updated_at : new Date(String(x.updated_at)),
  }));
}

/** Runs averaged into `callsPerRun`. */
export const CALLS_PER_RUN_WINDOW = 10;

/** What sync_state.extra keeps for the measured cost of one stream's runs. */
export interface CallsPerRun {
  /** Mean calls of the stream's recent successful runs (one decimal), or null. */
  callsPerRun: number | null;
  /** The mode the runs were measured in (a mode switch starts over). */
  mode: string | null;
  /** The recent runs' call counts, oldest first (at most CALLS_PER_RUN_WINDOW). */
  recent: number[];
}

/** Read sync_state.extra's measurement shape (lenient: anything malformed reads as none). */
export function callsPerRunOfExtra(extra: unknown): CallsPerRun {
  const e = (extra && typeof extra === 'object' ? extra : {}) as Record<string, unknown>;
  const recent = Array.isArray(e.callsRecent)
    ? e.callsRecent.filter(
        (n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0,
      )
    : [];
  const cpr =
    typeof e.callsPerRun === 'number' && Number.isFinite(e.callsPerRun) ? e.callsPerRun : null;
  const mode = typeof e.callsPerRunMode === 'string' ? e.callsPerRunMode : null;
  return { callsPerRun: cpr, mode, recent };
}

/** The next measurement after a run that made `calls` calls (pure). */
export function nextCallsPerRun(prev: CallsPerRun, mode: string, calls: number): CallsPerRun {
  const recent = [...(prev.mode === mode ? prev.recent : []), Math.max(0, calls)].slice(
    -CALLS_PER_RUN_WINDOW,
  );
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  return { callsPerRun: Math.round(mean * 10) / 10, mode, recent };
}

/**
 * After a successful run of (source, stream) that made `calls` calls in `mode`: fold them into
 * the stream's `callsPerRun` (mean of the last CALLS_PER_RUN_WINDOW successful runs of that
 * mode), merged into sync_state.extra. Returns the new mean (null when the row is missing).
 */
export async function recordRunCalls(
  ex: Executor,
  source: string,
  stream: string,
  mode: string,
  calls: number,
): Promise<number | null> {
  const r = await exec<{ extra: unknown }>(
    ex,
    'select extra from ingest.sync_state where source = $1 and stream = $2',
    [source, stream],
  );
  if (!r.rows[0]) return null;
  const next = nextCallsPerRun(callsPerRunOfExtra(r.rows[0].extra), mode, calls);
  await exec(
    ex,
    `update ingest.sync_state
        set extra = coalesce(extra, '{}'::jsonb) || jsonb_build_object(
              'callsPerRun', $3::numeric, 'callsPerRunMode', $4::text, 'callsRecent', $5::jsonb)
      where source = $1 and stream = $2`,
    [source, stream, next.callsPerRun, mode, JSON.stringify(next.recent)],
  );
  return next.callsPerRun;
}

/** A stream's measured calls per run in `mode`, or null (none measured in that mode yet). */
export async function callsPerRunOf(
  ex: Executor,
  source: string,
  stream: string,
  mode: string,
): Promise<number | null> {
  const r = await exec<{ extra: unknown }>(
    ex,
    'select extra from ingest.sync_state where source = $1 and stream = $2',
    [source, stream],
  );
  const m = callsPerRunOfExtra(r.rows[0]?.extra);
  return m.mode === mode ? m.callsPerRun : null;
}
