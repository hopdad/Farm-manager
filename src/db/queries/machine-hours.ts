/**
 * farm.machine_hours for Deere engine hours (slice 1f, docs/contracts-1f.md §5.0, §5.3, §5.7;
 * owner: deere-data). deere-data writes Deere's readings HERE, never through upsertVehicleStat
 * (fleet-faults changes that one in parallel): the reading is appended (`on conflict do
 * nothing`: the same report seen twice is one row), then `machines.engine_hours` moves to it
 * with the `greatest()` rule upsertVehicleStat uses, so it never goes backwards (an older report
 * arriving late, a meter reset in the vendor's cloud).
 */
import { type Executor, exec } from '../exec';

export interface EngineHoursReading {
  /** Vendor time of the reading (UTC ISO). */
  ts: string;
  /** Hours, normalized (≥ 0). */
  engineHours: number;
}

export interface MachineHoursResult {
  /** A new farm.machine_hours row (false: that reading was already there). */
  appended: boolean;
  /** machines.engine_hours moved up to the reading. */
  raised: boolean;
}

/** Append one engine-hours reading of `source` (default 'deere') and raise the machine's meter. */
export async function appendEngineHours(
  ex: Executor,
  machineId: string,
  r: EngineHoursReading,
  source = 'deere',
): Promise<MachineHoursResult> {
  if (!Number.isFinite(r.engineHours) || r.engineHours < 0) {
    throw new RangeError(`engine hours must be a number ≥ 0 (got ${r.engineHours})`);
  }
  const ins = await exec(
    ex,
    `insert into farm.machine_hours (machine_id, ts, engine_hours, source)
     values ($1::uuid, $2::timestamptz, $3::numeric, $4)
     on conflict do nothing`,
    [machineId, r.ts, r.engineHours, source],
  );
  const upd = await exec(
    ex,
    `update farm.machines
        set engine_hours = greatest(coalesce(engine_hours, $2::numeric), $2::numeric),
            updated_at = now()
      where id = $1::uuid and (engine_hours is null or engine_hours < round($2::numeric, 1))`,
    [machineId, r.engineHours],
  );
  return { appended: ins.rowCount > 0, raised: upd.rowCount > 0 };
}
