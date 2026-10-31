/**
 * Terminal raw items → the vehicle telematics port (slice 1f.2, terminal-pickups; docs/contracts-
 * 1f.md §B.4). Pure: no I/O, no clock. Units: Terminal is metric (odometer km, speed km/h,
 * engine runtime ms; its own docs), converted with `normalizeStat` (the port's hours / miles /
 * percent); the vendor's number, unit and field ride along in `readings`.
 *
 *  - positions: a history breadcrumb (`/vehicles/{id}/locations`, Terminal's own sync) is a
 *    `live` fix; the latest location (`/vehicles/locations`, a live call to the provider) is a
 *    `last_known` snapshot (decision 1f-11). `provider` = the TSP code, so position_vendor reads
 *    `terminal_<code>` (`terminal_omnitracs_xrs`). History carries no engine state.
 *  - stats: a VehicleStatLog (engine_runtime ms → hours, odometer km → miles, fuel_level %,
 *    engine_state on/idle/off), or the counters a latest location carries.
 *  - faults: each FaultCodeEvent is a `delta` item with its own state (closed → closed at
 *    `observedAt`; open and pending → open, last seen at `observedAt`) and
 *    `faultAgeOutSeconds` (some providers never send `closed`: decision 1f-12). j1939 →
 *    spn/fmi/source address/occurrence count (an event without `fmi` is skipped, an address over
 *    255 dropped); obdii → obd2 with the DTC; `milStatus` → `lamps.malfunction`. `pending` is not
 *    defined by Terminal: kept as `vendorSeverity` context, state open, no OBD DTC state.
 *  - vehicles: no tags on a Terminal vehicle; its provider group names (`expand=groups`) are
 *    offered to VEHICLE_KIND_TAGS (doc-derived: whether haulers' groups say anything useful).
 *  - providers: GET /providers → TerminalProviderRow (the capability rows /admin/connectors
 *    shows under Terminal).
 */
import {
  DELTA_FAULT_AGE_OUT_SECONDS,
  type FaultLamps,
  J1939_MAX_FMI,
  J1939_MAX_SPN,
  type NormalizedFault,
  normalizedFault,
} from '../../domain/fault-codes';
import { positionVendorId } from '../../domain/fleet';
import {
  DEFAULT_VEHICLE_KIND_TAGS,
  type VehicleKindTagRule,
  vehicleKindFromTags,
} from '../../domain/vehicles';
import {
  type NormalizedPosition,
  type NormalizedVehicle,
  type NormalizedVehicleStat,
  normalizeStat,
  type StatReading,
  type VehicleStatField,
} from '../types';
import type { Support, TerminalProviderRow, VendorCapabilities } from '../vendors';
import {
  expandedId,
  type TerminalFaultRaw,
  type TerminalLatestLocation,
  type TerminalPositionRaw,
  type TerminalProvider,
  type TerminalProvidersRaw,
  type TerminalStatLog,
  type TerminalStatRaw,
  type TerminalVehicleRaw,
} from './schemas';

const SOURCE = 'terminal' as const;
const MPH_PER_KMH = 1 / 1.609344;

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const iso = (s: string) => new Date(s).toISOString();

/** Degrees → [0, 360), or null. */
function heading(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return ((v % 360) + 360) % 360;
}

/** Terminal's engine state: `on` and `idle` are running, `off` is not; anything else unknown. */
export function terminalEngineOn(state: string | null | undefined): boolean | null {
  switch ((state ?? '').toLowerCase()) {
    case 'on':
    case 'idle':
      return true;
    case 'off':
      return false;
    default:
      return null;
  }
}

// ---- positions --------------------------------------------------------------------------------

export function mapTerminalPosition(raw: TerminalPositionRaw): NormalizedPosition[] {
  const l = raw.location;
  const speed = l.speed;
  return [
    {
      source: SOURCE,
      externalMachineId: expandedId(l.vehicle),
      sourceOrg: raw.connectionId,
      ts: iso(l.locatedAt),
      lng: l.location.longitude,
      lat: l.location.latitude,
      heading: heading(l.heading),
      speedMph:
        speed === null || speed === undefined || !Number.isFinite(speed)
          ? null
          : round(Math.max(0, speed) * MPH_PER_KMH, 2),
      engineOn: raw.kind === 'latest' ? terminalEngineOn(raw.location.engineState) : null,
      positionSource: 'eld',
      positionKind: raw.kind === 'history' ? 'live' : 'last_known',
      provider: l.provider,
    },
  ];
}

/** The badge's vendor id of a Terminal provider code (`omnitracs-xrs` → `terminal_omnitracs_xrs`). */
export const terminalVendorId = (providerCode: string) => positionVendorId(SOURCE, providerCode);

// ---- stats ------------------------------------------------------------------------------------

type StatValues = Pick<
  NormalizedVehicleStat,
  'engineHours' | 'odometerMi' | 'fuelPct' | 'engineOn' | 'readings'
>;

/** The port's value and reading of one Terminal number (absent when not a finite number). */
function numeric(
  out: StatValues,
  field: Exclude<VehicleStatField, 'engineOn' | 'defPct'>,
  value: number | null | undefined,
  unit: StatReading['rawUnit'],
  vendorField: string,
): void {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return;
  const n = normalizeStat(value, unit);
  if (field === 'fuelPct') out.fuelPct = round(Math.min(100, n), 1);
  else out[field] = round(n, 2);
  out.readings = {
    ...out.readings,
    [field]: { raw: value, rawUnit: unit, adjusted: null, field: vendorField },
  };
}

function engineState(out: StatValues, state: string | null | undefined, vendorField: string) {
  const on = terminalEngineOn(state);
  if (on === null) return;
  out.engineOn = on;
  out.readings = {
    ...out.readings,
    engineOn: { raw: on, rawUnit: 'boolean', adjusted: null, field: vendorField },
  };
}

function statOfLog(log: TerminalStatLog): StatValues {
  const out: StatValues = {};
  switch (log.type) {
    case 'engine_runtime':
      // doc-derived, confirm: a cumulative meter ("Total engine runtime duration" on the latest
      // location; the stat log's own example, 1234.5 ms, isn't one).
      // https://docs.withterminal.com/api-reference/vehicles/list-historical-vehicle-stats
      numeric(out, 'engineHours', log.duration, 'milliseconds', 'engine_runtime');
      break;
    case 'odometer':
      numeric(out, 'odometerMi', log.odometer, 'kilometers', 'odometer');
      break;
    case 'fuel_level':
      numeric(out, 'fuelPct', log.fuelPercentage, 'percent', 'fuel_level');
      break;
    case 'engine_state':
      engineState(out, log.state, 'engine_state');
      break;
  }
  return out;
}

function statOfLatest(l: TerminalLatestLocation): StatValues {
  const out: StatValues = {};
  numeric(out, 'engineHours', l.engineRuntime, 'milliseconds', 'engineRuntime');
  numeric(out, 'odometerMi', l.odometer, 'kilometers', 'odometer');
  numeric(out, 'fuelPct', l.fuel?.primaryPercentage, 'percent', 'fuel.primaryPercentage');
  engineState(out, l.engineState, 'engineState');
  return out;
}

/** A stat log or a latest location → one stat item (nothing when it carries no stat we read). */
export function mapTerminalStat(raw: TerminalStatRaw): NormalizedVehicleStat[] {
  const values = raw.kind === 'log' ? statOfLog(raw.log) : statOfLatest(raw.location);
  if (!values.readings) return [];
  const vehicle = raw.kind === 'log' ? raw.log.vehicle : raw.location.vehicle;
  const ts = raw.kind === 'log' ? raw.log.timestamp : raw.location.locatedAt;
  return [
    {
      source: SOURCE,
      externalMachineId: expandedId(vehicle),
      sourceOrg: raw.connectionId,
      ts: iso(ts),
      ...values,
    },
  ];
}

// ---- faults -----------------------------------------------------------------------------------

/** One FaultCodeEvent → the one fault model, or null (an event the app can't key). */
export function terminalFault(e: TerminalFaultRaw['event']): NormalizedFault | null {
  const at = iso(e.observedAt);
  const closed = e.status.toLowerCase() === 'closed';
  const mil = (e.milStatus ?? '').toLowerCase();
  const lamps: FaultLamps | null =
    mil === 'on' || mil === 'off' ? { malfunction: mil === 'on' } : null;
  const state = closed
    ? ({ state: 'closed', closedAt: at, lastSeenAt: at } as const)
    : ({ state: 'open', lastSeenAt: at } as const);
  // `pending` is not defined by Terminal: context for the hover, never an OBD DTC state.
  const vendorSeverity = e.status.toLowerCase() === 'pending' ? 'pending' : null;
  switch (e.protocol.toLowerCase()) {
    case 'j1939': {
      const j = e.j1939;
      // Our machine_faults CHECK needs both SPN and FMI on a j1939 row: skip one without FMI.
      if (!j || j.fmi === null || j.fmi === undefined) return null;
      if (j.spn < 0 || j.spn > J1939_MAX_SPN || j.fmi < 0 || j.fmi > J1939_MAX_FMI) return null;
      const sa = j.sourceAddress;
      return normalizedFault({
        system: 'j1939',
        spn: j.spn,
        fmi: j.fmi,
        // The spec's own example is 256: J1939 addresses are 0-255, so drop anything else.
        sourceAddress: sa !== null && sa !== undefined && sa >= 0 && sa <= 255 ? sa : null,
        occurrenceCount:
          j.occurrenceCount !== null && j.occurrenceCount !== undefined && j.occurrenceCount >= 0
            ? j.occurrenceCount
            : null,
        description: e.description ?? j.spnDescription ?? null,
        lamps,
        vendorSeverity,
        ...state,
      });
    }
    case 'obdii': {
      const dtc = (e.obdii?.code ?? e.code).trim();
      if (!dtc) return null;
      return normalizedFault({
        system: 'obd2',
        dtc,
        description: e.description ?? e.obdii?.description ?? null,
        lamps,
        vendorSeverity,
        ...state,
      });
    }
    default:
      return null;
  }
}

/** A fault event → a `delta` stat item with the age-out (or nothing when it can't be keyed). */
export function mapTerminalFault(raw: TerminalFaultRaw): NormalizedVehicleStat[] {
  const fault = terminalFault(raw.event);
  if (!fault) return [];
  return [
    {
      source: SOURCE,
      externalMachineId: expandedId(raw.event.vehicle),
      sourceOrg: raw.connectionId,
      ts: iso(raw.event.observedAt),
      faultCodes: [fault],
      faultReport: 'delta',
      faultAgeOutSeconds: DELTA_FAULT_AGE_OUT_SECONDS,
    },
  ];
}

// ---- vehicles ---------------------------------------------------------------------------------

export function mapTerminalVehicle(
  raw: TerminalVehicleRaw,
  rules: readonly VehicleKindTagRule[] = DEFAULT_VEHICLE_KIND_TAGS,
): NormalizedVehicle[] {
  const v = raw.vehicle;
  return [
    {
      source: SOURCE,
      sourceOrg: raw.connectionId,
      externalId: v.id,
      name: v.name ?? v.id,
      tags: raw.groups,
      kindFromTags: vehicleKindFromTags(raw.groups, rules),
      // Terminal doesn't say how its provider gets the data (no carmaker-cloud flag).
      via: null,
      make: v.make ?? null,
      model: v.model ?? null,
      year: v.year ?? null,
      vin: v.vin ?? null,
    },
  ];
}

// ---- providers --------------------------------------------------------------------------------

const supported = (
  s: { supportedOperations?: { read?: string | null } | null } | null | undefined,
) => s?.supportedOperations?.read === 'supported';

/**
 * One provider's capability row from its /providers entry: positions from LatestVehicleLocation
 * (last known) and VehicleLocation (live, Terminal's history); stats from VehicleStatLog's
 * `types` (engine_runtime, odometer, fuel_level, engine_state; Terminal has no DEF type); faults
 * from FaultCodeEvent (`doc` for both protocols: /providers doesn't say which one a provider
 * sends; Terminal has no OEM codes). Webhooks: none for our streams; no field operations.
 */
export function terminalProviderRow(p: TerminalProvider): TerminalProviderRow {
  const m = p.supportedModels ?? {};
  const types = new Set(supported(m.VehicleStatLog) ? (m.VehicleStatLog?.types ?? []) : []);
  const yes = (b: boolean): Support => (b ? 'yes' : 'no');
  const faults = supported(m.FaultCodeEvent);
  const capabilities: VendorCapabilities = {
    positions: {
      live: yes(supported(m.VehicleLocation)),
      lastKnown: yes(supported(m.LatestVehicleLocation)),
    },
    stats: {
      engineHours: yes(types.has('engine_runtime')),
      odometerMi: yes(types.has('odometer')),
      fuelPct: yes(types.has('fuel_level')),
      defPct: 'no',
      engineOn: yes(types.has('engine_state')),
    },
    faults: { j1939: faults ? 'doc' : 'no', obd2: faults ? 'doc' : 'no', oem: 'no' },
    fieldOperations: 'no',
    webhooks: 'no',
  };
  return { code: p.code, label: p.name, vendorId: terminalVendorId(p.code), capabilities };
}

/** A provider our connection uses that /providers doesn't list: every capability unknown. */
export function unlistedProviderRow(code: string, name?: string | null): TerminalProviderRow {
  const u: Support = 'unknown';
  return {
    code,
    label: name || code,
    vendorId: terminalVendorId(code),
    capabilities: {
      positions: { live: u, lastKnown: u },
      stats: { engineHours: u, odometerMi: u, fuelPct: u, defPct: 'no', engineOn: u },
      faults: { j1939: u, obd2: u, oem: 'no' },
      fieldOperations: 'no',
      webhooks: 'no',
    },
  };
}

/**
 * The providers raw item → ONE item: a row per provider our connections use, in code order
 * (a code /providers doesn't list gets an all-unknown row, so the admin page still names it).
 */
export function mapTerminalProviders(raw: TerminalProvidersRaw): TerminalProviderRow[][] {
  const byCode = new Map(raw.providers.map((p) => [p.code, p]));
  return [
    [...new Set(raw.codes)].sort().map((code) => {
      const p = byCode.get(code);
      return p ? terminalProviderRow(p) : unlistedProviderRow(code);
    }),
  ];
}
