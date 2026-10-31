/**
 * Fleet queries shared by the fleet.* jobs (their batched `fleet.tick`) and GET /api/fleet
 * (contracts §7): one builder, so a tick and the snapshot always agree.
 *
 *  - `fleetSnapshot()`: every non-retired machine with a known state, as MachineView[], with
 *    `stale` computed at build time from the fix's wall-clock `ts` and the threshold for its
 *    position source (FLEET_STALE_SECONDS, or FLEET_STALE_SECONDS_DEERE for Deere fixes).
 *  - `upsertPosition()`: one fix → farm.positions (PK (machine_id, ts): duplicates are no-ops)
 *    and farm.machine_state (only when the fix is newer, so out-of-order pages never move a
 *    machine back), with the fix's vendor id (`position_vendor`: `positionVendorId(source,
 *    provider)`, 1f.2) and kind. A `last_known` fix (a vendor snapshot: AEMP, Terminal's latest
 *    location) updates machine_state only: never farm.positions (it isn't a trail point), so it
 *    never reports `inserted` and never runs geofence detection. The current field and the
 *    activity are derived in PostGIS:
 *      deere_working → working; inside an elevator geofence below 5 mph → queued;
 *      >= 3 mph → transport; else idle.
 *    The first insert of a machine's machine_state row seeds its fault summary from the open
 *    farm.machine_faults rows (1f, `seedFaultSummary`), so faults seen before the first fix show.
 *  - `upsertVehicleStat()` (1f, fleet-faults; docs/contracts-1f.md §5.3), one stat of any
 *    telematics source:
 *      engine hours / odometer → farm.machines, never decreasing (`greatest()`), and appended to
 *        farm.machine_hours (source = the stat's source, ts = its vendor time);
 *      fuel and DEF → machine_state, only from a stat at or after `stats_at` (the time guard: an
 *        older reading never moves them back), which then moves to the stat's time;
 *      engineOn → machine_state.engine_on when the stat is newer than the state's fix;
 *      faultCodes → the fault writer (./machine-faults.ts: farm.machine_faults history, the
 *        machine_state summary under `faults_at`, both report kinds, the delta age-out).
 *    `readings` stay in ingest.raw_events only (no column stores them).
 *  - `fleetPanelMachines()` / `setMachineStatus()`: the fleet panel (M1 1a; 1f: faults, the
 *    vendor badge, the stats, "not reported") and marking a machine down or back up (publishes
 *    `fleet`/`machine` + `fleet`/`invalidate`).
 */

import type { NormalizedPosition, NormalizedVehicleStat } from '../../connectors/types';
import { faultsNotReported, statsNotReported } from '../../connectors/vendors';
import {
  DEFAULT_STALE_AFTER_SECONDS,
  type FleetTick,
  isMachineStale,
  isPositionVendor,
  type MachineView,
  normalizeHeading,
  type PositionKind,
  positionVendorId,
  type StaleThresholds,
  staleThresholds,
} from '../../domain/fleet';
import { publish } from '../../platform/realtime/publish';
import type { MachineStatusPayload } from '../../platform/realtime/types';
import type { PanelMachine, PanelPlace, PanelPosition } from '../../ui/fleet/contract';
import type { Db } from '../client';
import { type Executor, exec, toDate } from '../exec';
import { applyFaultReport, parseStoredFaults, seedFaultSummary } from './machine-faults';

/** Speeds (mph) behind the derived activity. */
export const TRANSPORT_MIN_MPH = 3;
export const QUEUED_MAX_MPH = 5;

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const round1 = (v: number) => Math.round(v * 10) / 10;

interface SnapshotRow {
  id: string;
  unit_no: string;
  kind: MachineView['kind'];
  status: MachineView['status'];
  lng: number;
  lat: number;
  heading: number | null;
  speed_mph: number | null;
  activity: MachineView['activity'];
  field_id: string | null;
  position_source: MachineView['positionSource'];
  position_kind: PositionKind | null;
  ts: Date | string;
}

/** MachineView of every non-retired machine that has a position, ordered by unit number. */
export async function fleetMachines(
  ex: Executor,
  now: Date,
  stale: number | StaleThresholds,
): Promise<MachineView[]> {
  const r = await exec<SnapshotRow>(
    ex,
    `select m.id::text as id, m.unit_no, m.kind, m.status,
            extensions.ST_X(s.geom) as lng, extensions.ST_Y(s.geom) as lat,
            s.heading, s.speed_mph, s.activity, s.current_field_id::text as field_id,
            s.position_source, s.position_kind, s.ts
       from farm.machines m
       join farm.machine_state s on s.machine_id = m.id
      where m.status <> 'retired'
      order by m.unit_no, m.id`,
  );
  return r.rows.map((row) => {
    const ts = (toDate(row.ts) as Date).toISOString();
    const positionKind = row.position_kind ?? 'live';
    return {
      id: row.id,
      unitNo: row.unit_no,
      kind: row.kind,
      lng: round6(Number(row.lng)),
      lat: round6(Number(row.lat)),
      heading: round1(normalizeHeading(row.heading)) % 360,
      speedMph: round1(Math.max(0, Number(row.speed_mph ?? 0))),
      activity: row.activity,
      fieldId: row.field_id,
      positionSource: row.position_source,
      // Only said for snapshots, so a tick of live fixes stays as small as before (1f.2).
      ...(positionKind === 'last_known' ? { positionKind } : {}),
      ts,
      status: row.status,
      stale: isMachineStale({ ts, positionSource: row.position_source, positionKind }, now, stale),
    };
  });
}

/** The FleetTick body (realtime `fleet`/`tick` and GET /api/fleet). */
export async function fleetSnapshot(
  ex: Executor,
  now: Date,
  stale: number | StaleThresholds,
): Promise<FleetTick> {
  return { ts: now.toISOString(), machines: await fleetMachines(ex, now, stale) };
}

/** The stale thresholds from config (FLEET_STALE_SECONDS / _DEERE / _LAST_KNOWN). */
export function staleThresholdsOf(cfg: {
  FLEET_STALE_SECONDS: number;
  FLEET_STALE_SECONDS_DEERE: number;
  FLEET_STALE_SECONDS_LAST_KNOWN?: number;
}): StaleThresholds {
  return {
    staleAfterSeconds: cfg.FLEET_STALE_SECONDS,
    deereStaleAfterSeconds: cfg.FLEET_STALE_SECONDS_DEERE,
    ...(cfg.FLEET_STALE_SECONDS_LAST_KNOWN
      ? { lastKnownStaleAfterSeconds: cfg.FLEET_STALE_SECONDS_LAST_KNOWN }
      : {}),
  };
}

export interface UpsertPositionResult {
  /** A new farm.positions row (false: that (machine, ts) was already stored). */
  inserted: boolean;
  /** farm.machine_state moved to this fix (false: the state already had a newer fix). */
  stateUpdated: boolean;
}

/**
 * Store one fix for `machineId` (already resolved through ingest.external_refs).
 *
 * Precedence (1f.2, decision 1f-11): a newer fix moves machine_state, except that a
 * `last_known` snapshot never replaces a FRESH live fix. It moves the state only when the
 * state is itself last-known, or when the live fix was already stale when the snapshot was
 * taken (older than the snapshot by more than the live fix's stale threshold, `stale`: the
 * FLEET_STALE_SECONDS / _DEERE pair; default 600 s). So a machine on both a live feed and a
 * snapshot feed (the RoGator on Samsara's equipment feed and on Samsara's AEMP feed; a Terminal
 * truck's latest location and its history) keeps its live badge and threshold while the live
 * feed works, and falls back to the snapshot once it doesn't. A live fix always wins when newer.
 */
export async function upsertPosition(
  ex: Executor,
  machineId: string,
  p: NormalizedPosition,
  stale: number | StaleThresholds = DEFAULT_STALE_AFTER_SECONDS,
): Promise<UpsertPositionResult> {
  const th = staleThresholds(stale);
  const heading = p.heading === null ? null : normalizeHeading(p.heading);
  const speed = p.speedMph === null ? null : Math.max(0, p.speedMph);
  const kind: PositionKind = p.positionKind ?? 'live';
  const vendor = positionVendorId(p.source, p.provider);
  const ins =
    kind === 'live'
      ? await exec(
          ex,
          `insert into farm.positions (machine_id, ts, geom, speed_mph, heading, engine_on, source)
           values ($1::uuid, $2::timestamptz,
                   extensions.ST_SetSRID(extensions.ST_MakePoint($3::float8, $4::float8), 4326),
                   $5::float8, $6::float8, $7::boolean, $8)
           on conflict (machine_id, ts) do nothing`,
          [machineId, p.ts, p.lng, p.lat, speed, heading, p.engineOn, p.source],
        )
      : { rowCount: 0 };
  const st = await exec(
    ex,
    `with pt as (
       select extensions.ST_SetSRID(extensions.ST_MakePoint($3::float8, $4::float8), 4326) as g
     )
     insert into farm.machine_state as ms
       (machine_id, ts, geom, speed_mph, heading, activity, current_field_id, engine_on,
        position_source, position_vendor, position_kind, updated_at)
     select $1::uuid, $2::timestamptz, pt.g, $5::float8, $6::float8,
            case
              when $8 = 'deere_working' then 'working'
              when coalesce($5::float8, 0) < ${QUEUED_MAX_MPH} and exists (
                select 1 from farm.geofences gf
                 where gf.active and gf.kind = 'elevator' and extensions.ST_Intersects(gf.geom, pt.g)
              ) then 'queued'
              when coalesce($5::float8, 0) >= ${TRANSPORT_MIN_MPH} then 'transport'
              else 'idle'
            end,
            (select b.field_id from farm.current_boundaries b
               join farm.fields f on f.id = b.field_id and f.active
              where extensions.ST_Intersects(b.geom, pt.g)
              order by b.field_id
              limit 1),
            $7::boolean, $8, $9, $10, now()
       from pt
     on conflict (machine_id) do update
       set ts = excluded.ts, geom = excluded.geom, speed_mph = excluded.speed_mph,
           heading = excluded.heading, activity = excluded.activity,
           current_field_id = excluded.current_field_id,
           engine_on = coalesce(excluded.engine_on, ms.engine_on),
           position_source = excluded.position_source,
           position_vendor = excluded.position_vendor,
           position_kind = excluded.position_kind, updated_at = now()
     where ms.ts < excluded.ts
       and (excluded.position_kind = 'live'
            or ms.position_kind = 'last_known'
            or ms.ts < excluded.ts - make_interval(secs => case
                 when ms.position_source = 'deere_working' then $12::float8 else $11::float8 end))
     returning (xmax = 0) as created`,
    [
      machineId,
      p.ts,
      p.lng,
      p.lat,
      speed,
      heading,
      p.engineOn,
      p.positionSource,
      vendor,
      kind,
      th.staleAfterSeconds,
      th.deereStaleAfterSeconds,
    ],
  );
  // The machine's first state row: seed its fault summary from what machine_faults holds open.
  const created = (st.rows[0] as { created?: boolean } | undefined)?.created === true;
  if (created) await seedFaultSummary(ex, machineId);
  return { inserted: ins.rowCount === 1, stateUpdated: st.rowCount === 1 };
}

/** A counter worth storing: finite and not negative (machine_hours CHECKs `>= 0`). */
const counter = (v: number | undefined): number | null =>
  v !== undefined && Number.isFinite(v) && v >= 0 ? v : null;
/** A level worth storing: finite, clamped to 0-100. */
const level = (v: number | undefined): number | null =>
  v !== undefined && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;

/**
 * Store one stat of any telematics source for `machineId` (resolved through
 * ingest.external_refs): hours and odometer (never decreasing, plus a farm.machine_hours row),
 * fuel and DEF under the `stats_at` guard, the engine state, and fault codes (the module doc).
 */
export async function upsertVehicleStat(
  ex: Executor,
  machineId: string,
  s: NormalizedVehicleStat,
): Promise<void> {
  const hours = counter(s.engineHours);
  const odometer = counter(s.odometerMi);
  if (hours !== null || odometer !== null) {
    await exec(
      ex,
      `update farm.machines
          set engine_hours = case when $2::numeric is null then engine_hours
                                  else greatest(coalesce(engine_hours, $2::numeric), $2::numeric) end,
              odometer_mi = case when $3::numeric is null then odometer_mi
                                 else greatest(coalesce(odometer_mi, $3::numeric), $3::numeric) end,
              updated_at = now()
        where id = $1::uuid`,
      [machineId, hours, odometer],
    );
    // The reading's history (append-only: a value once stored never changes; a reading of the
    // other counter at the same vendor time, which Samsara sends as its own event, fills the
    // empty column of that row).
    await exec(
      ex,
      `insert into farm.machine_hours as mh (machine_id, ts, engine_hours, odometer_mi, source)
       values ($1::uuid, $2::timestamptz, $3::numeric, $4::numeric, $5)
       on conflict (machine_id, source, ts) do update
         set engine_hours = coalesce(mh.engine_hours, excluded.engine_hours),
             odometer_mi = coalesce(mh.odometer_mi, excluded.odometer_mi)
       where (mh.engine_hours is null and excluded.engine_hours is not null)
          or (mh.odometer_mi is null and excluded.odometer_mi is not null)`,
      [machineId, s.ts, hours, odometer, s.source],
    );
  }
  const fuel = level(s.fuelPct);
  const def = level(s.defPct);
  if (fuel !== null || def !== null) {
    // The time guard (fuel and DEF share stats_at): a stat older than the one the state holds
    // never moves a level back; equal times pass, so two stats of one instant both land.
    await exec(
      ex,
      `update farm.machine_state
          set fuel_pct = coalesce($2::float8, fuel_pct),
              def_pct = coalesce($3::float8, def_pct),
              stats_at = greatest(coalesce(stats_at, $4::timestamptz), $4::timestamptz),
              updated_at = now()
        where machine_id = $1::uuid and (stats_at is null or stats_at <= $4::timestamptz)`,
      [machineId, fuel, def, s.ts],
    );
  }
  if (s.engineOn !== undefined) {
    await exec(
      ex,
      `update farm.machine_state set engine_on = $2::boolean, updated_at = now()
        where machine_id = $1::uuid and ts < $3::timestamptz`,
      [machineId, s.engineOn, s.ts],
    );
  }
  await applyFaultReport(ex, machineId, s);
}

// ---------------------------------------------------------------------------------------------
// The fleet panel (M1 1a): every machine with its down state and the geofence it is in, and
// marking a machine down / back up from a phone.
// ---------------------------------------------------------------------------------------------

interface PanelRow {
  id: string;
  unit_no: string;
  kind: PanelMachine['kind'];
  make: string | null;
  model: string | null;
  engine_hours: string | number | null;
  odometer_mi: string | number | null;
  telematics_via: string | null;
  kind_set_by: NonNullable<PanelMachine['kindSetBy']>;
  status: PanelMachine['status'];
  down_reason: string | null;
  down_at: Date | string | null;
  down_by: string | null;
  lng: number | null;
  lat: number | null;
  heading: number | null;
  speed_mph: number | null;
  activity: PanelPosition['activity'] | null;
  position_source: PanelPosition['positionSource'] | null;
  position_vendor: string | null;
  position_kind: PositionKind | null;
  fuel_pct: number | null;
  def_pct: number | null;
  fault_codes: unknown;
  ts: Date | string | null;
  field_id: string | null;
  field_name: string | null;
  place_id: string | null;
  place_name: string | null;
  place_kind: PanelPlace['kind'] | null;
  place_since: Date | string | null;
}

const isoOrNull = (v: unknown) => toDate(v)?.toISOString() ?? null;
const numOrNull = (v: unknown) =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

/**
 * Every machine that isn't retired (with or without a fix), ordered by unit number: its latest
 * fix, its down state (who marked it down: the person's display name, when the session had one)
 * and the geofence it is in (its open visit; a yard, the shop or bins win over a field entrance).
 *
 * 1f (fleet-faults): its active fault codes (machine_state.fault_codes, worst first), the vendor
 * and kind of its latest fix (the "Samsara · sim" badge), engine hours, odometer, fuel and DEF,
 * how its vendor gets the data and who set its kind, and what its route doesn't report
 * (`statsNotReported` / `faultsNotReported` of the latest fix's vendor and the machine's via).
 */
export async function fleetPanelMachines(ex: Executor): Promise<PanelMachine[]> {
  const r = await exec<PanelRow>(
    ex,
    `select m.id::text as id, m.unit_no, m.kind, m.make, m.model, m.engine_hours, m.odometer_mi,
            m.telematics_via, m.kind_set_by, m.status, m.down_reason,
            m.down_at, dp.display_name as down_by,
            extensions.ST_X(s.geom) as lng, extensions.ST_Y(s.geom) as lat,
            s.heading, s.speed_mph, s.activity, s.position_source, s.position_vendor,
            s.position_kind, s.fuel_pct, s.def_pct, s.fault_codes, s.ts,
            s.current_field_id::text as field_id, f.name as field_name,
            v.geofence_id::text as place_id, v.name as place_name, v.kind as place_kind,
            v.entered_at as place_since
       from farm.machines m
       left join farm.machine_state s on s.machine_id = m.id
       left join farm.fields f on f.id = s.current_field_id
       left join farm.app_users u on u.id = m.down_by
       left join farm.parties dp on dp.id = u.party_id
       left join lateral (
         select gv.geofence_id, gv.entered_at, g.name, g.kind
           from farm.geofence_visits gv
           join farm.geofences g on g.id = gv.geofence_id
          where gv.machine_id = m.id and gv.exited_at is null
          order by (g.kind = 'field_entrance'), gv.entered_at desc, g.id
          limit 1
       ) v on true
      where m.status <> 'retired'
      order by m.unit_no, m.id`,
  );
  return r.rows.map((row) => {
    const vendor = isPositionVendor(row.position_vendor) ? row.position_vendor : null;
    const via = isPositionVendor(row.telematics_via) ? row.telematics_via : null;
    return {
      id: row.id,
      unitNo: row.unit_no,
      kind: row.kind,
      make: row.make,
      model: row.model,
      status: row.status,
      downReason: row.down_reason,
      downAt: isoOrNull(row.down_at),
      downBy: row.down_by,
      position:
        row.ts === null || row.lng === null || row.lat === null || row.activity === null
          ? null
          : {
              lng: round6(Number(row.lng)),
              lat: round6(Number(row.lat)),
              heading: round1(normalizeHeading(row.heading)) % 360,
              speedMph: round1(Math.max(0, Number(row.speed_mph ?? 0))),
              activity: row.activity,
              positionSource: row.position_source ?? 'manual',
              ts: (toDate(row.ts) as Date).toISOString(),
              fieldId: row.field_id,
              fieldName: row.field_name,
              vendor,
              ...(row.position_kind === 'last_known' ? { positionKind: row.position_kind } : {}),
            },
      faults: parseStoredFaults(row.fault_codes),
      engineHours: numOrNull(row.engine_hours),
      odometerMi: numOrNull(row.odometer_mi),
      fuelPct: numOrNull(row.fuel_pct),
      defPct: numOrNull(row.def_pct),
      faultsNotReported: faultsNotReported(vendor, via),
      via,
      kindSetBy: row.kind_set_by,
      notReported: statsNotReported(vendor, via),
      place:
        row.place_id === null || row.place_kind === null || row.place_since === null
          ? null
          : {
              geofenceId: row.place_id,
              name: row.place_name ?? '',
              kind: row.place_kind,
              since: (toDate(row.place_since) as Date).toISOString(),
            },
    };
  });
}

export interface SetMachineStatusInput {
  machineId: string;
  status: 'down' | 'active';
  /** Required (non-empty) when going down; ignored otherwise. */
  reason?: string | null;
  /** farm.app_users.id of the person (null for a device or the admin key). */
  appUserId: string | null;
  /** Display name for the realtime payload ("Dana", "Shop wall", "Admin key"). */
  byName: string | null;
}

export type SetMachineStatusOutcome =
  | { status: 'saved'; changed: boolean; result: MachineStatusPayload }
  | { status: 'not_found' }
  | { status: 'retired' };

/**
 * Mark a machine down (with a reason) or back up, in ONE transaction that also publishes
 * `fleet`/`machine` and then `fleet`/`invalidate` { event: 'machine', reason: 'changed' }
 * (contracts-m1 §6), so the wall's map refetches GET /api/fleet within the 2 s target. Marking
 * a machine that is already down again keeps `down_at` (down since) and updates the reason.
 * Nothing is published when nothing changed.
 */
export async function setMachineStatus(
  db: Db,
  input: SetMachineStatusInput,
): Promise<SetMachineStatusOutcome> {
  const down = input.status === 'down';
  const reason = down ? (input.reason ?? '').trim() : null;
  if (down && !reason) throw new RangeError('setMachineStatus: a down machine needs a reason');
  return db.transaction(async (tx) => {
    const cur = await exec<{ status: PanelMachine['status']; down_reason: string | null }>(
      tx,
      'select status, down_reason from farm.machines where id = $1::uuid for update',
      [input.machineId],
    );
    const before = cur.rows[0];
    if (!before) return { status: 'not_found' } as const;
    if (before.status === 'retired') return { status: 'retired' } as const;
    const changed = before.status !== input.status || (down && before.down_reason !== reason);
    const r = await exec<{
      status: 'active' | 'down';
      down_reason: string | null;
      down_at: unknown;
    }>(
      tx,
      `update farm.machines m
          set status = $2,
              down_reason = $3,
              down_at = case when $2 = 'down' then
                          case when m.status = 'down' then coalesce(m.down_at, now()) else now() end
                        end,
              down_by = case when $2 = 'down' then
                          case when m.status = 'down' and $4::uuid is null then m.down_by
                               else $4::uuid end
                        end,
              updated_at = now()
        where m.id = $1::uuid
        returning m.status, m.down_reason, m.down_at`,
      [input.machineId, input.status, reason, input.appUserId],
    );
    const row = r.rows[0] as {
      status: 'active' | 'down';
      down_reason: string | null;
      down_at: unknown;
    };
    const result: MachineStatusPayload = {
      machineId: input.machineId,
      status: row.status,
      downReason: row.down_reason,
      downAt: isoOrNull(row.down_at),
      by: input.byName,
    };
    if (changed) {
      await publish('fleet', 'machine', result, tx);
      await publish('fleet', 'invalidate', { event: 'machine', reason: 'changed' }, tx);
    }
    return { status: 'saved', changed, result } as const;
  });
}
