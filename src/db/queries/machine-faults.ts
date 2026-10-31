/**
 * The fault writer (slice 1f, fleet-faults; docs/contracts-1f.md §5.3, decisions 1f-2 and 1f-12):
 * `farm.machine_faults` keeps the history (ONE open row per machine, source and code; a code seen
 * again after it cleared opens a new row) and `farm.machine_state.fault_codes` / `faults_at` the
 * current summary the fleet panel shows. Called by `upsertVehicleStat` (./fleet.ts) for a stat
 * that carries `faultCodes`, inside the sync step's per-event transaction, so every vendor's
 * faults land through the same rules:
 *
 *  - `snapshot` reports (Samsara's faultCodes stat; the default): the complete active set at `ts`.
 *    The GUARD is the machine's `faults_at` (or, while it has no machine_state row or no faults_at
 *    yet, the newest last_seen_at / cleared_at of its machine_faults rows).
 *      newer than the guard: open the codes it names (or refresh their last_seen_at and details),
 *        clear the open codes of this source it no longer names, then refresh machine_state;
 *      not newer: only extend last_seen_at (greatest) of the open rows it names. It never opens,
 *        clears or reopens a code, and never touches machine_state (so an older page can't bring
 *        a cleared code back).
 *  - `delta` reports (Motive, Geotab, AEMP, CNH, Terminal): each fault states its own state and
 *    times; codes not named are unchanged. Per fault, its time is `lastSeenAt` (open) or
 *    `closedAt` (closed), else `ts`: an open item newer than its open row refreshes it, with no
 *    open row it opens one (`first_seen_at` = its `firstSeenAt` when sent) unless the code was
 *    closed at or after that time; a closed item at or after its open row's last_seen_at clears
 *    it (`cleared_at` = that time); anything older changes nothing. With `faultAgeOutSeconds`
 *    (decision 1f-12) the open rows of this machine and source not seen since
 *    `ts − faultAgeOutSeconds` close at `ts`. Then machine_state is refreshed.
 *
 * Refreshing machine_state: `fault_codes` = the machine's open rows (every source, one entry per
 * code: the worst severity, the earliest `since`), sorted by `sortFaultCodes`; `faults_at` = the
 * newest event time. When the active set (codes and severities) changed, `fleet`/`invalidate`
 * `{ event: 'machine', reason: 'faults' }` is published in the same transaction, so the panel
 * refetches. A machine with no machine_state row (no fix yet) still gets its machine_faults rows;
 * the first position insert seeds its summary (`seedFaultSummary`, called by upsertPosition).
 *
 * Per-module clearing (fleet-faults' additive extension, not in the contract types yet): a
 * snapshot may say which OBD-II control modules it covers (`ScopedVehicleStat.faultScope`) and
 * each OBD-II fault its `module` (`ModuleFault`). Then an open OBD-II code of a module the report
 * doesn't name is left alone (Samsara lists OBD-II codes per `txId` and doesn't promise every
 * module in each reading); an open OBD-II code with no recorded module counts as covered by any
 * report that names at least one module. The module of each open OBD-II code is kept in
 * `farm.machine_fault_modules` (db/pending/fleet-faults.sql). Reports without a scope (every
 * other vendor) are plain snapshots.
 *
 * The machine's farm.machines row is locked FOR UPDATE first: a position insert holds a key-share
 * lock on it (the foreign keys of farm.positions / machine_state), so a first fix and a fault
 * report for the same machine never miss each other.
 */
import type { NormalizedVehicleStat } from '../../connectors/types';
import {
  type ActiveFaultCode,
  activeFaultCodeSchema,
  type FaultLamps,
  type FaultSeverity,
  type FaultSystem,
  type NormalizedFault,
  normalizedFaultSchema,
  type ObdDtcState,
  type OemFaultClass,
  severityRank,
  sortFaultCodes,
} from '../../domain/fault-codes';
import { publish } from '../../platform/realtime/publish';
import { type Executor, exec, toDate } from '../exec';

/** A fault with the control module that reported it (Samsara's OBD-II `txId`), when known. */
export interface ModuleFault extends NormalizedFault {
  module?: string | null;
}

/** Which OBD-II modules a snapshot covers (codes of other modules are unchanged). */
export interface FaultModuleScope {
  obdModules: readonly string[];
}

/** A stat whose snapshot may carry per-module scope (fleet-faults' extension). */
export interface ScopedVehicleStat extends NormalizedVehicleStat {
  faultCodes?: ModuleFault[];
  faultScope?: FaultModuleScope;
}

export interface FaultReportResult {
  /** How the report was applied: a snapshot newer or not newer than the guard, or a delta. */
  applied: 'newer' | 'older' | 'delta';
  opened: number;
  refreshed: number;
  cleared: number;
  /** The machine's active set changed on its machine_state row (the invalidate was published). */
  changed: boolean;
}

interface OpenRow {
  id: string;
  code: string;
  system: FaultSystem;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  module: string | null;
}

interface SummaryRow {
  code: string;
  severity: FaultSeverity;
  description: string | null;
  system: FaultSystem;
  spn: number | null;
  fmi: number | null;
  dtc_state: ObdDtcState | null;
  oem_class: OemFaultClass | null;
  lamps: FaultLamps | null;
  first_seen_at: Date | string;
}

const ms = (v: unknown): number => (toDate(v) as Date).getTime();

/** Validates every fault up front, so a bad mapper output fails with a readable reason. */
function checkedFaults(s: ScopedVehicleStat): ModuleFault[] {
  const out = new Map<string, ModuleFault>();
  for (const f of s.faultCodes ?? []) {
    const r = normalizedFaultSchema.safeParse(f);
    if (!r.success) {
      const issue = r.error.issues[0];
      throw new Error(
        `invalid fault ${JSON.stringify(f.code)} from ${s.source}: ${issue?.path.join('.') || '(fault)'} ${issue?.message ?? ''}`.trim(),
      );
    }
    // One item per code (a vendor listing a code twice): the first wins.
    if (!out.has(f.code)) out.set(f.code, f);
  }
  return [...out.values()];
}

/** The system's own columns only (the machine_faults_system_check CHECK). */
function systemColumns(f: NormalizedFault) {
  return {
    spn: f.system === 'j1939' ? (f.spn ?? null) : null,
    fmi: f.system === 'j1939' ? (f.fmi ?? null) : null,
    sourceAddress: f.system === 'j1939' ? (f.sourceAddress ?? null) : null,
    dtcState: f.system === 'obd2' ? (f.dtcState ?? null) : null,
    oemClass: f.system === 'oem' ? (f.oemClass ?? null) : null,
  };
}

async function openRows(ex: Executor, machineId: string, source: string): Promise<OpenRow[]> {
  const r = await exec<OpenRow>(
    ex,
    `select f.id::text as id, f.code, f.system, f.first_seen_at, f.last_seen_at, m.module
       from farm.machine_faults f
       left join farm.machine_fault_modules m on m.fault_id = f.id
      where f.machine_id = $1::uuid and f.source = $2 and f.cleared_at is null`,
    [machineId, source],
  );
  return r.rows;
}

/** Newest event time any machine_faults row of the machine records (the guard with no state). */
async function newestRowTime(ex: Executor, machineId: string): Promise<Date | null> {
  const r = await exec<{ t: Date | string | null }>(
    ex,
    `select greatest(max(last_seen_at), max(cleared_at)) as t
       from farm.machine_faults where machine_id = $1::uuid`,
    [machineId],
  );
  return toDate(r.rows[0]?.t ?? null);
}

/**
 * Insert a new open row, or refresh the open row of its code: last_seen_at never moves back;
 * the details (severity, lamps, description, counts) follow the newest sighting; first_seen_at
 * moves earlier only when the vendor says so (`firstSeenAt`). Returns whether it was new.
 */
async function upsertOpen(
  ex: Executor,
  machineId: string,
  source: string,
  f: ModuleFault,
  seenAt: Date,
): Promise<{ id: string; inserted: boolean }> {
  const c = systemColumns(f);
  const vendorFirst = f.firstSeenAt ? new Date(f.firstSeenAt) : null;
  const first = vendorFirst && vendorFirst < seenAt ? vendorFirst : seenAt;
  const r = await exec<{ id: string; inserted: boolean }>(
    ex,
    `insert into farm.machine_faults as mf
       (machine_id, source, code, system, spn, fmi, source_address, occurrence_count, dtc_state,
        oem_class, lamps, severity, vendor_severity, description, first_seen_at, last_seen_at)
     values ($1::uuid, $2, $3, $4, $5::int, $6::int, $7::int, $8::int, $9, $10, $11::jsonb, $12,
             $13, $14, $15::timestamptz, $16::timestamptz)
     on conflict (machine_id, source, code) where cleared_at is null do update
       set first_seen_at = case when $17::boolean then least(mf.first_seen_at, excluded.first_seen_at)
                                else mf.first_seen_at end,
           last_seen_at = greatest(mf.last_seen_at, excluded.last_seen_at),
           system = case when excluded.last_seen_at >= mf.last_seen_at then excluded.system else mf.system end,
           spn = case when excluded.last_seen_at >= mf.last_seen_at then excluded.spn else mf.spn end,
           fmi = case when excluded.last_seen_at >= mf.last_seen_at then excluded.fmi else mf.fmi end,
           source_address = case when excluded.last_seen_at >= mf.last_seen_at
                                 then excluded.source_address else mf.source_address end,
           occurrence_count = case when excluded.last_seen_at >= mf.last_seen_at
                                   then coalesce(excluded.occurrence_count, mf.occurrence_count)
                                   else mf.occurrence_count end,
           dtc_state = case when excluded.last_seen_at >= mf.last_seen_at then excluded.dtc_state else mf.dtc_state end,
           oem_class = case when excluded.last_seen_at >= mf.last_seen_at then excluded.oem_class else mf.oem_class end,
           lamps = case when excluded.last_seen_at >= mf.last_seen_at then excluded.lamps else mf.lamps end,
           severity = case when excluded.last_seen_at >= mf.last_seen_at then excluded.severity else mf.severity end,
           vendor_severity = case when excluded.last_seen_at >= mf.last_seen_at
                                  then excluded.vendor_severity else mf.vendor_severity end,
           description = case when excluded.last_seen_at >= mf.last_seen_at
                              then coalesce(excluded.description, mf.description) else mf.description end,
           updated_at = now()
     returning mf.id::text as id, (xmax = 0) as inserted`,
    [
      machineId,
      source,
      f.code,
      f.system,
      c.spn,
      c.fmi,
      c.sourceAddress,
      f.occurrenceCount ?? null,
      c.dtcState,
      c.oemClass,
      f.lamps ? JSON.stringify(f.lamps) : null,
      f.severity,
      f.vendorSeverity ?? null,
      f.description ?? null,
      first.toISOString(),
      seenAt.toISOString(),
      vendorFirst !== null,
    ],
  );
  const row = r.rows[0] as { id: string; inserted: boolean };
  if (f.system === 'obd2' && f.module) {
    await exec(
      ex,
      `insert into farm.machine_fault_modules (fault_id, module) values ($1::uuid, $2)
       on conflict (fault_id) do update set module = excluded.module, updated_at = now()
        where machine_fault_modules.module <> excluded.module`,
      [row.id, f.module],
    );
  }
  return row;
}

async function clearRows(ex: Executor, ids: string[], at: Date): Promise<number> {
  if (!ids.length) return 0;
  const r = await exec(
    ex,
    `update farm.machine_faults
        set cleared_at = greatest($2::timestamptz, first_seen_at), updated_at = now()
      where id = any($1::uuid[]) and cleared_at is null`,
    [ids, at.toISOString()],
  );
  await exec(ex, 'delete from farm.machine_fault_modules where fault_id = any($1::uuid[])', [ids]);
  return r.rowCount;
}

/** Is this open row one the snapshot speaks for (per-module OBD-II scope)? */
function inScope(row: OpenRow, scope: FaultModuleScope | undefined): boolean {
  if (!scope || row.system !== 'obd2') return true;
  if (scope.obdModules.length === 0) return false;
  return row.module === null || scope.obdModules.includes(row.module);
}

async function applySnapshot(
  ex: Executor,
  machineId: string,
  s: ScopedVehicleStat,
  faults: ModuleFault[],
  guard: Date | null,
  out: FaultReportResult,
): Promise<boolean> {
  const ts = new Date(s.ts);
  if (guard && ts.getTime() <= guard.getTime()) {
    // Older than what the machine already reflects: extend the codes it names, nothing more.
    out.applied = 'older';
    if (faults.length) {
      const r = await exec(
        ex,
        `update farm.machine_faults set last_seen_at = $4::timestamptz, updated_at = now()
          where machine_id = $1::uuid and source = $2 and cleared_at is null
            and code = any($3::text[]) and last_seen_at < $4::timestamptz`,
        [machineId, s.source, faults.map((f) => f.code), ts.toISOString()],
      );
      out.refreshed += r.rowCount;
    }
    return false;
  }
  out.applied = 'newer';
  const open = await openRows(ex, machineId, s.source);
  for (const f of faults) {
    const r = await upsertOpen(ex, machineId, s.source, f, ts);
    if (r.inserted) out.opened++;
    else out.refreshed++;
  }
  const named = new Set(faults.map((f) => f.code));
  const gone = open.filter((row) => !named.has(row.code) && inScope(row, s.faultScope));
  out.cleared += await clearRows(
    ex,
    gone.map((row) => row.id),
    ts,
  );
  return true;
}

/** The time a delta item speaks for: when it was last seen (open) or closed (closed). */
function deltaTime(f: NormalizedFault, ts: Date): Date {
  const t = (f.state ?? 'open') === 'closed' ? (f.closedAt ?? f.lastSeenAt) : f.lastSeenAt;
  return t ? new Date(t) : ts;
}

async function applyDelta(
  ex: Executor,
  machineId: string,
  s: ScopedVehicleStat,
  faults: ModuleFault[],
  out: FaultReportResult,
): Promise<void> {
  const ts = new Date(s.ts);
  out.applied = 'delta';
  const open = new Map((await openRows(ex, machineId, s.source)).map((r) => [r.code, r]));
  for (const f of faults) {
    const at = deltaTime(f, ts);
    const row = open.get(f.code);
    if ((f.state ?? 'open') === 'closed') {
      if (row && at.getTime() >= ms(row.last_seen_at)) {
        out.cleared += await clearRows(ex, [row.id], at);
        open.delete(f.code);
      }
      continue;
    }
    if (row) {
      if (at.getTime() > ms(row.last_seen_at)) {
        await upsertOpen(ex, machineId, s.source, f, at);
        out.refreshed++;
      }
      continue;
    }
    // No open row: open one, unless the code was closed at or after this sighting.
    const closed = await exec<{ t: Date | string | null }>(
      ex,
      `select max(cleared_at) as t from farm.machine_faults
        where machine_id = $1::uuid and source = $2 and code = $3 and cleared_at is not null`,
      [machineId, s.source, f.code],
    );
    const closedAt = toDate(closed.rows[0]?.t ?? null);
    if (closedAt && at.getTime() <= closedAt.getTime()) continue;
    const r = await upsertOpen(ex, machineId, s.source, f, at);
    if (r.inserted) out.opened++;
  }
  if (s.faultAgeOutSeconds !== undefined && s.faultAgeOutSeconds > 0) {
    const r = await exec(
      ex,
      `update farm.machine_faults
          set cleared_at = greatest($3::timestamptz, first_seen_at), updated_at = now()
        where machine_id = $1::uuid and source = $2 and cleared_at is null
          and last_seen_at < $3::timestamptz - make_interval(secs => $4::float8)`,
      [machineId, s.source, ts.toISOString(), s.faultAgeOutSeconds],
    );
    out.cleared += r.rowCount;
    await exec(
      ex,
      `delete from farm.machine_fault_modules m using farm.machine_faults f
        where f.id = m.fault_id and f.machine_id = $1::uuid and f.source = $2
          and f.cleared_at is not null`,
      [machineId, s.source],
    );
  }
}

/**
 * The machine's open faults (every source) as the panel's summary: one entry per code (the
 * worst severity, the earliest `since`), worst first (`sortFaultCodes`).
 */
export async function activeFaultSummary(
  ex: Executor,
  machineId: string,
): Promise<ActiveFaultCode[]> {
  const r = await exec<SummaryRow>(
    ex,
    `select code, severity, description, system, spn, fmi, dtc_state, oem_class, lamps,
            first_seen_at
       from farm.machine_faults
      where machine_id = $1::uuid and cleared_at is null
      order by first_seen_at, id`,
    [machineId],
  );
  const byCode = new Map<string, ActiveFaultCode>();
  for (const row of r.rows) {
    const since = (toDate(row.first_seen_at) as Date).toISOString();
    const f: ActiveFaultCode = {
      code: row.code,
      severity: row.severity,
      description: row.description,
      system: row.system,
      ...(row.system === 'j1939' ? { spn: row.spn, fmi: row.fmi } : {}),
      ...(row.system === 'obd2' ? { dtcState: row.dtc_state } : {}),
      ...(row.system === 'oem' ? { oemClass: row.oem_class } : {}),
      ...(row.lamps ? { lamps: row.lamps } : {}),
      since,
    };
    const prev = byCode.get(row.code);
    if (!prev) byCode.set(row.code, f);
    else if (severityRank(f.severity) > severityRank(prev.severity)) {
      byCode.set(row.code, { ...f, since: prev.since });
    }
  }
  return sortFaultCodes([...byCode.values()]);
}

/** A stored fault_codes value as the panel reads it (anything malformed counts as none). */
export function parseStoredFaults(v: unknown): ActiveFaultCode[] {
  if (!Array.isArray(v)) return [];
  const out: ActiveFaultCode[] = [];
  for (const item of v) {
    const p = activeFaultCodeSchema.safeParse(item);
    if (p.success) out.push(p.data);
  }
  return out;
}

/** "Changed" for the panel: a different set of codes, or a code at a different severity. */
export function faultSetChanged(
  before: readonly Pick<ActiveFaultCode, 'code' | 'severity'>[],
  after: readonly Pick<ActiveFaultCode, 'code' | 'severity'>[],
): boolean {
  const key = (l: readonly Pick<ActiveFaultCode, 'code' | 'severity'>[]) =>
    l
      .map((f) => `${f.code}\u0000${f.severity}`)
      .sort()
      .join('\u0001');
  return key(before) !== key(after);
}

/**
 * Apply one fault report (a stat with `faultCodes`) for `machineId` (resolved through
 * ingest.external_refs). Null when the stat says nothing about faults.
 */
export async function applyFaultReport(
  ex: Executor,
  machineId: string,
  stat: NormalizedVehicleStat,
): Promise<FaultReportResult | null> {
  const s = stat as ScopedVehicleStat;
  if (s.faultCodes === undefined) return null;
  const faults = checkedFaults(s);
  await exec(ex, 'select 1 from farm.machines where id = $1::uuid for update', [machineId]);
  const st = (
    await exec<{ fault_codes: unknown; faults_at: Date | string | null }>(
      ex,
      `select fault_codes, faults_at from farm.machine_state where machine_id = $1::uuid for update`,
      [machineId],
    )
  ).rows[0];
  const out: FaultReportResult = {
    applied: 'newer',
    opened: 0,
    refreshed: 0,
    cleared: 0,
    changed: false,
  };
  let touchState: boolean;
  if ((s.faultReport ?? 'snapshot') === 'snapshot') {
    const guard = toDate(st?.faults_at ?? null) ?? (await newestRowTime(ex, machineId));
    touchState = await applySnapshot(ex, machineId, s, faults, guard, out);
  } else {
    await applyDelta(ex, machineId, s, faults, out);
    touchState = true;
  }
  if (!st || !touchState) return out;
  const active = await activeFaultSummary(ex, machineId);
  await exec(
    ex,
    `update farm.machine_state
        set fault_codes = $2::jsonb,
            faults_at = greatest(coalesce(faults_at, $3::timestamptz), $3::timestamptz),
            updated_at = now()
      where machine_id = $1::uuid`,
    [machineId, JSON.stringify(active), new Date(s.ts).toISOString()],
  );
  if (faultSetChanged(parseStoredFaults(st.fault_codes), active)) {
    out.changed = true;
    await publish('fleet', 'invalidate', { event: 'machine', reason: 'faults' }, ex);
  }
  return out;
}

/**
 * A machine's first machine_state row (its first fix): seed `fault_codes` from its open
 * machine_faults rows and `faults_at` from the guard time (the newest last_seen_at / cleared_at),
 * so the panel never misses faults reported before the machine's first fix. Called by
 * upsertPosition when it created the row; a machine with no fault history is left as is.
 */
export async function seedFaultSummary(ex: Executor, machineId: string): Promise<void> {
  const guard = await newestRowTime(ex, machineId);
  if (!guard) return;
  const active = await activeFaultSummary(ex, machineId);
  await exec(
    ex,
    `update farm.machine_state set fault_codes = $2::jsonb, faults_at = $3::timestamptz
      where machine_id = $1::uuid`,
    [machineId, JSON.stringify(active), guard.toISOString()],
  );
}
