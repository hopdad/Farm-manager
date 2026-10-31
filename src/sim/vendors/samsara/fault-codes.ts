/**
 * The Samsara stand-in's fault codes (slice 1f, fleet-faults; docs/contracts-1f.md §7.3): which
 * codes each vehicle on the vehicle feeds has at a wall instant, and the faultCodes reading that
 * reports them, in the shapes of Samsara's OpenAPI (J1939, OBD-II per module (`txId`), OEM).
 *
 * Where codes come from, latest first:
 *  1. the knob (`/_control/vendor/samsara/fault-codes`, ./control-types.ts): a vehicle's codes
 *     from the wall time it was set (`codes: null` hands it back to 2.);
 *  2. the scenario's schedule, keyed on `world.scenario` and `world.startsAt` (the sim world is
 *     not changed): in `breakdown`, semi S3 shows a red-stop-lamp engine code from 09:40 on day 0
 *     (SPN 110 FMI 0, coolant temperature, most severe), and keeps it until the knob clears it;
 *  3. none.
 *
 * What a vehicle reports follows its route (`capabilitiesFor('samsara', via)`, src/connectors/
 * vendors.ts): the semis are J1939 (CANBUS_J1939_500); the carmaker-cloud pickups are OBD-II only
 * (Ford Pro, Stellantis: CANBUS_PASSENGER_15765_11_500, one engine module, 2024 = 0x7E8). Every
 * reading names the vehicle's own block even when it has no codes, so a cleared vehicle reports
 * an empty list (J1939's "empty if there are no active fault codes"; the pickup's module with
 * empty DTC lists).
 *
 * Pure (state in, reading out); ./routes.ts serves it on the stats feed and the knob.
 */
import type { SamsaraFaultCodesReading } from '../../../connectors/samsara/schemas';
import { capabilitiesFor, reports } from '../../../connectors/vendors';
import type { FaultSystem } from '../../../domain/fault-codes';
import { type SimMachine, type SimWorld, simTelematicsMachines } from '../../types';
import {
  EMPTY_SAMSARA_SIM_FAULTS,
  SAMSARA_SIM_MAX_CODES,
  type SamsaraSimFault,
  type SamsaraSimFaultsState,
  SIM_RED_STOP_FAULT,
  samsaraSimFaultsStateSchema,
} from './control-types';

/** The knob's bag in the stand-in state (`state.vendors[...]`). */
export const SAMSARA_FAULTS_STATE_KEY = 'samsara.fault-codes';

/** The feed's grid (wall ms): a change is reported at the first grid instant after it. */
export const FAULT_GRID_MS = 5_000;

/** Knob changes kept per vehicle (the feed reads the history; older ones can't matter). */
const MAX_CHANGES = 20;

/** The breakdown scenario's scheduled code: semi S3, 09:40 local on day 0. */
export const BREAKDOWN_SEMI_FAULT = {
  unitNo: 'S3',
  /** After the scenario's start (07:00 EDT). */
  afterStartMs: (2 * 60 + 40) * 60_000,
  codes: [SIM_RED_STOP_FAULT],
} as const;

/** The J2012 number of a DTC ('P0087' → 135), as Samsara's `dtcId`. */
export function obdDtcId(dtc: string): number {
  const letter = 'PCBU'.indexOf(dtc[0] ?? 'P');
  return (Math.max(0, letter) << 14) | (Number(dtc[1]) << 12) | Number.parseInt(dtc.slice(2), 16);
}

/** The module an OBD-II vehicle's engine controller answers on (0x7E8). */
export const OBD_ENGINE_TX_ID = 2024;

/** One vehicle of the vehicle feeds, as the fault feed sees it. */
export interface FaultVehicle {
  id: string;
  name: string;
  machineId: string;
  /** Its own bus: J1939 (trucks) or OBD-II (passenger-car buses: the carmaker-cloud pickups). */
  bus: 'j1939' | 'obd2';
  /** Code systems its route reports (`reports(capabilitiesFor('samsara', via).faults[x])`). */
  systems: ReadonlySet<FaultSystem>;
}

function faultVehicle(m: SimMachine): FaultVehicle | null {
  const t = m.telematics;
  if (!t) return null;
  const caps = capabilitiesFor('samsara', t.via);
  const systems = new Set(
    (['j1939', 'obd2', 'oem'] as const).filter((s) => caps && reports(caps.faults[s])),
  );
  if (!systems.size) return null; // "faults not reported" on this route: no faultCodes at all
  const bus = systems.has('j1939') ? 'j1939' : 'obd2';
  return { id: t.id, name: m.unitNo, machineId: m.id, bus, systems };
}

/** The vehicles that report fault codes, optionally filtered by `vehicleIds=a,b`. */
export function faultVehicles(world: SimWorld, vehicleIds?: string | null): FaultVehicle[] {
  const all = simTelematicsMachines(world.farm, 'samsara', { feed: 'vehicle' })
    .map(faultVehicle)
    .filter((v): v is FaultVehicle => v !== null);
  if (!vehicleIds) return all;
  const ids = new Set(vehicleIds.split(',').map((s) => s.trim()));
  return all.filter((v) => ids.has(v.id));
}

/** The knob's state (anything unreadable counts as none). */
export function readFaultsState(state: {
  vendors?: Record<string, Record<string, unknown>>;
}): SamsaraSimFaultsState {
  const p = samsaraSimFaultsStateSchema.safeParse(state.vendors?.[SAMSARA_FAULTS_STATE_KEY]);
  return p.success ? p.data : EMPTY_SAMSARA_SIM_FAULTS;
}

/** The state after a knob change (history capped, oldest first). */
export function withFaultChange(
  state: SamsaraSimFaultsState,
  vehicleId: string,
  setAt: Date,
  codes: SamsaraSimFault[] | null,
): SamsaraSimFaultsState {
  const list = [...(state.vehicles[vehicleId] ?? [])].filter(
    (c) => Date.parse(c.setAt) < setAt.getTime(),
  );
  list.push({ setAt: setAt.toISOString(), codes: codes?.slice(0, SAMSARA_SIM_MAX_CODES) ?? null });
  return { vehicles: { ...state.vehicles, [vehicleId]: list.slice(-MAX_CHANGES) } };
}

/** The scenario's scheduled codes of a vehicle at a sim instant. */
export function scheduledFaults(
  world: Pick<SimWorld, 'scenario' | 'startsAt'>,
  v: Pick<FaultVehicle, 'name'>,
  simTime: Date,
): SamsaraSimFault[] {
  if (world.scenario !== 'breakdown' || v.name !== BREAKDOWN_SEMI_FAULT.unitNo) return [];
  const at = world.startsAt.getTime() + BREAKDOWN_SEMI_FAULT.afterStartMs;
  return simTime.getTime() >= at ? [...BREAKDOWN_SEMI_FAULT.codes] : [];
}

export interface ActiveFaults {
  codes: SamsaraSimFault[];
  from: 'knob' | 'schedule' | 'none';
  setAt: string | null;
}

/** A vehicle's codes at a wall instant (the knob change in force, else the schedule). */
export function activeFaults(
  world: Pick<SimWorld, 'scenario' | 'startsAt'>,
  state: SamsaraSimFaultsState,
  v: Pick<FaultVehicle, 'id' | 'name'>,
  wallMs: number,
  simAt: (wall: Date) => Date,
): ActiveFaults {
  const changes = state.vehicles[v.id] ?? [];
  let change: (typeof changes)[number] | undefined;
  for (const c of changes) if (Date.parse(c.setAt) <= wallMs) change = c;
  if (change?.codes) return { codes: change.codes, from: 'knob', setAt: change.setAt };
  const codes = scheduledFaults(world, v, simAt(new Date(wallMs)));
  return { codes, from: codes.length ? 'schedule' : 'none', setAt: null };
}

// ---- the reading ----------------------------------------------------------------------------

const FMI_TEXT = [
  'Data Valid But Above Normal Operational Range - Most Severe Level',
  'Data Valid But Below Normal Operational Range - Most Severe Level',
  'Data Erratic, Intermittent Or Incorrect',
  'Voltage Above Normal, Or Shorted To High Source',
  'Voltage Below Normal, Or Shorted To Low Source',
  'Current Below Normal Or Open Circuit',
  'Current Above Normal Or Grounded Circuit',
  'Mechanical System Not Responding Or Out Of Adjustment',
  'Abnormal Frequency Or Pulse Width Or Period',
  'Abnormal Update Rate',
  'Abnormal Rate Of Change',
  'Root Cause Not Known',
  'Bad Intelligent Device Or Component',
  'Out Of Calibration',
  'Special Instructions',
  'Data Valid But Above Normal Operating Range - Least Severe Level',
  'Data Valid But Above Normal Operating Range - Moderately Severe Level',
  'Data Valid But Below Normal Operating Range - Least Severe Level',
  'Data Valid But Below Normal Operating Range - Moderately Severe Level',
  'Received Network Data In Error',
] as const;

const SPN_TEXT: Record<number, string> = {
  91: 'Accelerator Pedal Position 1',
  100: 'Engine Oil Pressure',
  110: 'Engine Coolant Temperature',
  111: 'Engine Coolant Level',
  168: 'Battery Potential / Power Input 1',
  190: 'Engine Speed',
  3216: 'Aftertreatment 1 Intake NOx',
  3251: 'Aftertreatment 1 Diesel Particulate Filter Differential Pressure',
  3364: 'Aftertreatment 1 Diesel Exhaust Fluid Tank Quality',
  5246: 'Aftertreatment SCR Operator Inducement Severity',
};

const SOURCE_NAMES: Record<number, string> = {
  0: 'Engine #1',
  1: 'Engine #2',
  3: 'Transmission #1',
  11: 'Brakes - System Controller',
  61: 'Exhaust Emission Controller',
};

/** The faultCodes reading of a vehicle with `codes` at `wallMs` (Samsara's shapes). */
export function faultReading(
  v: FaultVehicle,
  codes: readonly SamsaraSimFault[],
  wallMs: number,
): SamsaraFaultCodesReading {
  const served = codes.filter((c) => v.systems.has(c.system));
  const j1939 = served.filter((c) => c.system === 'j1939');
  const obd = served.filter((c) => c.system === 'obd2');
  const oem = served.filter((c) => c.system === 'oem');
  const reading: SamsaraFaultCodesReading = {
    time: new Date(wallMs).toISOString(),
    canBusType: v.bus === 'j1939' ? 'CANBUS_J1939_500' : 'CANBUS_PASSENGER_15765_11_500',
  };
  if (v.bus === 'j1939' || j1939.length) {
    const lamp = (k: 'stop' | 'warning' | 'protect' | 'emissions') =>
      j1939.some((c) => c.lamps?.[k] === true);
    reading.j1939 = {
      checkEngineLights: {
        stopIsOn: lamp('stop'),
        warningIsOn: lamp('warning'),
        protectIsOn: lamp('protect'),
        emissionsIsOn: lamp('emissions'),
      },
      diagnosticTroubleCodes: j1939.map((c) => {
        const tx = c.txId ?? 0;
        return {
          spnId: c.spn,
          fmiId: c.fmi,
          txId: tx,
          milStatus: c.lamps?.emissions ? 1 : 0,
          occurrenceCount: c.occurrenceCount ?? 1,
          ...(SPN_TEXT[c.spn] ? { spnDescription: SPN_TEXT[c.spn] } : {}),
          ...(FMI_TEXT[c.fmi] ? { fmiDescription: FMI_TEXT[c.fmi] } : {}),
          ...(SOURCE_NAMES[tx] ? { sourceAddressName: SOURCE_NAMES[tx] } : {}),
          ...(c.description ? { vendorSpecificFields: { dtcDescription: c.description } } : {}),
        };
      }),
    };
  }
  if (v.bus === 'obd2' || obd.length) {
    const modules = new Map<number, typeof obd>();
    if (v.bus === 'obd2') modules.set(OBD_ENGINE_TX_ID, []);
    for (const c of obd) {
      const tx = c.txId ?? OBD_ENGINE_TX_ID;
      modules.set(tx, [...(modules.get(tx) ?? []), c]);
    }
    const list = [...modules.entries()].map(([txId, cs]) => {
      const dtcs = (state: string) =>
        cs
          .filter((c) => (c.state ?? 'confirmed') === state)
          .map((c) => ({
            dtcId: obdDtcId(c.dtc),
            dtcShortCode: c.dtc,
            ...(c.description ? { dtcDescription: c.description } : {}),
          }));
      const mil = cs.some((c) => c.mil ?? (c.state ?? 'confirmed') !== 'pending');
      return {
        txId,
        milStatus: mil,
        ignitionType: 'spark',
        confirmedDtcs: dtcs('confirmed'),
        pendingDtcs: dtcs('pending'),
        permanentDtcs: dtcs('permanent'),
      };
    });
    reading.obdii = {
      checkEngineLightIsOn: list.some((m) => m.milStatus),
      diagnosticTroubleCodes: list,
    };
  }
  if (oem.length) {
    reading.oem = {
      diagnosticTroubleCodes: oem.map((c) => ({
        codeIdentifier: c.code,
        ...(c.description ? { codeDescription: c.description } : {}),
        ...(c.severity ? { codeSeverity: c.severity } : {}),
        ...(c.source ? { codeSource: c.source } : {}),
      })),
    };
  }
  return reading;
}

/** Stable comparison key of a code list (the feed reports a reading when it changes). */
export const faultsKey = (codes: readonly SamsaraSimFault[]) => JSON.stringify(codes);
