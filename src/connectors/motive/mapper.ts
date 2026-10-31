/**
 * Motive raw items → the vehicle telematics port (slice 1f.2, docs/contracts-1f.md §B.4.1).
 * Pure: every function parses the landed payload and returns normalized items ([] to skip).
 *
 *  - positions: v1/v2 `speed` is mph (asked for with X-Metric-Units: false); v3's `kph` is km/h
 *    and converted; v3's `vehicle_state` (on/off) is the engine state.
 *  - stats: `true_engine_hours` / `true_odometer` ("adjusted for accuracy": readings with
 *    `adjusted: true`) win over the raw `engine_hours` / `odometer` (`adjusted: false`), and
 *    `fuel_primary_remaining_percentage`. A field Motive didn't send stays absent, never 0.
 *  - faults: /v1/fault_codes records are `delta` reports (each with its own `status` open/closed
 *    and first/last observed times; Motive sends `closed`, so no age-out). The code system:
 *    an OBD-II DTC (`network` obdii, or a P/B/C/U code) → obd2; `SPN-<n>` (or a numeric code)
 *    with an FMI → j1939 (the source address kept when it is a J1939 address, 0-255); anything
 *    else (J1587 PIDs/SIDs, OEM codes) → oem, the label verbatim. Motive documents no lamp
 *    states, so severity follows decision 1f-2 with lamps unknown (`faultSeverity`).
 *  - vehicles: /v1/vehicles with the names of its groups as tags (Motive has groups, not tags).
 */
import { J1939_MAX_FMI, J1939_MAX_SPN, normalizedFault } from '../../domain/fault-codes';
import { normalizeHeading } from '../../domain/fleet';
import { type VehicleKindTagRule, vehicleKindFromTags } from '../../domain/vehicles';
import type {
  NormalizedPosition,
  NormalizedVehicle,
  NormalizedVehicleStat,
  StatReading,
  VehicleStatField,
} from '../types';
import {
  type MotiveFaultCode,
  motiveFaultRawSchema,
  motivePositionRawSchema,
  motiveStatRawSchema,
  motiveVehicleRawSchema,
} from './schemas';

export const KMH_PER_MPH = 1.609344;
const round1 = (v: number) => Math.round(v * 10) / 10;
const iso = (t: string) => new Date(t).toISOString();

/** An integer from a number or a numeric string Motive sent ("2024", 5), else null. */
export function motiveInt(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v.trim());
  return Number.isInteger(n) ? n : null;
}

/** v3 `vehicle_state` → engine on/off (null when absent or unknown). */
function engineState(v: string | null | undefined): boolean | null {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'on') return true;
  if (s === 'off') return false;
  return null;
}

export function mapMotivePosition(raw: unknown): NormalizedPosition[] {
  const p = motivePositionRawSchema.parse(raw);
  const l = p.location;
  return [
    {
      source: 'motive',
      externalMachineId: p.id,
      sourceOrg: p.companyId ?? '',
      ts: iso(l.located_at),
      lng: l.lon,
      lat: l.lat,
      heading: l.bearing == null ? null : normalizeHeading(l.bearing),
      speedMph:
        l.speed != null
          ? Math.max(0, l.speed)
          : l.kph != null
            ? Math.max(0, round1(l.kph / KMH_PER_MPH))
            : null,
      engineOn: engineState(l.vehicle_state),
      positionSource: 'eld',
    },
  ];
}

/** The engine hours, odometer and fuel of a v2 current_location (raw/adjusted kept in readings). */
export function mapMotiveStat(raw: unknown): NormalizedVehicleStat[] {
  const s = motiveStatRawSchema.parse(raw);
  const l = s.location;
  const out: NormalizedVehicleStat = {
    source: 'motive',
    externalMachineId: s.id,
    sourceOrg: s.companyId,
    ts: iso(l.located_at),
  };
  const readings: Partial<Record<VehicleStatField, StatReading>> = {};
  const ok = (v: number | null | undefined): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (ok(l.true_engine_hours)) {
    out.engineHours = l.true_engine_hours;
    readings.engineHours = {
      raw: l.true_engine_hours,
      rawUnit: 'hours',
      adjusted: true,
      field: 'true_engine_hours',
    };
  } else if (ok(l.engine_hours)) {
    out.engineHours = l.engine_hours;
    readings.engineHours = {
      raw: l.engine_hours,
      rawUnit: 'hours',
      adjusted: false,
      field: 'engine_hours',
    };
  }
  if (ok(l.true_odometer)) {
    out.odometerMi = l.true_odometer;
    readings.odometerMi = {
      raw: l.true_odometer,
      rawUnit: 'miles',
      adjusted: true,
      field: 'true_odometer',
    };
  } else if (ok(l.odometer)) {
    out.odometerMi = l.odometer;
    readings.odometerMi = { raw: l.odometer, rawUnit: 'miles', adjusted: false, field: 'odometer' };
  }
  const fuel = l.fuel_primary_remaining_percentage;
  if (ok(fuel) && fuel <= 100) {
    out.fuelPct = fuel;
    readings.fuelPct = {
      raw: fuel,
      rawUnit: 'percent',
      adjusted: null,
      field: 'fuel_primary_remaining_percentage',
    };
  }
  if (Object.keys(readings).length === 0) return [];
  return [{ ...out, readings }];
}

const OBD_DTC = /^[PBCU][0-9A-F]{4}$/i;
const SPN_LABEL = /^SPN[\s:_-]*(\d{1,6})$/i;
const J1587 = /1587|1708/;

/** One Motive fault record in the one fault model (null when it can't be read). */
export function motiveFault(f: MotiveFaultCode): ReturnType<typeof normalizedFault> | null {
  const network = (f.network ?? '').trim().toLowerCase();
  const code = (f.code ?? '').trim();
  const label = (f.code_label ?? '').trim() || code;
  const fmi = motiveInt(f.fmi);
  const closed = f.status.trim().toLowerCase() === 'closed';
  const ts = f.last_observed_at ?? f.first_observed_at;
  if (!ts) return null;
  const common = {
    description: f.code_description ?? f.fmi_description ?? null,
    vendorSeverity: f.dtc_severity ?? null,
    state: closed ? ('closed' as const) : ('open' as const),
    firstSeenAt: f.first_observed_at ? iso(f.first_observed_at) : null,
    lastSeenAt: iso(ts),
    closedAt: closed ? iso(ts) : null,
  };
  // OBD-II: the network says so, or the label is a J2012 DTC with no FMI.
  if (network.includes('obd') || (fmi === null && OBD_DTC.test(label))) {
    const dtc = OBD_DTC.test(label) ? label : OBD_DTC.test(code) ? code : label || code;
    if (dtc) return normalizedFault({ system: 'obd2', dtc: dtc.toUpperCase(), ...common });
  }
  // J1939: `SPN-<n>` with an FMI (also on a J1587-labelled network: Motive's webhook example),
  // or a numeric code with an FMI that isn't a J1587 PID/SID.
  const spnFromLabel = SPN_LABEL.exec(label)?.[1];
  const spn =
    spnFromLabel !== undefined
      ? Number(spnFromLabel)
      : /^\d{1,6}$/.test(code) && !J1587.test(network) && !f.is_sid
        ? Number(code)
        : null;
  if (spn !== null && fmi !== null && spn <= J1939_MAX_SPN && fmi >= 0 && fmi <= J1939_MAX_FMI) {
    const sa = motiveInt(f.source_address);
    const occurrences = motiveInt(f.occurrence_count);
    return normalizedFault({
      system: 'j1939',
      spn,
      fmi,
      sourceAddress: sa !== null && sa >= 0 && sa <= 255 ? sa : null,
      occurrenceCount: occurrences !== null && occurrences >= 0 ? occurrences : null,
      ...common,
    });
  }
  // Anything else is the manufacturer's (or J1587's) own code, kept verbatim.
  const oemCode = label || code || `#${f.id}`;
  return normalizedFault({
    system: 'oem',
    oemCode: J1587.test(network) && fmi !== null ? `${oemCode} FMI ${fmi}` : oemCode,
    oemClass: null,
    ...common,
  });
}

/** A /v1/fault_codes record → a `delta` fault report for its vehicle. */
export function mapMotiveFault(raw: unknown): NormalizedVehicleStat[] {
  const r = motiveFaultRawSchema.parse(raw);
  const vehicleId = r.fault.vehicle?.id;
  const fault = motiveFault(r.fault);
  if (!vehicleId || !fault) return [];
  return [
    {
      source: 'motive',
      externalMachineId: vehicleId,
      sourceOrg: r.companyId,
      ts: fault.lastSeenAt as string,
      faultCodes: [fault],
      faultReport: 'delta',
    },
  ];
}

/** A /v1/vehicles entry → kind from its group names (VEHICLE_KIND_TAGS), make/model/year/VIN. */
export function mapMotiveVehicle(
  raw: unknown,
  rules?: readonly VehicleKindTagRule[],
): NormalizedVehicle[] {
  const r = motiveVehicleRawSchema.parse(raw);
  const v = r.vehicle;
  const year = motiveInt(v.year);
  return [
    {
      source: 'motive',
      sourceOrg: r.companyId,
      externalId: v.id,
      name: v.number?.trim() || v.id,
      tags: r.groups,
      kindFromTags: vehicleKindFromTags(r.groups, rules),
      // Motive's API doesn't say how a vehicle reports (gateway vs an OEM cloud): unchanged.
      via: null,
      make: v.make?.trim() || null,
      model: v.model?.trim() || null,
      year: year !== null && year > 1900 ? year : null,
      vin: v.vin?.trim() || null,
    },
  ];
}
