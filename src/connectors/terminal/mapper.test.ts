/**
 * The Terminal mapper (pure): metric units to the port's, the live / last-known split and the
 * provider in the vendor id, stat logs and latest counters with their readings, every fault
 * protocol and state (and the events the app must not store as given), the vehicle's group names
 * as kind tags, and /providers rows.
 */
import { describe, expect, test } from 'vitest';
import { DELTA_FAULT_AGE_OUT_SECONDS, normalizedFaultSchema } from '../../domain/fault-codes';
import { DEFAULT_VEHICLE_KIND_TAGS } from '../../domain/vehicles';
import {
  mapTerminalFault,
  mapTerminalPosition,
  mapTerminalProviders,
  mapTerminalStat,
  mapTerminalVehicle,
  terminalEngineOn,
  terminalProviderRow,
  terminalVendorId,
} from './mapper';
import type {
  TerminalFaultEvent,
  TerminalHistoricalLocation,
  TerminalLatestLocation,
  TerminalProvider,
  TerminalStatLog,
} from './schemas';

const CONN = 'conn_01JTEST';
const VCL = 'vcl_01JTESTVEHICLE';

const hist = (over: Partial<TerminalHistoricalLocation> = {}): TerminalHistoricalLocation => ({
  id: 'vcl_loc_01J1',
  provider: 'omnitracs-xrs',
  vehicle: VCL,
  locatedAt: '2026-10-15T13:00:00Z',
  location: { longitude: -84.5, latitude: 42.7 },
  heading: 370,
  speed: 100,
  metadata: { modifiedAt: '2026-10-15T13:00:10Z' },
  ...over,
});

const latest = (over: Partial<TerminalLatestLocation> = {}): TerminalLatestLocation => ({
  provider: 'omnitracs-xrs',
  vehicle: VCL,
  locatedAt: '2026-10-15T13:00:20.000Z',
  location: { longitude: -84.5, latitude: 42.7 },
  heading: 90,
  speed: 0,
  odometer: 160_934.4,
  engineState: 'idle',
  engineRuntime: 3_600_000 * 1234.5,
  ...over,
});

const event = (over: Partial<TerminalFaultEvent> = {}): TerminalFaultEvent => ({
  id: 'fc_evt_01J1',
  provider: 'samsara',
  vehicle: VCL,
  protocol: 'j1939',
  status: 'open',
  code: 'SPN3031-FMI9',
  observedAt: '2026-10-15T13:00:00Z',
  milStatus: 'on',
  j1939: { spn: 3031, fmi: 9, occurrenceCount: 15, sourceAddress: 0, spnDescription: 'SDC #1' },
  metadata: { modifiedAt: '2026-10-15T13:05:00Z' },
  ...over,
});

const fault = (e: TerminalFaultEvent) =>
  mapTerminalFault({ connectionId: CONN, event: e })[0]?.faultCodes?.[0];

describe('positions', () => {
  test('history is live, km/h → mph, heading into [0, 360), no engine state; the provider names the vendor', () => {
    const [p] = mapTerminalPosition({ connectionId: CONN, kind: 'history', location: hist() });
    expect(p).toEqual({
      source: 'terminal',
      externalMachineId: VCL,
      sourceOrg: CONN,
      ts: '2026-10-15T13:00:00.000Z',
      lng: -84.5,
      lat: 42.7,
      heading: 10,
      speedMph: 62.14,
      engineOn: null,
      positionSource: 'eld',
      positionKind: 'live',
      provider: 'omnitracs-xrs',
    });
    expect(terminalVendorId('omnitracs-xrs')).toBe('terminal_omnitracs_xrs');
  });

  test('the latest location is last known, with its engine state; missing heading and speed are null', () => {
    const [p] = mapTerminalPosition({
      connectionId: CONN,
      kind: 'latest',
      location: latest({ heading: null, speed: undefined }),
    });
    expect(p).toMatchObject({
      positionKind: 'last_known',
      engineOn: true,
      heading: null,
      speedMph: null,
    });
    // An expanded vehicle object maps by its id.
    const [q] = mapTerminalPosition({
      connectionId: CONN,
      kind: 'history',
      location: hist({ vehicle: { id: VCL } }),
    });
    expect(q?.externalMachineId).toBe(VCL);
  });

  test('engine states: on and idle run, off does not, anything else is unknown', () => {
    expect(['on', 'idle', 'off', 'IDLE', 'parked', null].map(terminalEngineOn)).toEqual([
      true,
      true,
      false,
      true,
      null,
      null,
    ]);
  });
});

describe('stats', () => {
  const log = (over: Partial<TerminalStatLog>): TerminalStatLog => ({
    id: 'vcl_st_01J1',
    provider: 'geotab',
    type: 'odometer',
    timestamp: '2026-10-15T13:00:00Z',
    vehicle: VCL,
    metadata: { modifiedAt: '2026-10-15T13:00:10Z' },
    ...over,
  });
  const stat = (l: TerminalStatLog) => mapTerminalStat({ connectionId: CONN, kind: 'log', log: l });

  test('each stat log type: engine runtime ms → h, odometer km → mi, fuel %, engine state', () => {
    expect(stat(log({ type: 'engine_runtime', duration: 3_600_000 * 11_960.25 }))[0]).toMatchObject(
      {
        engineHours: 11_960.25,
        readings: {
          engineHours: {
            raw: 3_600_000 * 11_960.25,
            rawUnit: 'milliseconds',
            field: 'engine_runtime',
            adjusted: null,
          },
        },
      },
    );
    expect(stat(log({ type: 'odometer', odometer: 1609.344 }))[0]).toMatchObject({
      odometerMi: 1000,
      readings: { odometerMi: { raw: 1609.344, rawUnit: 'kilometers', field: 'odometer' } },
    });
    expect(stat(log({ type: 'fuel_level', fuelPercentage: 62.44 }))[0]).toMatchObject({
      fuelPct: 62.4,
    });
    expect(stat(log({ type: 'engine_state', state: 'off' }))[0]).toMatchObject({
      engineOn: false,
      readings: { engineOn: { raw: false, rawUnit: 'boolean', field: 'engine_state' } },
    });
    const [s] = stat(log({ type: 'odometer', odometer: 10 }));
    expect(s).toMatchObject({
      source: 'terminal',
      externalMachineId: VCL,
      sourceOrg: CONN,
      ts: '2026-10-15T13:00:00.000Z',
    });
  });

  test('a stat it does not read, a missing value or a negative one maps to nothing (never 0)', () => {
    expect(stat(log({ type: 'engine_rpm' }))).toEqual([]);
    expect(stat(log({ type: 'odometer', odometer: null }))).toEqual([]);
    expect(stat(log({ type: 'engine_runtime', duration: -5 }))).toEqual([]);
  });

  test('a latest location carries the counters it has (fuel absent when the provider has none)', () => {
    const [s] = mapTerminalStat({ connectionId: CONN, kind: 'latest', location: latest() });
    expect(s).toMatchObject({ engineHours: 1234.5, odometerMi: 100_000, engineOn: true });
    expect(s).not.toHaveProperty('fuelPct');
    const [f] = mapTerminalStat({
      connectionId: CONN,
      kind: 'latest',
      location: latest({ fuel: { primaryPercentage: 50 } }),
    });
    expect(f?.fuelPct).toBe(50);
    expect(f?.readings?.fuelPct?.field).toBe('fuel.primaryPercentage');
    expect(
      mapTerminalStat({
        connectionId: CONN,
        kind: 'latest',
        location: latest({ odometer: null, engineState: null, engineRuntime: null }),
      }),
    ).toEqual([]);
  });
});

describe('faults', () => {
  test('a j1939 event: SPN/FMI, address, count, MIL → malfunction (warning); a delta with the age-out', () => {
    const [s] = mapTerminalFault({ connectionId: CONN, event: event() });
    expect(s).toMatchObject({
      source: 'terminal',
      externalMachineId: VCL,
      sourceOrg: CONN,
      ts: '2026-10-15T13:00:00.000Z',
      faultReport: 'delta',
      faultAgeOutSeconds: DELTA_FAULT_AGE_OUT_SECONDS,
    });
    const f = s?.faultCodes?.[0];
    expect(normalizedFaultSchema.parse(f)).toBeTruthy();
    expect(f).toMatchObject({
      system: 'j1939',
      code: 'J1939 SPN 3031 FMI 9',
      spn: 3031,
      fmi: 9,
      sourceAddress: 0,
      occurrenceCount: 15,
      lamps: { malfunction: true },
      severity: 'warning',
      state: 'open',
      lastSeenAt: '2026-10-15T13:00:00.000Z',
      vendorSeverity: null,
      description: 'SDC #1',
    });
  });

  test('no MIL is info; a closed event closes at observedAt; pending stays open as context', () => {
    expect(fault(event({ milStatus: 'off' }))?.severity).toBe('info');
    expect(fault(event({ milStatus: undefined }))?.lamps).toBeNull();
    expect(fault(event({ status: 'closed', observedAt: '2026-10-15T14:00:00Z' }))).toMatchObject({
      state: 'closed',
      closedAt: '2026-10-15T14:00:00.000Z',
    });
    expect(fault(event({ status: 'pending' }))).toMatchObject({
      state: 'open',
      vendorSeverity: 'pending',
    });
  });

  test('obdii → obd2 with the DTC (from the obdii block, else the code); MIL on is a warning', () => {
    const f = fault(
      event({
        protocol: 'obdii',
        code: 'P0087',
        description: undefined,
        j1939: undefined,
        obdii: { code: 'p0087', description: 'Fuel Rail Pressure Too Low' },
      }),
    );
    expect(normalizedFaultSchema.parse(f)).toBeTruthy();
    expect(f).toMatchObject({
      system: 'obd2',
      dtc: 'p0087',
      code: 'P0087',
      severity: 'warning',
      description: 'Fuel Rail Pressure Too Low',
    });
    expect(
      fault(event({ protocol: 'obdii', code: 'U0100', obdii: null, milStatus: 'off' })),
    ).toMatchObject({
      dtc: 'U0100',
      severity: 'info',
    });
  });

  test('skipped: a j1939 event with no FMI, out-of-range SPN/FMI, an unknown protocol; an address over 255 is dropped', () => {
    expect(
      mapTerminalFault({ connectionId: CONN, event: event({ j1939: { spn: 3031 } }) }),
    ).toEqual([]);
    expect(
      mapTerminalFault({ connectionId: CONN, event: event({ j1939: { spn: 600_000, fmi: 1 } }) }),
    ).toEqual([]);
    expect(
      mapTerminalFault({ connectionId: CONN, event: event({ j1939: { spn: 1, fmi: 32 } }) }),
    ).toEqual([]);
    expect(
      mapTerminalFault({ connectionId: CONN, event: event({ protocol: 'proprietary' }) }),
    ).toEqual([]);
    expect(
      fault(event({ j1939: { spn: 3031, fmi: 9, sourceAddress: 256, occurrenceCount: -1 } })),
    ).toMatchObject({
      sourceAddress: null,
      occurrenceCount: null,
    });
  });
});

describe('vehicles and providers', () => {
  test('group names are the only kind hint; via is never claimed', () => {
    const v = {
      id: VCL,
      provider: 'omnitracs-xrs',
      name: 'H3',
      make: 'Mack',
      model: 'Anthem',
      year: 2021,
      vin: '1M1AN4GY0LM000001',
    };
    expect(
      mapTerminalVehicle(
        { connectionId: CONN, vehicle: v, groups: ['Pickup'] },
        DEFAULT_VEHICLE_KIND_TAGS,
      )[0],
    ).toEqual({
      source: 'terminal',
      sourceOrg: CONN,
      externalId: VCL,
      name: 'H3',
      tags: ['Pickup'],
      kindFromTags: 'pickup',
      via: null,
      make: 'Mack',
      model: 'Anthem',
      year: 2021,
      vin: '1M1AN4GY0LM000001',
    });
    expect(
      mapTerminalVehicle({
        connectionId: CONN,
        vehicle: { id: VCL, provider: 'x' },
        groups: [],
      })[0],
    ).toMatchObject({ name: VCL, kindFromTags: null, make: null, year: null });
  });

  test('a /providers entry → its capability row (stat types, faults doc, no DEF, no OEM)', () => {
    const p: TerminalProvider = {
      name: 'PeopleNet',
      code: 'people-net',
      supportedModels: {
        LatestVehicleLocation: { supportedOperations: { read: 'supported' } },
        VehicleLocation: { supportedOperations: { read: 'not_supported_by_provider' } },
        VehicleStatLog: {
          supportedOperations: { read: 'supported' },
          types: ['fuel_level', 'odometer'],
        },
        FaultCodeEvent: { supportedOperations: { read: 'not_supported_by_terminal' } },
      },
    };
    expect(terminalProviderRow(p)).toEqual({
      code: 'people-net',
      label: 'PeopleNet',
      vendorId: 'terminal_people_net',
      capabilities: {
        positions: { live: 'no', lastKnown: 'yes' },
        stats: {
          engineHours: 'no',
          odometerMi: 'yes',
          fuelPct: 'yes',
          defPct: 'no',
          engineOn: 'no',
        },
        faults: { j1939: 'no', obd2: 'no', oem: 'no' },
        fieldOperations: 'no',
        webhooks: 'no',
      },
    });
  });

  test('one row per provider our connections use, in code order; an unlisted code gets an all-unknown row', () => {
    const [rows] = mapTerminalProviders({
      codes: ['zonar', 'people-net', 'people-net'],
      providers: [{ name: 'PeopleNet', code: 'people-net', supportedModels: {} }],
    });
    expect(rows?.map((r) => [r.code, r.label, r.capabilities.positions.live])).toEqual([
      ['people-net', 'PeopleNet', 'no'],
      ['zonar', 'zonar', 'unknown'],
    ]);
  });
});
