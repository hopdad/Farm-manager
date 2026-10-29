/**
 * Geofence enter/exit detection inside the fleet positions step (plan 1a; contracts-m1 §13:
 * "Geofence detection is not a job: it runs inside the fleet positions step"). PostGIS answers
 * which active farm.geofences contain a fix; the rules in src/domain/geofence.ts turn the
 * machine's fixes into farm.geofence_visits rows.
 *
 * `detectGeofenceVisits(tx, machineId, ts)` runs right after a NEW fix was stored (in the same
 * per-event transaction, so a fix and its visits commit together and a crash loses neither):
 *
 *  - In-order fix (the machine's newest): one step of the rules against the machine's open
 *    visits and its previous fix. Three statements; this is every ELD fix in normal operation.
 *  - Out-of-order fix (a newer fix is already stored: a reordered page, a late ELD upload, a
 *    Deere backfill): recompute the stretch it can affect and reconcile the stored rows with
 *    `planVisitChanges` (unchanged visits keep their ids). The stretch starts at the fix before
 *    the late one, moved back to the start of every stored visit still in progress at that
 *    point (repeated until stable), so the recomputation never starts inside a visit.
 *
 * Idempotent: the caller runs it only for fixes it actually inserted, and running it again for
 * the same fix derives the same visits (no change). A transaction-scoped advisory lock per
 * machine serializes the two positions jobs (fleet.trucks, fleet.deere) on a machine that has
 * both feeds. `ex` MUST be a transaction (the lock lasts until it commits).
 *
 * Geofences added or reshaped later apply from then on; past visits are not rewritten.
 */

import { type Executor, exec, toDate } from '../db/exec';
import {
  deriveVisits,
  type FixInside,
  type GeofenceVisit,
  planVisitChanges,
  type StoredVisit,
  stepVisits,
  VISIT_MAX_GAP_SECONDS,
  type VisitState,
} from '../domain/geofence';

export interface GeofenceDetectionOptions {
  /** Default VISIT_MAX_GAP_SECONDS. */
  maxGapSeconds?: number;
}

export interface GeofenceDetectionResult {
  /** 'fast' = in-order step; 'recompute' = a late fix's stretch was rebuilt. */
  path: 'fast' | 'recompute';
  opened: number;
  closed: number;
  /** Rows deleted or reopened (recompute only). */
  changed: number;
}

const ms = (v: unknown): number => (toDate(v) as Date).getTime();
const iso = (t: number) => new Date(t).toISOString();

interface NeighbourRow {
  prev_ts: Date | string | null;
  has_later: boolean;
  inside: string[] | null;
}

interface OpenRow {
  id: string;
  geofence_id: string;
  entered_at: Date | string;
}

/** The geofences that contain this stored fix, the fix before it, and whether a newer one exists. */
async function neighbours(ex: Executor, machineId: string, ts: string): Promise<NeighbourRow> {
  const r = await exec<NeighbourRow>(
    ex,
    `select
       (select max(p.ts) from farm.positions p
         where p.machine_id = $1::uuid and p.ts < $2::timestamptz) as prev_ts,
       exists (select 1 from farm.positions p
                where p.machine_id = $1::uuid and p.ts > $2::timestamptz) as has_later,
       (select array_agg(g.id::text order by g.id)
          from farm.positions p
          join farm.geofences g on g.active and extensions.ST_Intersects(g.geom, p.geom)
         where p.machine_id = $1::uuid and p.ts = $2::timestamptz) as inside`,
    [machineId, ts],
  );
  return r.rows[0] as NeighbourRow;
}

async function insertVisits(
  ex: Executor,
  machineId: string,
  visits: readonly GeofenceVisit[],
): Promise<void> {
  for (const v of visits) {
    await exec(
      ex,
      `insert into farm.geofence_visits (machine_id, geofence_id, entered_at, exited_at)
       values ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)
       on conflict (machine_id, geofence_id, entered_at) do update
         set exited_at = excluded.exited_at, updated_at = now()
       where farm.geofence_visits.exited_at is distinct from excluded.exited_at`,
      [machineId, v.geofenceId, iso(v.enteredAt), v.exitedAt === null ? null : iso(v.exitedAt)],
    );
  }
}

async function closeVisit(ex: Executor, id: string, exitedAt: number): Promise<void> {
  await exec(
    ex,
    `update farm.geofence_visits set exited_at = $2::timestamptz, updated_at = now()
      where id = $1::uuid`,
    [id, iso(exitedAt)],
  );
}

/** Detect enter/exit for the fix of `machineId` at `ts`, which the caller just inserted. */
export async function detectGeofenceVisits(
  ex: Executor,
  machineId: string,
  ts: string | Date,
  opts: GeofenceDetectionOptions = {},
): Promise<GeofenceDetectionResult> {
  const maxGapMs = (opts.maxGapSeconds ?? VISIT_MAX_GAP_SECONDS) * 1000;
  const fixTs = typeof ts === 'string' ? ts : ts.toISOString();
  await exec(
    ex,
    `select pg_advisory_xact_lock(hashtextextended('farm.geofence_visits:' || $1, 0))`,
    [machineId],
  );
  const n = await neighbours(ex, machineId, fixTs);
  const fixMs = Date.parse(fixTs);
  if (!n.has_later) {
    const open = await exec<OpenRow>(
      ex,
      `select id::text as id, geofence_id::text as geofence_id, entered_at
         from farm.geofence_visits where machine_id = $1::uuid and exited_at is null`,
      [machineId],
    );
    const rows = open.rows.map((o) => ({ ...o, enteredMs: ms(o.entered_at) }));
    const prevMs = n.prev_ts === null ? null : ms(n.prev_ts);
    // The fast path assumes the open visits describe the previous fix; anything else (a visit
    // opened at or after this fix) means the stored state needs a rebuild.
    if (rows.every((o) => o.enteredMs < fixMs && (prevMs === null || o.enteredMs <= prevMs))) {
      const state: VisitState = {
        open: new Map(rows.map((o) => [o.geofence_id, o.enteredMs])),
        lastTs: prevMs,
      };
      const step = stepVisits(state, { ts: fixMs, inside: n.inside ?? [] }, maxGapMs);
      const idOf = new Map(rows.map((o) => [o.geofence_id, o.id]));
      for (const c of step.closed) {
        await closeVisit(ex, idOf.get(c.geofenceId) as string, c.exitedAt as number);
      }
      await insertVisits(
        ex,
        machineId,
        step.opened.map((geofenceId) => ({ geofenceId, enteredAt: fixMs, exitedAt: null })),
      );
      return { path: 'fast', opened: step.opened.length, closed: step.closed.length, changed: 0 };
    }
  }
  return recomputeFrom(ex, machineId, n.prev_ts === null ? fixMs : ms(n.prev_ts), maxGapMs);
}

/** The start of the stretch to rebuild: never inside a stored visit (see the header). */
async function stretchStart(ex: Executor, machineId: string, from: number): Promise<number> {
  let start = from;
  for (let i = 0; i < 10_000; i++) {
    const r = await exec<{ earliest: Date | string | null }>(
      ex,
      `select min(entered_at) as earliest from farm.geofence_visits
        where machine_id = $1::uuid and entered_at < $2::timestamptz
          and coalesce(exited_at, 'infinity'::timestamptz) >= $2::timestamptz`,
      [machineId, iso(start)],
    );
    const earliest = r.rows[0]?.earliest ?? null;
    if (earliest === null) return start;
    start = ms(earliest);
  }
  throw new Error(`geofence visits of machine ${machineId} do not converge`);
}

/** Rebuild the machine's visits from `from` (a fix time) onwards and store the difference. */
export async function recomputeFrom(
  ex: Executor,
  machineId: string,
  from: number,
  maxGapMs: number = VISIT_MAX_GAP_SECONDS * 1000,
): Promise<GeofenceDetectionResult> {
  const start = await stretchStart(ex, machineId, from);
  const fixes = await exec<{ ts: Date | string; inside: string[] | null }>(
    ex,
    `select p.ts,
            array_agg(g.id::text order by g.id) filter (where g.id is not null) as inside
       from farm.positions p
       left join farm.geofences g on g.active and extensions.ST_Intersects(g.geom, p.geom)
      where p.machine_id = $1::uuid and p.ts >= $2::timestamptz
      group by p.ts
      order by p.ts`,
    [machineId, iso(start)],
  );
  const derived = deriveVisits(
    fixes.rows.map((f): FixInside => ({ ts: ms(f.ts), inside: f.inside ?? [] })),
    maxGapMs,
  );
  const stored = await exec<{
    id: string;
    geofence_id: string;
    entered_at: Date | string;
    exited_at: Date | string | null;
  }>(
    ex,
    `select id::text as id, geofence_id::text as geofence_id, entered_at, exited_at
       from farm.geofence_visits
      where machine_id = $1::uuid and entered_at >= $2::timestamptz`,
    [machineId, iso(start)],
  );
  const plan = planVisitChanges(
    stored.rows.map(
      (s): StoredVisit => ({
        id: s.id,
        geofenceId: s.geofence_id,
        enteredAt: ms(s.entered_at),
        exitedAt: s.exited_at === null ? null : ms(s.exited_at),
      }),
    ),
    derived,
  );
  if (plan.deletes.length) {
    await exec(ex, 'delete from farm.geofence_visits where id = any($1::uuid[])', [plan.deletes]);
  }
  for (const c of plan.closes) await closeVisit(ex, c.id, c.exitedAt);
  if (plan.reopens.length) {
    await exec(
      ex,
      `update farm.geofence_visits set exited_at = null, updated_at = now()
        where id = any($1::uuid[])`,
      [plan.reopens],
    );
  }
  await insertVisits(ex, machineId, plan.inserts);
  return {
    path: 'recompute',
    opened: plan.inserts.filter((v) => v.exitedAt === null).length + plan.reopens.length,
    closed: plan.closes.length + plan.inserts.filter((v) => v.exitedAt !== null).length,
    changed: plan.deletes.length + plan.reopens.length,
  };
}
