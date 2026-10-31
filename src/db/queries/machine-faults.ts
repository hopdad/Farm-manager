/**
 * The fault writer (slice 1f, fleet-faults; docs/contracts-1f.md §5.3, decisions 1f-2 and 1f-12):
 * `farm.machine_faults` keeps the history (ONE open row per machine, source and code; a code seen
 * again after it cleared opens a new row) and `farm.machine_state.fault_codes` / `faults_at` the
 * current summary the fleet panel shows. Called by `upsertVehicleStat` (./fleet.ts) for a stat
 * that carries `faultCodes`, inside the sync step's per-event transaction, so every vendor's
 * faults land through the same rules:
 *
 *  - `snapshot` reports (Samsara's faultCodes stat; the default): the complete active set at `ts`.
 *    The GUARD is the time of the newest snapshot the SAME source applied for the machine
 *    (`farm.machine_fault_snapshots`, 1f review round 2; none yet = no guard). Per source, so
 *    another source's reports (a delta feed on the same truck) never make a reading look older,
 *    and a mode change to another account deletes the source's guards (the stand-in's readings
 *    must not hide the live account's current codes, which Samsara's first feed call returns with
 *    their original, older times).
 *      newer than the guard: open the codes it names (or refresh their last_seen_at and details),
 *        clear the open codes of this source it no longer names, move the guard, then refresh
 *        machine_state;
 *      not newer: only extend last_seen_at (greatest) of the open rows it names. It never opens,
 *        clears or reopens a code, and never touches machine_state (so an older page can't bring
 *        a cleared code back).
 *  - `delta` reports (Motive, Geotab, AEMP, CNH, Terminal): each fault states its own state and
 *    times; codes not named are unchanged. Per fault, its time is `lastSeenAt` (open) or
 *    `closedAt` (closed), else `ts`: an open item newer than its open row refreshes it, with no
 *    open row it opens one (`first_seen_at` = its `firstSeenAt` when sent) unless its vendor
 *    closed the code at or after that time (a row a mode change closed doesn't count: it says
 *    nothing about the current account); a closed item at or after its open row's last_seen_at
 *    clears it (`cleared_at` = that time); anything older changes nothing. Then machine_state is
 *    refreshed. Every row a delta item opens or refreshes keeps its age-out window
 *    (`machine_faults.age_out_seconds`, decision 1f-12): `faultAgeOutSeconds` for feeds with no
 *    cleared state (24 h), else the 7-day backstop (DELTA_FAULT_BACKSTOP_SECONDS).
 *
 * The age-out (decision 1f-12) is NOT judged against the next report: a fault that stops
 * recurring (the normal "it was fixed" case) has no next report. After each successful faults
 * run the job calls `ageOutFaults` with what the run covered (every machine of the source, a
 * provider or connection, or one machine) and the time it checked them through; an open row
 * whose `last_seen_at + age_out_seconds` is before that time closes (`cleared_at` = the moment
 * its window ran out, so a later sighting opens a new row).
 *
 * A faults stream changing mode (1f review; round 2 for off and back): the job decides what the
 * change means for the codes (src/jobs/fleet-shared.ts `faultsModeAction`) and calls one of
 *  - `closeSourceFaults` (another account: sim ↔ replay ↔ sandbox ↔ live): every open row of the
 *    source closes for good (`closed_by` 'mode'), and so does every row an earlier switch to off
 *    suspended; the source's snapshot guards go. A stand-in's or a fixture's codes never outlive
 *    the mode that raised them, and never hide the new account's;
 *  - `suspendSourceFaults` (turned off): every open row closes as suspended (`closed_by` 'off'),
 *    so no code shows while nothing is checking it; the guards stay;
 *  - `resumeSourceFaults` (back on in the mode it was turned off from): the suspended rows reopen
 *    as they were. The vendor still holds the codes that stayed active and a restarted feed won't
 *    send them again (Geotab's starts from now, Samsara's sends a reading the guard has seen),
 *    while a code that cleared meanwhile is cleared by the next reading or the age-out.
 *
 * Refreshing machine_state: `fault_codes` = the machine's open rows (every source, one entry per
 * code: the worst severity, the earliest `since`), sorted by `sortFaultCodes`; `faults_at` = the
 * newest event time (informational: no longer a guard). When the active set (codes and
 * severities) changed, `fleet`/`invalidate` `{ event: 'machine', reason: 'faults' }` is
 * published in the same transaction, so the panel refetches. A machine with no machine_state row
 * (no fix yet) still gets its machine_faults rows; the first position insert seeds its summary
 * (`seedFaultSummary`, called by upsertPosition).
 *
 * Per-module clearing (fleet-faults; in the contract types since the 1f merge): a snapshot may
 * say which OBD-II control modules it covers (`NormalizedVehicleStat.faultScope`) and each
 * OBD-II fault its `module` (`NormalizedFault.module`). Then an open OBD-II code of a module the report
 * doesn't name is left alone (Samsara lists OBD-II codes per `txId` and doesn't promise every
 * module in each reading); an open OBD-II code with no recorded module counts as covered by any
 * report that names at least one module. Such a code left alone by a newer reading starts its
 * age-out (OBD_UNNAMED_MODULE_AGE_OUT_SECONDS, swept like a delta code): a module that simply
 * drops out of the readings once its codes clear can't keep them open for ever, while a reading
 * that names the code again stops the clock. The mapper sends no scope for a reading whose
 * `obdii.diagnosticTroubleCodes` is an explicit empty list (no module has a code: every OBD-II
 * code clears). The module of each OBD-II code is kept in `farm.machine_faults.module`
 * (migration 0007). Reports without a scope (every other vendor) are plain snapshots.
 *
 * The machine's farm.machines row is locked FOR UPDATE first: a position insert holds a key-share
 * lock on it (the foreign keys of farm.positions / machine_state), so a first fix and a fault
 * report for the same machine never miss each other.
 */
import type { FaultModuleScope, NormalizedVehicleStat } from '../../connectors/types';
import {
  type ActiveFaultCode,
  activeFaultCodeSchema,
  DELTA_FAULT_BACKSTOP_SECONDS,
  type FaultClosedBy,
  type FaultLamps,
  type FaultSeverity,
  type FaultSystem,
  type NormalizedFault,
  normalizedFaultSchema,
  OBD_UNNAMED_MODULE_AGE_OUT_SECONDS,
  type ObdDtcState,
  type OemFaultClass,
  severityRank,
  sortFaultCodes,
} from '../../domain/fault-codes';
import { publish } from '../../platform/realtime/publish';
import { type Executor, exec, toDate } from '../exec';

/**
 * Per-module OBD-II clearing is in the contract types since the 1f merge
 * (`NormalizedFault.module`, `NormalizedVehicleStat.faultScope`); these names stay as aliases.
 */
export type ModuleFault = NormalizedFault;
export type { FaultModuleScope };
export type ScopedVehicleStat = NormalizedVehicleStat;

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
    `select f.id::text as id, f.code, f.system, f.first_seen_at, f.last_seen_at, f.module
       from farm.machine_faults f
      where f.machine_id = $1::uuid and f.source = $2 and f.cleared_at is null`,
    [machineId, source],
  );
  return r.rows;
}

/** Newest event time any machine_faults row of the machine records (seeds `faults_at`). */
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
  ageOutSeconds: number | null,
): Promise<{ id: string; inserted: boolean }> {
  const c = systemColumns(f);
  const vendorFirst = f.firstSeenAt ? new Date(f.firstSeenAt) : null;
  const first = vendorFirst && vendorFirst < seenAt ? vendorFirst : seenAt;
  const r = await exec<{ id: string; inserted: boolean }>(
    ex,
    `insert into farm.machine_faults as mf
       (machine_id, source, code, system, spn, fmi, source_address, occurrence_count, dtc_state,
        oem_class, lamps, severity, vendor_severity, description, first_seen_at, last_seen_at,
        module, age_out_seconds)
     values ($1::uuid, $2, $3, $4, $5::int, $6::int, $7::int, $8::int, $9, $10, $11::jsonb, $12,
             $13, $14, $15::timestamptz, $16::timestamptz, $18, $19::int)
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
           -- The module that named the code last (a report naming none keeps the known one).
           module = coalesce(excluded.module, mf.module),
           oem_class = case when excluded.last_seen_at >= mf.last_seen_at then excluded.oem_class else mf.oem_class end,
           lamps = case when excluded.last_seen_at >= mf.last_seen_at then excluded.lamps else mf.lamps end,
           severity = case when excluded.last_seen_at >= mf.last_seen_at then excluded.severity else mf.severity end,
           vendor_severity = case when excluded.last_seen_at >= mf.last_seen_at
                                  then excluded.vendor_severity else mf.vendor_severity end,
           description = case when excluded.last_seen_at >= mf.last_seen_at
                              then coalesce(excluded.description, mf.description) else mf.description end,
           -- The age-out window of the newest sighting (a snapshot that names the code: none).
           age_out_seconds = case when excluded.last_seen_at >= mf.last_seen_at
                                  then excluded.age_out_seconds else mf.age_out_seconds end,
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
      f.system === 'obd2' && f.module ? f.module : null,
      ageOutSeconds,
    ],
  );
  return r.rows[0] as { id: string; inserted: boolean };
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
  return r.rowCount;
}

/** Is this open row one the snapshot speaks for (per-module OBD-II scope)? */
function inScope(row: OpenRow, scope: FaultModuleScope | undefined): boolean {
  if (!scope || row.system !== 'obd2') return true;
  if (scope.obdModules.length === 0) return false;
  return row.module === null || scope.obdModules.includes(row.module);
}

/** The snapshot guard of one machine and source (null: none applied yet, or a mode change). */
async function snapshotGuard(
  ex: Executor,
  machineId: string,
  source: string,
): Promise<Date | null> {
  const r = await exec<{ t: Date | string }>(
    ex,
    `select reported_at as t from farm.machine_fault_snapshots
      where machine_id = $1::uuid and source = $2`,
    [machineId, source],
  );
  return toDate(r.rows[0]?.t ?? null);
}

async function applySnapshot(
  ex: Executor,
  machineId: string,
  s: ScopedVehicleStat,
  faults: ModuleFault[],
  out: FaultReportResult,
): Promise<boolean> {
  const ts = new Date(s.ts);
  const guard = await snapshotGuard(ex, machineId, s.source);
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
  await exec(
    ex,
    `insert into farm.machine_fault_snapshots as g (machine_id, source, reported_at)
     values ($1::uuid, $2, $3::timestamptz)
     on conflict (machine_id, source) do update
       set reported_at = greatest(g.reported_at, excluded.reported_at), updated_at = now()`,
    [machineId, s.source, ts.toISOString()],
  );
  const open = await openRows(ex, machineId, s.source);
  for (const f of faults) {
    const r = await upsertOpen(ex, machineId, s.source, f, ts, null);
    if (r.inserted) out.opened++;
    else out.refreshed++;
  }
  const named = new Set(faults.map((f) => f.code));
  const notNamed = open.filter((row) => !named.has(row.code));
  const gone = notNamed.filter((row) => inScope(row, s.faultScope));
  out.cleared += await clearRows(
    ex,
    gone.map((row) => row.id),
    ts,
  );
  // OBD-II codes of modules this newer reading left out: kept open, their age-out starts (a
  // reading that names them again resets it through upsertOpen).
  const unnamed = notNamed.filter((row) => !inScope(row, s.faultScope)).map((row) => row.id);
  if (unnamed.length) {
    await exec(
      ex,
      `update farm.machine_faults set age_out_seconds = $2::int, updated_at = now()
        where id = any($1::uuid[]) and cleared_at is null and age_out_seconds is null`,
      [unnamed, OBD_UNNAMED_MODULE_AGE_OUT_SECONDS],
    );
  }
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
  const ageOut =
    s.faultAgeOutSeconds !== undefined && s.faultAgeOutSeconds > 0
      ? Math.round(s.faultAgeOutSeconds)
      : DELTA_FAULT_BACKSTOP_SECONDS;
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
        await upsertOpen(ex, machineId, s.source, f, at, ageOut);
        out.refreshed++;
      }
      continue;
    }
    // No open row: open one, unless its vendor closed the code at or after this sighting (a
    // row a mode change closed says nothing about this account's vendor).
    const closed = await exec<{ t: Date | string | null }>(
      ex,
      `select max(cleared_at) as t from farm.machine_faults
        where machine_id = $1::uuid and source = $2 and code = $3 and cleared_at is not null
          and closed_by is null`,
      [machineId, s.source, f.code],
    );
    const closedAt = toDate(closed.rows[0]?.t ?? null);
    if (closedAt && at.getTime() <= closedAt.getTime()) continue;
    const r = await upsertOpen(ex, machineId, s.source, f, at, ageOut);
    if (r.inserted) out.opened++;
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
    await exec<{ fault_codes: unknown }>(
      ex,
      `select fault_codes from farm.machine_state where machine_id = $1::uuid for update`,
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
    touchState = await applySnapshot(ex, machineId, s, faults, out);
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
 * machine_faults rows and `faults_at` from the newest last_seen_at / cleared_at, so the panel
 * never misses faults reported before the machine's first fix. Called by
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

// ---- closing codes no report will close: the age-out sweep and a mode change ----------------

/**
 * What one successful faults run covered, for `ageOutFaults`: the machines of the source it
 * checked and the time it checked them through. An entry with neither `sourceOrg` nor
 * `externalId` covers every machine of the source (one call lists the whole fleet: Samsara's
 * feed, Motive's list, Geotab's feed); `sourceOrg` alone covers the machines whose
 * ingest.external_refs row has that source_org (a Terminal connection); `externalId` (with
 * `sourceOrg` when ids repeat across orgs) one machine (an AEMP provider's machine, a CNH VIN).
 */
export interface FaultCoverage {
  sourceOrg?: string;
  externalId?: string;
  through: Date;
}

export interface FaultCloseResult {
  /** Rows closed. */
  cleared: number;
  /** Machines whose active set changed (each published one `fleet`/`invalidate`). */
  changed: number;
}

/**
 * Lock one machine (the order every fault writer uses: farm.machines, then machine_state), run
 * `change` for it (it returns the rows it closed or reopened), then refresh
 * `machine_state.fault_codes` when something changed. `faults_at` is NOT moved: it is the vendor
 * time of the newest report, and a wall-clock close must not make the next report look older.
 */
async function changeForMachine(
  ex: Executor,
  machineId: string,
  change: () => Promise<number>,
  out: { changed: number },
): Promise<number> {
  await exec(ex, 'select 1 from farm.machines where id = $1::uuid for update', [machineId]);
  const st = (
    await exec<{ fault_codes: unknown }>(
      ex,
      'select fault_codes from farm.machine_state where machine_id = $1::uuid for update',
      [machineId],
    )
  ).rows[0];
  const n = await change();
  if (!n || !st) return n;
  const active = await activeFaultSummary(ex, machineId);
  await exec(
    ex,
    `update farm.machine_state set fault_codes = $2::jsonb, updated_at = now()
      where machine_id = $1::uuid`,
    [machineId, JSON.stringify(active)],
  );
  if (faultSetChanged(parseStoredFaults(st.fault_codes), active)) {
    out.changed++;
    await publish('fleet', 'invalidate', { event: 'machine', reason: 'faults' }, ex);
  }
  return n;
}

/**
 * The age-out sweep (decision 1f-12): close every open row of `source` on the covered machines
 * whose window (`age_out_seconds`) ran out before the time its machine was checked through.
 * `cleared_at` = the moment the window ran out (`last_seen_at + age_out_seconds`), so a sighting
 * after it opens a new row and one before it changes nothing. Rows with no window (snapshot
 * codes their vendor still lists) are never touched. Run it in one transaction; machines are
 * locked in id order.
 */
export async function ageOutFaults(
  ex: Executor,
  source: string,
  coverage: readonly FaultCoverage[],
): Promise<FaultCloseResult> {
  const out: FaultCloseResult = { cleared: 0, changed: 0 };
  if (!coverage.length) return out;
  const cov = coverage.map((c) => ({
    org: c.sourceOrg ?? null,
    ext: c.externalId ?? null,
    through: c.through.toISOString(),
  }));
  const due = await exec<{ machine_id: string; through: Date | string }>(
    ex,
    `with cov as (
       select * from jsonb_to_recordset($2::jsonb) as c(org text, ext text, through timestamptz)
     ), checked as (
       select f.machine_id, max(c.through) as through
         from (select distinct machine_id from farm.machine_faults
                where source = $1 and cleared_at is null and age_out_seconds is not null) f
         join cov c
           on (c.org is null and c.ext is null)
           or exists (select 1 from ingest.external_refs r
                       where r.source = $1 and r.kind = 'machine' and r.entity_id = f.machine_id
                         and (c.org is null or r.source_org = c.org)
                         and (c.ext is null or r.external_id = c.ext))
        group by f.machine_id
     )
     select k.machine_id::text as machine_id, k.through
       from checked k
      where exists (select 1 from farm.machine_faults f
                     where f.machine_id = k.machine_id and f.source = $1 and f.cleared_at is null
                       and f.age_out_seconds is not null
                       and f.last_seen_at + make_interval(secs => f.age_out_seconds) < k.through)
      order by k.machine_id`,
    [source, JSON.stringify(cov)],
  );
  for (const row of due.rows) {
    const through = toDate(row.through) as Date;
    out.cleared += await changeForMachine(
      ex,
      row.machine_id,
      async () =>
        (
          await exec(
            ex,
            `update farm.machine_faults
                set cleared_at = greatest(last_seen_at + make_interval(secs => age_out_seconds),
                                          first_seen_at),
                    updated_at = now()
              where machine_id = $1::uuid and source = $2 and cleared_at is null
                and age_out_seconds is not null
                and last_seen_at + make_interval(secs => age_out_seconds) < $3::timestamptz`,
            [row.machine_id, source, through.toISOString()],
          )
        ).rowCount,
      out,
    );
  }
  return out;
}

/** Machines with rows of `source` matching `where` (id order: the lock order of every writer). */
async function machinesWith(ex: Executor, source: string, where: string): Promise<string[]> {
  const r = await exec<{ machine_id: string }>(
    ex,
    `select distinct machine_id::text as machine_id from farm.machine_faults
      where source = $1 and ${where} order by 1`,
    [source],
  );
  return r.rows.map((row) => row.machine_id);
}

/** Close the open rows of `source` on every machine with one, marking them `closedBy`. */
async function closeOpenRows(
  ex: Executor,
  source: string,
  closedBy: FaultClosedBy,
): Promise<FaultCloseResult> {
  const out: FaultCloseResult = { cleared: 0, changed: 0 };
  for (const machineId of await machinesWith(ex, source, 'cleared_at is null')) {
    out.cleared += await changeForMachine(
      ex,
      machineId,
      async () =>
        (
          await exec(
            ex,
            `update farm.machine_faults
                set cleared_at = greatest(last_seen_at, first_seen_at), closed_by = $3,
                    updated_at = now()
              where machine_id = $1::uuid and source = $2 and cleared_at is null`,
            [machineId, source, closedBy],
          )
        ).rowCount,
      out,
    );
  }
  return out;
}

/**
 * The faults stream of `source` moved to another account (sim, replay, sandbox, live): close
 * every open row for good (`closed_by` 'mode', `cleared_at` = the row's `last_seen_at`, the last
 * moment that mode vouched for it), turn the rows an earlier switch to off suspended into 'mode'
 * too, and delete the source's snapshot guards, so the new account's first readings (Samsara
 * returns each vehicle's latest one with its original time) and sightings (a delta item older than
 * the close) all open their codes.
 */
export async function closeSourceFaults(ex: Executor, source: string): Promise<FaultCloseResult> {
  const out = await closeOpenRows(ex, source, 'mode');
  await exec(
    ex,
    `update farm.machine_faults set closed_by = 'mode', updated_at = now()
      where source = $1 and closed_by = 'off'`,
    [source],
  );
  // After the per-machine closes (machine row, then guard: the writers' lock order).
  await exec(ex, 'delete from farm.machine_fault_snapshots where source = $1', [source]);
  return out;
}

/**
 * The faults stream of `source` was turned off: close every open row as suspended (`closed_by`
 * 'off'), so the screens show no code nothing is checking any more. The snapshot guards stay:
 * the same mode coming back (`resumeSourceFaults`) continues where it stopped.
 */
export function suspendSourceFaults(ex: Executor, source: string): Promise<FaultCloseResult> {
  return closeOpenRows(ex, source, 'off');
}

export interface FaultReopenResult {
  /** Rows reopened. */
  reopened: number;
  /** Machines whose active set changed (each published one `fleet`/`invalidate`). */
  changed: number;
}

/**
 * The faults stream of `source` is back on in the mode it was turned off from: reopen the rows
 * the switch to off suspended, as they were (times, details, age-out window). The vendor still
 * holds the codes that stayed active, and a restarted feed won't send them again; one that
 * cleared meanwhile clears with the next reading (snapshot) or its closed record / the age-out
 * (delta). A suspended row whose code has an open row again stays closed (as 'mode').
 */
export async function resumeSourceFaults(ex: Executor, source: string): Promise<FaultReopenResult> {
  const out: FaultReopenResult = { reopened: 0, changed: 0 };
  for (const machineId of await machinesWith(ex, source, `closed_by = 'off'`)) {
    out.reopened += await changeForMachine(
      ex,
      machineId,
      async () => {
        const r = await exec(
          ex,
          `with pick as (
             select distinct on (code) id from farm.machine_faults
              where machine_id = $1::uuid and source = $2 and closed_by = 'off'
              order by code, last_seen_at desc, id
           )
           update farm.machine_faults f
              set cleared_at = null, closed_by = null, updated_at = now()
             from pick
            where f.id = pick.id
              and not exists (select 1 from farm.machine_faults o
                               where o.machine_id = f.machine_id and o.source = f.source
                                 and o.code = f.code and o.cleared_at is null)`,
          [machineId, source],
        );
        await exec(
          ex,
          `update farm.machine_faults set closed_by = 'mode', updated_at = now()
            where machine_id = $1::uuid and source = $2 and closed_by = 'off'`,
          [machineId, source],
        );
        return r.rowCount;
      },
      out,
    );
  }
  return out;
}
