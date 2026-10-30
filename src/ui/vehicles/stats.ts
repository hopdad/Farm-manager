/**
 * How a machine's engine hours, odometer, fuel and DEF read on the fleet panel (slice 1f.2,
 * docs/contracts-1f.md part B): a known value in plain units ("4,312 h", "412,300 mi", "62 %");
 * a stat the machine's route doesn't report (`notReported`, from the vendor registry's
 * capability matrix) as "not reported" (never 0 and never a dash, so nobody reads a Ford pickup's
 * missing hour meter as a broken one); anything else not known yet as "—".
 *
 * Pure. The foundation wrote it so fleet-faults' row text (1f) and terminal-pickups (1f.2) share
 * one rule; terminal-pickups owns it in 1f.2 (frozen: `formatVehicleStat`, `NOT_REPORTED`).
 */
import type { VehicleStatField } from '../../connectors/types';

export const NOT_REPORTED = 'not reported';
export const NOT_KNOWN = '—';

const UNIT: Record<Exclude<VehicleStatField, 'engineOn'>, string> = {
  engineHours: 'h',
  odometerMi: 'mi',
  fuelPct: '%',
  defPct: '%',
};

const grouped = (v: number) => Math.round(v).toLocaleString('en-US');

/** One stat's text for the panel. */
export function formatVehicleStat(
  field: VehicleStatField,
  value: number | boolean | null | undefined,
  notReported: readonly VehicleStatField[] = [],
): string {
  if (
    value === null ||
    value === undefined ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    return notReported.includes(field) ? NOT_REPORTED : NOT_KNOWN;
  }
  if (field === 'engineOn') return value ? 'engine on' : 'engine off';
  const n = Number(value);
  switch (field) {
    case 'engineHours':
    case 'odometerMi':
      return `${grouped(n)} ${UNIT[field]}`;
    case 'fuelPct':
    case 'defPct':
      return `${Math.round(Math.min(100, Math.max(0, n)))} ${UNIT[field]}`;
  }
}
