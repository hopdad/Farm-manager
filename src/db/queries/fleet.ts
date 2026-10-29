/**
 * Fleet queries shared by the fleet.* jobs (their batched `fleet.tick`) and GET /api/fleet
 * (contracts §7): one builder, so a tick and the snapshot always agree.
 *
 *  - `fleetSnapshot()`: every non-retired machine with a known state, as MachineView[], with
 *    `stale` computed at build time from the fix's wall-clock `ts`.
 *  - `upsertPosition()`: one fix → farm.positions (PK (machine_id, ts): duplicates are no-ops)
 *    and farm.machine_state (only when the fix is newer, so out-of-order pages never move a
 *    machine back). The current field and the activity are derived in PostGIS:
 *      deere_working → working; inside an elevator geofence below 5 mph → queued;
 *      >= 3 mph → transport; else idle.
 *  - `upsertVehicleStat()`: engine hours / odometer (never decreasing) and fuel.
 */

import type { NormalizedPosition, NormalizedVehicleStat } from '../../connectors/types';
import { type FleetTick, isStale, type MachineView, normalizeHeading } from '../../domain/fleet';
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
  staleAfterSeconds: number,
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
      stale: isStale(ts, now, staleAfterSeconds),
    };
  });
}

/** The FleetTick body (realtime `fleet`/`tick` and GET /api/fleet). */
export async function fleetSnapshot(
  ex: Executor,
  now: Date,
  staleAfterSeconds: number,
): Promise<FleetTick> {
  return { ts: now.toISOString(), machines: await fleetMachines(ex, now, staleAfterSeconds) };
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
