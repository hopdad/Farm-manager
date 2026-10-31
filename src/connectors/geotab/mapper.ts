/**
 * MyGeotab raw items → the vehicle telematics port (slice 1f.2, docs/contracts-1f.md §B.4.1).
 * Pure: every function parses the landed payload and returns normalized items ([] to skip).
 *
 *  - positions: a LogRecord is a live trail point (speed km/h → mph; LogRecord has no heading);
 *    a DeviceStatusInfo (the limited-scope fallback) is the device's last known position
 *    (`positionKind: 'last_known'`, with its bearing).
 *  - stats: one StatusData per diagnostic, read in the Diagnostic's unit: engine hours (seconds;
 *    the ECU's: `adjusted: false`), odometer (meters; Raw × factor + offset: `adjusted: true`),
 *    fuel and DEF (percent), ignition (1/0 → engineOn). `readings.<field>.field` = the
 *    Diagnostic id.
 *  - faults: each FaultData is a `delta` item. J1939 when the Diagnostic's source is
 *    SourceJ1939Id (SPN = Diagnostic.code, FMI = FailureMode.code), with the lamps; OBD-II when
 *    it is SourceObdId / SourceObdSaId (the P/B/C/U prefix from the controller, the code in
 *    hex: 309 → P0135), with the MIL; anything else (proprietary, GO faults) → oem with the
 *    vendor's severity verbatim. Active / Pending / None = open; Inactive / Cleared = closed.
 *  - vehicles: a Device with its group names as tags (VEHICLE_KIND_TAGS) and its VIN.
 */
import {
  type FaultLamps,
  J1939_MAX_FMI,
  J1939_MAX_SPN,
  type NormalizedFault,
  normalizedFault,
} from '../../domain/fault-codes';
import { normalizeHeading } from '../../domain/fleet';
import { type VehicleKindTagRule, vehicleKindFromTags } from '../../domain/vehicles';
import {
  type NormalizedPosition,
  type NormalizedVehicle,
  type NormalizedVehicleStat,
  normalizeStat,
  type StatRawUnit,
} from '../types';
import {
  GEOTAB_DIAGNOSTICS,
  GEOTAB_NO_FAILURE_MODE,
  GEOTAB_SOURCES,
  GEOTAB_UNITS,
  type GeotabDiagnostic,
  type GeotabFailureMode,
  type GeotabFaultData,
  geotabFaultRawSchema,
  geotabPositionRawSchema,
  geotabStatRawSchema,
  geotabVehicleRawSchema,
} from './schemas';

export const KMH_PER_MPH = 1.609344;
/** A logged speed outside 0-250 km/h is Geotab's "invalid speed": unknown. */
const MAX_VALID_KMH = 250;
const iso = (t: string) => new Date(t).toISOString();

/** km/h → mph (0.1), or null for an invalid speed. */
export function geotabSpeedMph(kmh: number | null | undefined): number | null {
  if (kmh === null || kmh === undefined || !Number.isFinite(kmh)) return null;
  if (kmh < 0 || kmh > MAX_VALID_KMH) return null;
  return Math.round((kmh / KMH_PER_MPH) * 10) / 10;
}

export function mapGeotabPosition(raw: unknown): NormalizedPosition[] {
  const p = geotabPositionRawSchema.parse(raw);
  const r = p.record;
  const base = {
    source: 'geotab' as const,
    externalMachineId: r.device.id,
    sourceOrg: '',
    ts: iso(r.dateTime),
    lng: r.longitude,
    lat: r.latitude,
    speedMph: geotabSpeedMph(r.speed),
    engineOn: null,
    positionSource: 'eld' as const,
  };
  if (p.entity === 'LogRecord') return [{ ...base, heading: null }];
  return [
    {
      ...base,
      heading: p.record.bearing == null ? null : normalizeHeading(p.record.bearing),
      positionKind: 'last_known',
    },
  ];
}

/** The raw unit of a reading from its Diagnostic (null = a unit we can't read: skip it). */
function unitOf(diag: GeotabDiagnostic | null, fallback: StatRawUnit): StatRawUnit | null {
  const id = diag?.unitOfMeasure?.id;
  // doc-derived, confirm: a diagnostic without a unit is read in the documented default unit
  // (https://developers.geotab.com/myGeotab/guides/concepts: distances in meters)
  if (!id || id === GEOTAB_UNITS.none) return fallback;
  switch (id) {
    case GEOTAB_UNITS.seconds:
      return 'seconds';
    case GEOTAB_UNITS.meters:
      return 'meters';
    case GEOTAB_UNITS.percentage:
      return 'percent';
    default:
      return null;
  }
}

/** One StatusData of our diagnostics → a stat with one field and its reading. */
export function mapGeotabStat(raw: unknown): NormalizedVehicleStat[] {
  const s = geotabStatRawSchema.parse(raw);
  const r = s.record;
  const id = r.diagnostic.id;
  const out: NormalizedVehicleStat = {
    source: 'geotab',
    externalMachineId: r.device.id,
    sourceOrg: '',
    ts: iso(r.dateTime),
  };
  const v = r.data;
  if (!Number.isFinite(v)) return [];
  switch (id) {
    case GEOTAB_DIAGNOSTICS.engineHours: {
      // doc-derived, confirm: engine hours in seconds when the Diagnostic names no unit (every
      // other Geotab engine-hours field is documented in seconds)
      const unit = unitOf(s.diagnostic, 'seconds');
      if (!unit || (unit !== 'seconds' && unit !== 'hours') || v < 0) return [];
      out.engineHours = normalizeStat(v, unit);
      out.readings = { engineHours: { raw: v, rawUnit: unit, adjusted: false, field: id } };
      return [out];
    }
    case GEOTAB_DIAGNOSTICS.odometer: {
      const unit = unitOf(s.diagnostic, 'meters');
      if (unit !== 'meters' || v < 0) return [];
      out.odometerMi = normalizeStat(v, unit);
      out.readings = { odometerMi: { raw: v, rawUnit: unit, adjusted: true, field: id } };
      return [out];
    }
    case GEOTAB_DIAGNOSTICS.fuelLevel: {
      const unit = unitOf(s.diagnostic, 'percent');
      if (unit !== 'percent' || v < 0 || v > 100) return [];
      out.fuelPct = v;
      out.readings = { fuelPct: { raw: v, rawUnit: 'percent', adjusted: null, field: id } };
      return [out];
    }
    case GEOTAB_DIAGNOSTICS.def: {
      // DEF's unit is unconfirmed: read only when the Diagnostic says percent.
      if (s.diagnostic?.unitOfMeasure?.id !== GEOTAB_UNITS.percentage || v < 0 || v > 100) {
        return [];
      }
      out.defPct = v;
      out.readings = { defPct: { raw: v, rawUnit: 'percent', adjusted: null, field: id } };
      return [out];
    }
    case GEOTAB_DIAGNOSTICS.ignition:
      out.engineOn = v >= 1;
      out.readings = { engineOn: { raw: v, rawUnit: 'boolean', adjusted: null, field: id } };
      return [out];
    default:
      return [];
  }
}

const OPEN_STATES = new Set(['active', 'pending', 'none', '']);

/** OBD-II prefix from a controller id (ControllerObdPowertrainId → P), or null. */
export function obdPrefix(controllerId: string | null | undefined): 'P' | 'B' | 'C' | 'U' | null {
  const c = controllerId ?? '';
  if (!/^ControllerObd/i.test(c)) return null;
  if (/Powertrain/i.test(c)) return 'P';
  if (/Body/i.test(c)) return 'B';
  if (/Chassis/i.test(c)) return 'C';
  if (/Networking/i.test(c)) return 'U';
  return null;
}

/** An OBD-II DTC from Geotab's numeric code (309 → '0135') and its prefix, or null. */
export function obdDtc(prefix: string | null, code: number | null | undefined): string | null {
  if (!prefix || code === null || code === undefined || code < 0 || code > 0xffff) return null;
  return `${prefix}${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

function lampsOf(r: GeotabFaultData): FaultLamps | null {
  const l: FaultLamps = {};
  if (r.redStopLamp != null) l.redStop = r.redStopLamp;
  if (r.amberWarningLamp != null) l.amberWarning = r.amberWarningLamp;
  if (r.protectWarningLamp != null) l.protect = r.protectWarningLamp;
  if (r.malfunctionLamp != null) l.malfunction = r.malfunctionLamp;
  if (Object.keys(l).length === 0) {
    switch ((r.faultLampState ?? '').toLowerCase()) {
      case 'stop':
        return { redStop: true };
      case 'warning':
        return { amberWarning: true };
      case 'protect':
        return { protect: true };
      case 'malfunction':
        return { malfunction: true };
      default:
        return null;
    }
  }
  return l;
}

/** One FaultData in the one fault model (with its Diagnostic and FailureMode looked up). */
export function geotabFault(
  r: GeotabFaultData,
  diag: GeotabDiagnostic | null,
  fm: GeotabFailureMode | null,
): NormalizedFault {
  const state = (r.faultState ?? '').trim().toLowerCase();
  const open = OPEN_STATES.has(state);
  const ts = iso(r.dateTime);
  const lamps = lampsOf(r);
  const description =
    r.faultDescription ?? ([diag?.name, fm?.name].filter(Boolean).join(': ') || null);
  const common = {
    description,
    vendorSeverity: r.severity ?? null,
    state: open ? ('open' as const) : ('closed' as const),
    lastSeenAt: ts,
    closedAt: open ? null : ts,
    ...(lamps ? { lamps } : {}),
  };
  const source = diag?.source?.id;
  const code = diag?.code ?? null;
  if (source === GEOTAB_SOURCES.j1939 && code !== null && code >= 0 && code <= J1939_MAX_SPN) {
    const fmi =
      fm &&
      fm.id !== GEOTAB_NO_FAILURE_MODE &&
      fm.code != null &&
      fm.code >= 0 &&
      fm.code <= J1939_MAX_FMI
        ? fm.code
        : null;
    if (fmi !== null) {
      const sa = r.sourceAddress;
      return normalizedFault({
        system: 'j1939',
        spn: code,
        fmi,
        sourceAddress: sa != null && sa >= 0 && sa <= 255 ? sa : null,
        occurrenceCount: r.count != null && r.count >= 0 ? r.count : null,
        ...common,
      });
    }
    // No FMI: not a J1939 key; kept as the manufacturer's code.
    return normalizedFault({ system: 'oem', oemCode: `SPN ${code}`, oemClass: 'fault', ...common });
  }
  if (source === GEOTAB_SOURCES.obd || source === GEOTAB_SOURCES.obdSa) {
    const dtc = obdDtc(obdPrefix(diag?.controller?.id ?? r.controller?.id), code);
    if (dtc) {
      return normalizedFault({
        system: 'obd2',
        dtc,
        dtcState: state === 'pending' ? 'pending' : null,
        ...common,
      });
    }
  }
  const oemCode = code !== null ? String(code) : (diag?.id ?? r.diagnostic?.id ?? `#${r.id}`);
  return normalizedFault({ system: 'oem', oemCode, oemClass: 'fault', ...common });
}

/** A FaultData → a `delta` fault report for its device. */
export function mapGeotabFault(raw: unknown): NormalizedVehicleStat[] {
  const f = geotabFaultRawSchema.parse(raw);
  const fault = geotabFault(f.record, f.diagnostic, f.failureMode);
  return [
    {
      source: 'geotab',
      externalMachineId: f.record.device.id,
      sourceOrg: '',
      ts: iso(f.record.dateTime),
      faultCodes: [fault],
      faultReport: 'delta',
    },
  ];
}

/** A Device → kind from its group names, its VIN (Geotab keeps no make, model or year). */
export function mapGeotabVehicle(
  raw: unknown,
  rules?: readonly VehicleKindTagRule[],
): NormalizedVehicle[] {
  const v = geotabVehicleRawSchema.parse(raw);
  const d = v.device;
  return [
    {
      source: 'geotab',
      sourceOrg: '',
      externalId: d.id,
      name: d.name?.trim() || d.id,
      tags: v.groups,
      kindFromTags: vehicleKindFromTags(v.groups, rules),
      // How an OEM (Ford, Stellantis) device shows in the API is unconfirmed: unchanged.
      via: null,
      make: null,
      model: null,
      year: null,
      vin: d.vehicleIdentificationNumber?.trim() || null,
    },
  ];
}
