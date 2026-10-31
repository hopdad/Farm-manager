/**
 * The CNH FieldOps polls of fleet.cnh (docs/contracts-1f.md §B.4.8): three streams over one
 * client, each with its own JSON cursor in ingest.sync_state.
 *
 *   positions  per VIN, the Locations series since its last fix (a first poll looks back 15 min):
 *              LIVE fixes
 *   fleet      the Fleet/{page} snapshot, at most hourly (CNH: "a delay of up to one hour"): stats
 *              and the LAST-KNOWN Location, diffed per VIN and section (only what moved lands)
 *   faults     per VIN, CautionCodes and Faults since the last window (a first one looks back a
 *              day), at most every 5 min
 *
 * The VIN list comes from GET /equipment (it answers without the EULA), refreshed every 15 min and
 * kept in each cursor with each VIN's company (the external_refs source_org; an item without one
 * takes the user's only company from GET /companies). A VIN whose telemetry answers 403 "EULA
 * not accepted" is skipped and listed (`needsEula`, retried hourly), never the connection; the
 * job writes the list to the stream's sync_state.extra for /admin/connectors. If the whole
 * /Fleet page answers the EULA 403 (unconfirmed whether one VIN can fail the page: doc-derived),
 * the snapshot is read per VIN from /Fleet/Equipment/{vin}.
 */

import { diffSnapshotSections, type SnapshotMachine } from '../aemp/client';
import type { AempFleetPage } from '../aemp/parse';
import { VendorHttpError } from '../http';
import type { PollResult, RawItem } from '../types';
import { type CnhClient, CnhEulaError } from './client';
import type { CnhFaultRaw, CnhFleetRaw, CnhPositionRaw } from './mapper';

export const CNH_EQUIPMENT_REFRESH_MS = 15 * 60_000;
export const CNH_FIRST_LOOKBACK_MS = 15 * 60_000;
/** The widest Locations window asked for (CNH documents no maximum: doc-derived). */
export const CNH_MAX_LOCATIONS_WINDOW_MS = 24 * 3_600_000;
export const CNH_FLEET_MIN_INTERVAL_MS = 3_600_000;
export const CNH_FAULTS_MIN_INTERVAL_MS = 5 * 60_000;
export const CNH_FAULTS_FIRST_LOOKBACK_MS = 24 * 3_600_000;
export const CNH_MAX_FAULTS_WINDOW_MS = 7 * 86_400_000;
export const CNH_EULA_RETRY_MS = 3_600_000;
/** A stream counts as due this much before its interval is up (scheduler jitter). */
const SLACK_MS = 10_000;

export interface CnhMachineRef {
  vin: string;
  companyId: string;
}

export interface CnhNeedsEula {
  reason: string;
  /** When the refusal was seen (UTC ISO); the VIN is tried again an hour later. */
  at: string;
}

interface CnhBaseCursor {
  v: 1;
  listedAt?: string;
  machines?: CnhMachineRef[];
  needsEula?: Record<string, CnhNeedsEula>;
}
export interface CnhPositionsCursor extends CnhBaseCursor {
  lastFix?: Record<string, string>;
}
export interface CnhFleetCursor extends CnhBaseCursor {
  polledAt?: string;
  seen?: string;
}
export interface CnhFaultsCursor extends CnhBaseCursor {
  polledAt?: string;
  until?: Record<string, string>;
}

export function parseCnhCursor<T extends CnhBaseCursor>(cursor: string | null): T {
  if (cursor?.startsWith('{')) {
    try {
      const v = JSON.parse(cursor) as Partial<T>;
      if (v.v === 1) return v as T;
    } catch {
      // start over
    }
  }
  return { v: 1 } as T;
}

export interface CnhPollResult<T> extends PollResult<RawItem<T>> {
  /** VINs whose EULA refusal was first seen in this poll (log each once). */
  newlyNeedsEula: string[];
  /** Machines skipped for another reason (no company, unknown VIN), for the log. */
  skipped: { vin: string; reason: string }[];
}

export interface CnhPollOptions {
  /** The job's clock (wall time). */
  now: () => Date;
  /** Stop starting new VINs after this (the job's deadline). */
  deadline?: Date;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The VIN list (cached in the cursor for CNH_EQUIPMENT_REFRESH_MS). */
async function machinesOf(
  client: CnhClient,
  cur: CnhBaseCursor,
  now: number,
  skipped: CnhPollResult<unknown>['skipped'],
): Promise<CnhMachineRef[]> {
  const listed = Date.parse(cur.listedAt ?? '');
  if (cur.machines && Number.isFinite(listed) && now - listed < CNH_EQUIPMENT_REFRESH_MS) {
    return cur.machines;
  }
  const { items } = await client.equipment();
  const needCompany = items.some((i) => !i.companyId);
  const companies = needCompany ? await client.companies() : [];
  const only = companies.length === 1 ? (companies[0]?.id ?? null) : null;
  const machines: CnhMachineRef[] = [];
  for (const i of items) {
    const companyId = i.companyId ?? only;
    if (companyId) machines.push({ vin: i.vin, companyId });
    else
      skipped.push({
        vin: i.vin,
        reason: 'no company (GET /equipment names none, and the user has several)',
      });
  }
  cur.machines = machines;
  cur.listedAt = iso(now);
  return machines;
}

function eulaBlocked(cur: CnhBaseCursor, vin: string, now: number): boolean {
  const e = cur.needsEula?.[vin];
  return !!e && now - Date.parse(e.at) < CNH_EULA_RETRY_MS;
}

function markEula(cur: CnhBaseCursor, e: CnhEulaError, now: number, newly: string[]): void {
  cur.needsEula ??= {};
  if (!cur.needsEula[e.vin]) newly.push(e.vin);
  cur.needsEula[e.vin] = { reason: e.message, at: iso(now) };
}

function clearEula(cur: CnhBaseCursor, vin: string): void {
  if (cur.needsEula?.[vin]) delete cur.needsEula[vin];
}

const pastDeadline = (opts: CnhPollOptions) =>
  !!opts.deadline && opts.now().getTime() >= opts.deadline.getTime();

/**
 * Run `fn` for one VIN; a EULA refusal skips (and lists) it, a 404 skips it, anything else (a
 * key or token refusal, a 429, an outage) fails the poll.
 */
async function perVin<T>(
  cur: CnhBaseCursor,
  vin: string,
  now: number,
  out: CnhPollResult<T>,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    clearEula(cur, vin);
  } catch (e) {
    if (e instanceof CnhEulaError) markEula(cur, e, now, out.newlyNeedsEula);
    else if (e instanceof VendorHttpError && e.status === 404) {
      out.skipped.push({ vin, reason: 'CNH answered 404 for this VIN' });
    } else throw e;
  }
}

/** cnh / positions: the Locations trail of every VIN since its last fix. */
export async function pollCnhPositions(
  client: CnhClient,
  cursor: string | null,
  opts: CnhPollOptions,
): Promise<CnhPollResult<CnhPositionRaw>> {
  const now = opts.now().getTime();
  const cur = parseCnhCursor<CnhPositionsCursor>(cursor);
  const out: CnhPollResult<CnhPositionRaw> = {
    items: [],
    cursor: '',
    newlyNeedsEula: [],
    skipped: [],
  };
  const machines = await machinesOf(client, cur, now, out.skipped);
  const lastFix: Record<string, string> = {};
  for (const m of machines) if (cur.lastFix?.[m.vin]) lastFix[m.vin] = cur.lastFix[m.vin] as string;
  for (const m of machines) {
    if (eulaBlocked(cur, m.vin, now)) continue;
    if (pastDeadline(opts)) break;
    const last = Date.parse(lastFix[m.vin] ?? '');
    const start = Math.max(
      Number.isFinite(last) ? last : now - CNH_FIRST_LOOKBACK_MS,
      now - CNH_MAX_LOCATIONS_WINDOW_MS,
    );
    await perVin(cur, m.vin, now, out, async () => {
      for (const location of await client.locations(m.vin, start, now)) {
        out.items.push({
          externalId: `${m.vin}:${location.datetime}`,
          payload: { vin: m.vin, companyId: m.companyId, location },
        });
        if (!lastFix[m.vin] || location.datetime > (lastFix[m.vin] as string)) {
          lastFix[m.vin] = location.datetime;
        }
      }
    });
  }
  cur.lastFix = lastFix;
  out.cursor = JSON.stringify(cur);
  return out;
}

/** cnh / fleet: the snapshot, at most hourly, only the sections that moved. */
export async function pollCnhFleet(
  client: CnhClient,
  cursor: string | null,
  opts: CnhPollOptions,
): Promise<CnhPollResult<CnhFleetRaw>> {
  const now = opts.now().getTime();
  const cur = parseCnhCursor<CnhFleetCursor>(cursor);
  const out: CnhPollResult<CnhFleetRaw> = {
    items: [],
    cursor: cursor ?? '',
    newlyNeedsEula: [],
    skipped: [],
  };
  const polled = Date.parse(cur.polledAt ?? '');
  if (Number.isFinite(polled) && now - polled < CNH_FLEET_MIN_INTERVAL_MS - SLACK_MS) return out;
  const machines = await machinesOf(client, cur, now, out.skipped);
  const companyOf = new Map(machines.map((m) => [m.vin, m.companyId]));
  let snapshot: SnapshotMachine[];
  try {
    const page = await client.fleetSnapshot();
    snapshot = page.machines.map((m) => ({ ...m, snapshotTime: page.snapshotTime }));
  } catch (e) {
    const eulaPage =
      e instanceof VendorHttpError && e.status === 403 && /EULA/i.test(e.detail ?? '');
    if (!eulaPage) throw e;
    // doc-derived, confirm: one VIN without the EULA may fail the whole page; read per VIN.
    snapshot = [];
    for (const m of machines) {
      if (eulaBlocked(cur, m.vin, now)) continue;
      await perVin(cur, m.vin, now, out, async () => {
        const page: AempFleetPage = await client.fleetEquipment(m.vin);
        snapshot.push(...page.machines.map((x) => ({ ...x, snapshotTime: page.snapshotTime })));
      });
    }
  }
  const known = snapshot.filter((m) => {
    if (companyOf.has(m.id)) return true;
    out.skipped.push({ vin: m.id, reason: 'in the Fleet snapshot but not in GET /equipment' });
    return false;
  });
  const diff = await diffSnapshotSections('', known, cur.seen ?? null);
  for (const { machine, equipment, latest } of diff.changed) {
    out.items.push({
      externalId: `${machine.id}@${new Date(latest).toISOString()}`,
      payload: {
        vin: machine.id,
        companyId: companyOf.get(machine.id) as string,
        snapshotTime: machine.snapshotTime,
        equipment,
      },
    });
  }
  cur.seen = diff.cursor;
  cur.polledAt = iso(now);
  out.cursor = JSON.stringify(cur);
  return out;
}

/** cnh / faults: CautionCodes and Faults of every VIN since its last window, every 5 min. */
export async function pollCnhFaults(
  client: CnhClient,
  cursor: string | null,
  opts: CnhPollOptions,
): Promise<CnhPollResult<CnhFaultRaw>> {
  const now = opts.now().getTime();
  const cur = parseCnhCursor<CnhFaultsCursor>(cursor);
  const out: CnhPollResult<CnhFaultRaw> = {
    items: [],
    cursor: cursor ?? '',
    newlyNeedsEula: [],
    skipped: [],
  };
  const polled = Date.parse(cur.polledAt ?? '');
  if (Number.isFinite(polled) && now - polled < CNH_FAULTS_MIN_INTERVAL_MS - SLACK_MS) return out;
  const machines = await machinesOf(client, cur, now, out.skipped);
  const until: Record<string, string> = {};
  for (const m of machines) if (cur.until?.[m.vin]) until[m.vin] = cur.until[m.vin] as string;
  let complete = true;
  for (const m of machines) {
    if (eulaBlocked(cur, m.vin, now)) continue;
    if (pastDeadline(opts)) {
      complete = false;
      break;
    }
    const last = Date.parse(until[m.vin] ?? '');
    const start = Math.max(
      Number.isFinite(last) ? last : now - CNH_FAULTS_FIRST_LOOKBACK_MS,
      now - CNH_MAX_FAULTS_WINDOW_MS,
    );
    const base = { vin: m.vin, companyId: m.companyId };
    await perVin(cur, m.vin, now, out, async () => {
      for (const caution of await client.cautionCodes(m.vin, start, now)) {
        out.items.push({
          externalId: `${m.vin}:caution:${caution.Identifier}:${caution.datetime}:${caution.Active ?? ''}`,
          payload: { ...base, kind: 'caution', caution },
        });
      }
      for (const fault of await client.faultCodes(m.vin, start, now)) {
        out.items.push({
          externalId: `${m.vin}:fault:${fault.CodeIdentifier}:${fault.datetime}`,
          payload: { ...base, kind: 'fault', fault },
        });
      }
      until[m.vin] = iso(now);
    });
  }
  cur.until = until;
  if (complete) cur.polledAt = iso(now);
  out.cursor = JSON.stringify(cur);
  return out;
}
