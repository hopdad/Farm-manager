/**
 * Fleet queries shared by the fleet.* jobs (their batched `fleet.tick`) and GET /api/fleet
 * (contracts §7): one builder, so a tick and the snapshot always agree.
 *
 *  - `fleetSnapshot()`: every non-retired machine with a known state, as MachineView[], with
 *    `stale` computed at build time from the fix's wall-clock `ts` and the threshold for its
 *    position source (FLEET_STALE_SECONDS, or FLEET_STALE_SECONDS_DEERE for Deere fixes).
 *  - `upsertPosition()`: one fix → farm.positions (PK (machine_id, ts): duplicates are no-ops)
 *    and farm.machine_state (only when the fix is newer, so out-of-order pages never move a
 *    machine back). The current field and the activity are derived in PostGIS:
 *      deere_working → working; inside an elevator geofence below 5 mph → queued;
 *      >= 3 mph → transport; else idle.
 *  - `upsertVehicleStat()`: engine hours / odometer (never decreasing) and fuel.
 *  - `fleetPanelMachines()` / `setMachineStatus()`: the fleet panel (M1 1a) and marking a
 *    machine down or back up (publishes `fleet`/`machine` + `fleet`/`invalidate`).
 */

import type { NormalizedPosition, NormalizedVehicleStat } from '../../connectors/types';
import {
  type FleetTick,
  isMachineStale,
  type MachineView,
  normalizeHeading,
  type StaleThresholds,
} from '../../domain/fleet';
import { publish } from '../../platform/realtime/publish';
import type { MachineStatusPayload } from '../../platform/realtime/types';
import type { PanelMachine, PanelPlace, PanelPosition } from '../../ui/fleet/contract';
import type { Db } from '../client';
import { type Executor, exec, toDate } from '../exec';

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
            s.position_source, s.ts
       from farm.machines m
       join farm.machine_state s on s.machine_id = m.id
      where m.status <> 'retired'
      order by m.unit_no, m.id`,
  );
  return r.rows.map((row) => {
    const ts = (toDate(row.ts) as Date).toISOString();
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
      ts,
      status: row.status,
      stale: isMachineStale({ ts, positionSource: row.position_source }, now, stale),
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

/** The stale thresholds from config (FLEET_STALE_SECONDS / FLEET_STALE_SECONDS_DEERE). */
export function staleThresholdsOf(cfg: {
  FLEET_STALE_SECONDS: number;
  FLEET_STALE_SECONDS_DEERE: number;
}): StaleThresholds {
  return {
    staleAfterSeconds: cfg.FLEET_STALE_SECONDS,
    deereStaleAfterSeconds: cfg.FLEET_STALE_SECONDS_DEERE,
  };
}

export interface UpsertPositionResult {
  /** A new farm.positions row (false: that (machine, ts) was already stored). */
  inserted: boolean;
  /** farm.machine_state moved to this fix (false: the state already had a newer fix). */
  stateUpdated: boolean;
}

/** Store one fix for `machineId` (already resolved through ingest.external_refs). */
export async function upsertPosition(
  ex: Executor,
  machineId: string,
  p: NormalizedPosition,
): Promise<UpsertPositionResult> {
  const heading = p.heading === null ? null : normalizeHeading(p.heading);
  const speed = p.speedMph === null ? null : Math.max(0, p.speedMph);
  const ins = await exec(
    ex,
    `insert into farm.positions (machine_id, ts, geom, speed_mph, heading, engine_on, source)
     values ($1::uuid, $2::timestamptz,
             extensions.ST_SetSRID(extensions.ST_MakePoint($3::float8, $4::float8), 4326),
             $5::float8, $6::float8, $7::boolean, $8)
     on conflict (machine_id, ts) do nothing`,
    [machineId, p.ts, p.lng, p.lat, speed, heading, p.engineOn, p.source],
  );
  const st = await exec(
    ex,
    `with pt as (
       select extensions.ST_SetSRID(extensions.ST_MakePoint($3::float8, $4::float8), 4326) as g
     )
     insert into farm.machine_state as ms
       (machine_id, ts, geom, speed_mph, heading, activity, current_field_id, engine_on,
        position_source, updated_at)
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
            $7::boolean, $8, now()
       from pt
     on conflict (machine_id) do update
       set ts = excluded.ts, geom = excluded.geom, speed_mph = excluded.speed_mph,
           heading = excluded.heading, activity = excluded.activity,
           current_field_id = excluded.current_field_id,
           engine_on = coalesce(excluded.engine_on, ms.engine_on),
           position_source = excluded.position_source, updated_at = now()
     where ms.ts < excluded.ts`,
    [machineId, p.ts, p.lng, p.lat, speed, heading, p.engineOn, p.positionSource],
  );
  return { inserted: ins.rowCount === 1, stateUpdated: st.rowCount === 1 };
}

/** Store engine hours / odometer (monotonic) and fuel (latest wins) for `machineId`. */
export async function upsertVehicleStat(
  ex: Executor,
  machineId: string,
  s: NormalizedVehicleStat,
): Promise<void> {
  if (s.engineHours !== undefined || s.odometerMi !== undefined) {
    await exec(
      ex,
      `update farm.machines
          set engine_hours = case when $2::numeric is null then engine_hours
                                  else greatest(coalesce(engine_hours, $2::numeric), $2::numeric) end,
              odometer_mi = case when $3::numeric is null then odometer_mi
                                 else greatest(coalesce(odometer_mi, $3::numeric), $3::numeric) end,
              updated_at = now()
        where id = $1::uuid`,
      [machineId, s.engineHours ?? null, s.odometerMi ?? null],
    );
  }
  if (s.fuelPct !== undefined) {
    await exec(
      ex,
      `update farm.machine_state set fuel_pct = $2::float8, updated_at = now()
        where machine_id = $1::uuid`,
      [machineId, s.fuelPct],
    );
  }
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
  ts: Date | string | null;
  field_id: string | null;
  field_name: string | null;
  place_id: string | null;
  place_name: string | null;
  place_kind: PanelPlace['kind'] | null;
  place_since: Date | string | null;
}

const isoOrNull = (v: unknown) => toDate(v)?.toISOString() ?? null;

/**
 * Every machine that isn't retired (with or without a fix), ordered by unit number: its latest
 * fix, its down state (who marked it down: the person's display name, when the session had one)
 * and the geofence it is in (its open visit; a yard, the shop or bins win over a field entrance).
 */
export async function fleetPanelMachines(ex: Executor): Promise<PanelMachine[]> {
  const r = await exec<PanelRow>(
    ex,
    `select m.id::text as id, m.unit_no, m.kind, m.make, m.model, m.status, m.down_reason,
            m.down_at, dp.display_name as down_by,
            extensions.ST_X(s.geom) as lng, extensions.ST_Y(s.geom) as lat,
            s.heading, s.speed_mph, s.activity, s.position_source, s.ts,
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
  return r.rows.map((row) => ({
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
          },
    place:
      row.place_id === null || row.place_kind === null || row.place_since === null
        ? null
        : {
            geofenceId: row.place_id,
            name: row.place_name ?? '',
            kind: row.place_kind,
            since: (toDate(row.place_since) as Date).toISOString(),
          },
  }));
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
