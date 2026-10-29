/**
 * Geofence visits (plan 1a; plan §5 "Geofence arrivals are computed in PostGIS from positions, so
 * switching vendors doesn't touch that logic"). Pure TS: the rules that turn one machine's fixes,
 * in time order, into enter/exit visits of farm.geofences (elevator yards, the shop, bin sites,
 * field entrances, fuel). The database side (src/jobs/geofences.ts) answers "which geofences
 * contain this fix" in PostGIS and stores the result in farm.geofence_visits.
 *
 * THE RULES, per machine and geofence G, over the machine's fixes sorted by time:
 *  - A visit STARTS at the first fix inside G (entered_at = that fix's time), when the fix
 *    before it was outside G, or there was none, or it was more than `maxGapMs` earlier.
 *  - A visit ENDS at the first later fix outside G (exited_at = that fix's time: the first time
 *    we saw the machine out), or, when the next fix comes more than `maxGapMs` after the last
 *    one inside G, at that last inside fix (we lost track; a gap is not a stay).
 *  - A visit whose machine is still inside G at its newest fix stays OPEN (exited_at null).
 * So visits are a pure function of the fix sequence: a late (out-of-order) fix is handled by
 * recomputing the affected stretch, and processing the same fixes twice changes nothing.
 *
 * Deere breadcrumbs exist only while a machine works, so a gap in a Deere-only machine's fixes
 * means "stopped working somewhere", not "stayed put": the gap rule closes such visits.
 */

/** A fix that comes more than this long after the previous one breaks every open visit. */
export const VISIT_MAX_GAP_SECONDS = 30 * 60;

/** One fix of one machine: its time (epoch ms) and the ids of the geofences that contain it. */
export interface FixInside {
  ts: number;
  inside: readonly string[];
}

/** A visit of one machine to one geofence (times in epoch ms). */
export interface GeofenceVisit {
  geofenceId: string;
  enteredAt: number;
  /** Null while the machine is still inside (as of its newest fix). */
  exitedAt: number | null;
}

/** Open visits (geofence id -> entered_at) and the time of the newest fix applied. */
export interface VisitState {
  open: Map<string, number>;
  lastTs: number | null;
}

export function emptyVisitState(): VisitState {
  return { open: new Map(), lastTs: null };
}

/**
 * Apply ONE fix (newer than `state.lastTs`) to the open visits. Mutates `state`; returns the
 * visits this fix closed and the geofence ids it opened, so a caller can apply just the change
 * (the in-order fast path of the job) or fold a whole sequence (`deriveVisits`).
 */
export function stepVisits(
  state: VisitState,
  fix: FixInside,
  maxGapMs: number = VISIT_MAX_GAP_SECONDS * 1000,
): { closed: GeofenceVisit[]; opened: string[] } {
  if (state.lastTs !== null && fix.ts <= state.lastTs) {
    throw new RangeError(
      `stepVisits: fixes must be applied oldest first (${fix.ts} after ${state.lastTs})`,
    );
  }
  const inside = new Set(fix.inside);
  const gap = state.lastTs !== null && fix.ts - state.lastTs > maxGapMs;
  const closed: GeofenceVisit[] = [];
  for (const [geofenceId, enteredAt] of [...state.open]) {
    if (gap) {
      closed.push({ geofenceId, enteredAt, exitedAt: state.lastTs });
      state.open.delete(geofenceId);
    } else if (!inside.has(geofenceId)) {
      closed.push({ geofenceId, enteredAt, exitedAt: fix.ts });
      state.open.delete(geofenceId);
    }
  }
  const opened: string[] = [];
  for (const geofenceId of [...inside].sort()) {
    if (!state.open.has(geofenceId)) {
      state.open.set(geofenceId, fix.ts);
      opened.push(geofenceId);
    }
  }
  state.lastTs = fix.ts;
  return { closed, opened };
}

/** Order visits deterministically: by entered_at, then geofence id. */
export function compareVisits(a: GeofenceVisit, b: GeofenceVisit): number {
  return a.enteredAt - b.enteredAt || (a.geofenceId < b.geofenceId ? -1 : 1);
}

/**
 * Every visit of a fix sequence (sorted oldest first, distinct times), open ones last-known
 * (exitedAt null). The sequence must start where no visit is in progress (see the job's window).
 */
export function deriveVisits(
  fixes: readonly FixInside[],
  maxGapMs: number = VISIT_MAX_GAP_SECONDS * 1000,
): GeofenceVisit[] {
  const state = emptyVisitState();
  const visits: GeofenceVisit[] = [];
  for (const fix of fixes) visits.push(...stepVisits(state, fix, maxGapMs).closed);
  for (const [geofenceId, enteredAt] of state.open) {
    visits.push({ geofenceId, enteredAt, exitedAt: null });
  }
  return visits.sort(compareVisits);
}

/** A stored visit (farm.geofence_visits row) as the reconciliation sees it. */
export interface StoredVisit extends GeofenceVisit {
  id: string;
}

/** What to change so the stored visits of a window equal the derived ones. */
export interface VisitChanges {
  /** Stored visits that no longer exist. */
  deletes: string[];
  /** Stored visits whose exited_at changes to a time (apply before `reopens` and `inserts`). */
  closes: { id: string; exitedAt: number }[];
  /** Stored visits that become open again (a late fix showed the machine never left). */
  reopens: string[];
  /** Visits to insert. */
  inserts: GeofenceVisit[];
}

const visitKey = (v: Pick<GeofenceVisit, 'geofenceId' | 'enteredAt'>) =>
  `${v.geofenceId}|${v.enteredAt}`;

/**
 * Diff the stored visits of a window against the derived ones, keyed on (geofence, entered_at)
 * (the table's unique key), so an unchanged visit keeps its row and id. Applying deletes, then
 * closes, then reopens, then inserts never breaks the "one open visit per machine and geofence"
 * index: the derived set has at most one open visit per geofence.
 */
export function planVisitChanges(
  stored: readonly StoredVisit[],
  derived: readonly GeofenceVisit[],
): VisitChanges {
  const want = new Map(derived.map((v) => [visitKey(v), v]));
  const have = new Set<string>();
  const changes: VisitChanges = { deletes: [], closes: [], reopens: [], inserts: [] };
  for (const s of stored) {
    const key = visitKey(s);
    const d = want.get(key);
    if (!d || have.has(key)) {
      changes.deletes.push(s.id);
      continue;
    }
    have.add(key);
    if (d.exitedAt === s.exitedAt) continue;
    if (d.exitedAt === null) changes.reopens.push(s.id);
    else changes.closes.push({ id: s.id, exitedAt: d.exitedAt });
  }
  for (const [key, d] of want) if (!have.has(key)) changes.inserts.push(d);
  changes.inserts.sort(compareVisits);
  return changes;
}

/** True when a plan changes nothing. */
export function isNoChange(c: VisitChanges): boolean {
  return !c.deletes.length && !c.closes.length && !c.reopens.length && !c.inserts.length;
}
