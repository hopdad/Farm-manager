/**
 * Builds the DOC-DERIVED MyGeotab replay fixtures (slice 1f.2, the trucks builder;
 * docs/contracts-1f.md §B.6). SHAPES: Geotab's machine-readable reference
 * https://my.geotab.com/api.json (FeedResult, LogRecord, StatusData, FaultData, Diagnostic,
 * FailureMode, Device, Group) and the JSON-RPC envelope of developers.geotab.com/myGeotab/guides/
 * concepts, typed by ../schemas.ts. VALUES: the simulated demo farm (src/sim, seed 1,
 * harvest-day): no real farm data; the one device is the hired hauler H2 under the id the demo
 * seed maps (`simExternalRefs`), so `CONNECTOR_GEOTAB=replay` drives the board.
 *
 * Every call is a POST to /apiv1, told apart by its JSON body (`request.body`, a subset:
 * `{ method, params: { typeName } }`). GetFeed exchanges for a known `fromVersion` come before
 * the general one (first match wins):
 *   LogRecord   always H2's fix at the anchor (1 s time-shift step: a fresh fix every poll)
 *   StatusData  the first poll gets H2's readings, every diagnostic as the feed sends them (the
 *               client drops the ones it doesn't read); from STATS_VERSION on, nothing new
 *   FaultData   the first poll gets a J1939 fault (red stop lamp) and a cleared OBD-II code;
 *               from FAULTS_VERSION on, nothing new
 *   Get         Diagnostic and FailureMode (the lookups), Device and Group (the vehicle list)
 * Authenticate is skipped in replay (a fixed session, like OAuth for Deere and Samsara).
 *
 * The committed JSON under ./doc-derived/ is this module's output; ./fixtures.test.ts fails when
 * they drift. Regenerate with
 *   pnpm exec tsx src/connectors/geotab/fixtures/write.ts   then   pnpm lint:fix
 */
import { simTelematicsMachines } from '../../../sim/types';
import {
  GEOTAB_SIM_DIAGNOSTICS,
  GEOTAB_SIM_FAILURE_MODES,
  GEOTAB_SIM_GROUPS,
} from '../../../sim/vendors/geotab/catalog';
import { createDemoWorld, type DemoWorld } from '../../../sim/world';
import type { ReplayFixture } from '../../replay';
import type { GeotabFeedResult } from '../schemas';

const SEED = 1;
/** The instant the fixtures treat as "now" (the Samsara and Motive fixtures' anchor). */
export const GEOTAB_ANCHOR = '2026-10-15T13:00:00.000Z';
export const POSITIONS_VERSION = '0000000000a1b2c3';
export const STATS_VERSION = '000000000014c3ee';
export const FAULTS_VERSION = '0000000000000002';

const API = 'https://my.geotab.com/api.json';
const SIMULATED =
  'Values: the simulated demo farm (src/sim, seed 1, harvest-day), no real farm data.';
const REF = {
  positions: `${API} (GetFeed LogRecord: FeedResult { data, toVersion }; LogRecord dateTime, device, latitude, longitude, speed km/h) and https://developers.geotab.com/myGeotab/guides/dataFeed`,
  stats: `${API} (GetFeed StatusData: every diagnostic, search ignored; StatusData dateTime, device, diagnostic, data; KnownId DiagnosticEngineHoursId, DiagnosticOdometerId, DiagnosticFuelLevelId, DiagnosticIgnitionId)`,
  faults: `${API} (GetFeed FaultData: diagnostic, failureMode, controller, faultState, lamps, severity, sourceAddress, count) and https://support.geotab.com/mygeotab/doc/obd-fault-data`,
  lookups: `${API} (Get Diagnostic: code, source, controller, unitOfMeasure; Get FailureMode: code = FMI)`,
  vehicles: `${API} (Get Device: name, serialNumber, deviceType, vehicleIdentificationNumber, groups; Get Group)`,
};
const KMH_PER_MPH = 1.609344;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const rpc = (result: unknown) => ({ result, jsonrpc: '2.0' });
const post = (method: string, typeName: string, extra: Record<string, unknown> = {}) => ({
  method: 'POST' as const,
  path: '/apiv1',
  body: { method, params: { typeName, ...extra } },
});

function hauler(world: DemoWorld) {
  const m = simTelematicsMachines(world.farm, 'geotab')[0];
  if (!m?.telematics) throw new Error('the demo farm has no Geotab device');
  const s = world.machineAt(m.id, new Date(GEOTAB_ANCHOR));
  if (!s) throw new Error('no sample for the Geotab device at the anchor');
  return { m, id: m.telematics.id, s };
}

function positionsFixture(world: DemoWorld): ReplayFixture {
  const { id, s } = hauler(world);
  const feed: GeotabFeedResult = {
    data: [
      {
        id: 'b1A2F3',
        dateTime: GEOTAB_ANCHOR,
        device: { id },
        latitude: r6(s.lat),
        longitude: r6(s.lng),
        speed: Math.round(Math.max(0, s.speedMph) * KMH_PER_MPH),
      },
    ],
    toVersion: POSITIONS_VERSION,
  };
  return {
    format: 1,
    source: 'geotab',
    stream: 'positions',
    kind: 'doc-derived',
    reference: `${REF.positions}. ${SIMULATED}`,
    anchor: GEOTAB_ANCHOR,
    shiftStepSeconds: 1,
    exchanges: [
      { request: post('GetFeed', 'LogRecord'), response: { status: 200, body: rpc(feed) } },
    ],
  };
}

function statsFixture(world: DemoWorld): ReplayFixture {
  const { id, s } = hauler(world);
  const readings: [string, number][] = [
    ['DiagnosticEngineHoursId', Math.round(s.engineHours * 3600)],
    ['DiagnosticOdometerId', Math.round(s.odometerMi * 1609.344)],
    ['DiagnosticFuelLevelId', r1(s.fuelPct)],
    ['DiagnosticIgnitionId', s.engineOn ? 1 : 0],
    ['DiagnosticEngineSpeedId', s.engineOn ? 1_250 : 0],
    ['DiagnosticEngineCoolantTemperatureId', s.engineOn ? 88 : 18],
  ];
  const feed: GeotabFeedResult = {
    data: readings.map(([diagnostic, data], k) => ({
      id: `a7C${k}`,
      version: `000000000014c3e${k}`,
      dateTime: GEOTAB_ANCHOR,
      device: { id },
      diagnostic: { id: diagnostic },
      data,
    })),
    toVersion: STATS_VERSION,
  };
  return {
    format: 1,
    source: 'geotab',
    stream: 'stats',
    kind: 'doc-derived',
    reference: `${REF.stats}. ${SIMULATED}`,
    anchor: GEOTAB_ANCHOR,
    exchanges: [
      {
        request: post('GetFeed', 'StatusData', { fromVersion: STATS_VERSION }),
        response: { status: 200, body: rpc({ data: [], toVersion: STATS_VERSION }) },
      },
      { request: post('GetFeed', 'StatusData'), response: { status: 200, body: rpc(feed) } },
    ],
  };
}

function faultsFixture(world: DemoWorld): ReplayFixture {
  const { id } = hauler(world);
  const feed: GeotabFeedResult = {
    data: [
      {
        id: 'aF1',
        dateTime: '2026-10-15T12:52:00.000Z',
        device: { id },
        diagnostic: { id: 'aSimSpn110' },
        failureMode: { id: 'aSimFmi0' },
        controller: { id: 'ControllerJ1939EngineNo1Id' },
        count: 1,
        faultState: 'Active',
        faultLampState: 'Stop',
        redStopLamp: true,
        amberWarningLamp: false,
        protectWarningLamp: false,
        malfunctionLamp: false,
        severity: 'CheckImmediately',
        sourceAddress: 0,
        dismissDateTime: null,
      },
      {
        id: 'aF2',
        dateTime: '2026-10-15T12:40:00.000Z',
        device: { id },
        diagnostic: { id: 'aSimObd309' },
        failureMode: { id: 'NoFailureModeId' },
        controller: { id: 'ControllerObdPowertrainId' },
        count: 1,
        faultState: 'Inactive',
        faultLampState: 'None',
        redStopLamp: false,
        amberWarningLamp: false,
        protectWarningLamp: false,
        malfunctionLamp: false,
        severity: 'CheckAtNextHalt',
        sourceAddress: null,
        dismissDateTime: null,
      },
    ],
    toVersion: FAULTS_VERSION,
  };
  return {
    format: 1,
    source: 'geotab',
    stream: 'faults',
    kind: 'doc-derived',
    reference: `${REF.faults}. ${SIMULATED}`,
    anchor: GEOTAB_ANCHOR,
    exchanges: [
      {
        request: post('GetFeed', 'FaultData', { fromVersion: FAULTS_VERSION }),
        response: { status: 200, body: rpc({ data: [], toVersion: FAULTS_VERSION }) },
      },
      { request: post('GetFeed', 'FaultData'), response: { status: 200, body: rpc(feed) } },
    ],
  };
}

function lookupsFixture(): ReplayFixture {
  return {
    format: 1,
    source: 'geotab',
    stream: 'lookups',
    kind: 'doc-derived',
    reference: `${REF.lookups}. ${SIMULATED}`,
    anchor: GEOTAB_ANCHOR,
    exchanges: [
      {
        request: post('Get', 'Diagnostic'),
        response: { status: 200, body: rpc(GEOTAB_SIM_DIAGNOSTICS) },
      },
      {
        request: post('Get', 'FailureMode'),
        response: { status: 200, body: rpc(GEOTAB_SIM_FAILURE_MODES) },
      },
    ],
  };
}

function vehiclesFixture(world: DemoWorld): ReplayFixture {
  const { m, id } = hauler(world);
  const device = {
    id,
    name: m.unitNo,
    serialNumber: `G9SIM${id.toUpperCase()}`.slice(0, 12),
    deviceType: 'GO9',
    vehicleIdentificationNumber: '',
    licensePlate: '',
    groups: [{ id: 'GroupCompanyId' }, { id: 'b27C1' }],
    activeFrom: '2025-01-01T00:00:00.000Z',
    activeTo: '2050-01-01T00:00:00.000Z',
    timeZoneId: 'America/Detroit',
  };
  return {
    format: 1,
    source: 'geotab',
    stream: 'vehicles',
    kind: 'doc-derived',
    reference: `${REF.vehicles}. ${SIMULATED}`,
    anchor: GEOTAB_ANCHOR,
    exchanges: [
      { request: post('Get', 'Device'), response: { status: 200, body: rpc([device]) } },
      { request: post('Get', 'Group'), response: { status: 200, body: rpc(GEOTAB_SIM_GROUPS) } },
    ],
  };
}

/** Every Geotab doc-derived fixture, by its path under ./doc-derived/. */
export function buildGeotabDocDerivedFixtures(): Record<string, ReplayFixture> {
  const world = createDemoWorld({ scenario: 'harvest-day', seed: SEED });
  return {
    'positions/01-log-records.json': positionsFixture(world),
    'stats/01-status-data.json': statsFixture(world),
    'faults/01-fault-data.json': faultsFixture(world),
    'lookups/01-diagnostics.json': lookupsFixture(),
    'vehicles/01-devices.json': vehiclesFixture(world),
  };
}
