/**
 * Builds the DOC-DERIVED Terminal replay fixtures (slice 1f.2, terminal-pickups;
 * docs/contracts-1f.md §B.6, §8).
 *
 * SHAPES: Terminal's official OpenAPI 3.1 (https://api.withterminal.com/tsp/openapi, the same
 * document as https://docs.withterminal.com/terminal.openapi.json; checked Oct 30, 2026):
 * FullConnection, Provider (its unauthenticated GET /providers catalog entry for Omnitracs XRS,
 * verbatim but trimmed), Vehicle with ExpandedGroup, LatestVehicleLocation, VehicleLocation,
 * VehicleStatLog, FaultCodeEvent; the list envelope `{ results, next? }`; metric units. VALUES:
 * the simulated demo farm (src/sim, seed 1, harvest-day): no real farm data; the one vehicle is
 * the hired hauler H3, under the connection and vehicle id the demo seed maps
 * (`simExternalRefs`: ('terminal', 'machine', <vcl id>, SIM_TERMINAL_CONNECTION_ID)), so
 * `CONNECTOR_TERMINAL=replay` drives the board.
 *
 * TIME: every instant is written relative to ANCHOR and moved to the call by the replay
 * transport (1 s steps for positions, so H3's latest fix is always "now" and its newest
 * breadcrumb 10 s older, as Terminal's sync lags). H3 is parked at the shop in every scenario,
 * so a static spot with fresh times is what the board should show. The fault events are a
 * coolant fault opened and closed, and a low-severity SCR code still open.
 *
 * The committed JSON under ./doc-derived/ is this module's output; ./fixtures.test.ts fails when
 * it drifts. Regenerate with
 *   pnpm exec tsx src/connectors/terminal/fixtures/write.ts   then   pnpm lint:fix
 */
import { SIM_TERMINAL_CONNECTION_ID, simTelematicsMachines } from '../../../sim/types';
import { SIM_TERMINAL_PROVIDERS } from '../../../sim/vendors/terminal/catalog';
import { createDemoWorld } from '../../../sim/world';
import type { ReplayFixture } from '../../replay';
import type {
  TerminalConnection,
  TerminalFaultEvent,
  TerminalHistoricalLocation,
  TerminalLatestLocation,
  TerminalStatLog,
  TerminalVehicle,
} from '../schemas';

const SEED = 1;
/** The instant the fixtures treat as "now". */
export const ANCHOR = '2026-10-15T13:00:00.000Z';
/** The simulated instant H3 is sampled at (parked: any instant of the day gives the same spot). */
const SIM_AT = '2026-10-15T12:00:00.000Z';
/** Breadcrumbs every 10 s, stored 10 s after the fact (the stand-in's grid and lag). */
const EVERY_MS = 10_000;
const LAG_MS = 10_000;
const HISTORY_MS = 10 * 60_000;
const STATS_EVERY_MS = 60_000;
export const SIM_TERMINAL_REPLAY_TOKEN = 'con_tkn_replaySimHauler0000000000001';

const SPEC = 'https://api.withterminal.com/tsp/openapi';
const DOCS = 'https://docs.withterminal.com/api-reference';
const SIMULATED =
  'Values: the simulated demo farm (src/sim, seed 1, harvest-day), no real farm data.';
const KM_PER_MI = 1.609344;

const at = (offsetMs: number) => new Date(Date.parse(ANCHOR) + offsetMs).toISOString();
const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const ulidish = (prefix: string, n: number) => `${prefix}01JREPLAY${String(n).padStart(17, '0')}`;

function h3() {
  const world = createDemoWorld({ scenario: 'harvest-day', seed: SEED });
  const m = simTelematicsMachines(world.farm, 'terminal')[0];
  if (!m?.telematics) throw new Error('terminal fixtures: the demo world has no Terminal vehicle');
  const s = world.machineAt(m.id, new Date(SIM_AT));
  if (!s) throw new Error('terminal fixtures: H3 has no position');
  return { machine: m, id: m.telematics.id, provider: m.telematics.tsp ?? 'omnitracs-xrs', s };
}

function fixture(
  stream: string,
  reference: string,
  exchanges: ReplayFixture['exchanges'],
  shiftStepSeconds?: number,
): ReplayFixture {
  return {
    format: 1,
    source: 'terminal',
    stream,
    kind: 'doc-derived',
    reference: `${reference}. ${SIMULATED}`,
    anchor: ANCHOR,
    ...(shiftStepSeconds ? { shiftStepSeconds } : {}),
    basePath: '/tsp/v1',
    exchanges,
  };
}

const list = (results: unknown[]) => ({ status: 200, body: { results } });

function connections(provider: string): ReplayFixture {
  const conn: TerminalConnection = {
    id: SIM_TERMINAL_CONNECTION_ID,
    company: { name: 'Sim Hauling LLC', dotNumbers: [] },
    account: { name: 'Sim Hauling LLC', dotNumbers: [] },
    provider: { code: provider, name: 'Omnitracs XRS' },
    syncMode: 'automatic',
    token: SIM_TERMINAL_REPLAY_TOKEN,
    tags: [],
    status: 'connected',
    options: { ingestHistoryFromSourceSystem: true },
    linkUrl: `https://link.withterminal.com/connection/${SIM_TERMINAL_CONNECTION_ID}?key=pk_sandbox_replay`,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
  };
  return fixture(
    'connections',
    `${SPEC} (GET /connections?status=connected: FullConnection with its token; ${DOCS}/connections/list-connections)`,
    [
      {
        request: { method: 'GET', path: '/connections', query: { status: 'connected' } },
        response: list([conn]),
      },
    ],
  );
}

function providers(provider: string): ReplayFixture {
  return fixture(
    'providers',
    `${SPEC} (GET /providers: a bare array of Provider, no key needed; the Omnitracs XRS entry as Terminal's catalog listed it on Oct 30, 2026, trimmed; ${DOCS}/providers/list-providers)`,
    [
      {
        request: { method: 'GET', path: '/providers' },
        response: { status: 200, body: SIM_TERMINAL_PROVIDERS.filter((p) => p.code === provider) },
      },
    ],
  );
}

function vehicles(v: ReturnType<typeof h3>): ReplayFixture {
  const body: TerminalVehicle = {
    id: v.id,
    sourceId: '402870',
    provider: v.provider,
    status: 'active',
    name: v.machine.unitNo,
    make: v.machine.make,
    model: v.machine.model.replace(/ \+ .*$/, ''),
    year: v.machine.year,
    groups: [
      {
        id: 'group_01JREPLAYHIREDTRUCKS0000001',
        sourceId: '12',
        provider: v.provider,
        name: 'Hired trucks',
        metadata: {
          addedAt: '2026-09-01T12:00:00.000Z',
          modifiedAt: '2026-09-01T12:00:00.000Z',
          visibility: 'visible',
        },
      },
    ],
    metadata: {
      addedAt: '2026-09-01T12:00:00.000Z',
      modifiedAt: '2026-09-01T12:00:00.000Z',
      deletedAt: null,
      visibility: 'visible',
    },
  };
  return fixture(
    'vehicles',
    `${SPEC} (GET /vehicles?expand=groups: Vehicle, ExpandedGroup; no tags on a Terminal vehicle; ${DOCS}/vehicles/list-vehicles)`,
    [{ request: { method: 'GET', path: '/vehicles' }, response: list([body]) }],
  );
}

function positions(v: ReturnType<typeof h3>): ReplayFixture {
  const { s } = v;
  const loc = { longitude: r(s.lng, 7), latitude: r(s.lat, 7) };
  const latest: TerminalLatestLocation = {
    provider: v.provider,
    vehicle: v.id,
    locatedAt: ANCHOR,
    location: loc,
    heading: r(s.heading, 1),
    speed: 0,
    odometer: r(s.odometerMi * KM_PER_MI, 2),
    engineState: s.engineOn ? 'idle' : 'off',
    engineRuntime: Math.round(s.engineHours * 3_600_000),
  };
  const history: TerminalHistoricalLocation[] = [];
  let n = 0;
  // Stored by ANCHOR: record times ANCHOR − 10 min … ANCHOR − 10 s.
  for (let t = -HISTORY_MS; t <= -LAG_MS; t += EVERY_MS) {
    n++;
    history.push({
      id: ulidish('vcl_loc_', n),
      sourceId: String(1_000 + n),
      provider: v.provider,
      vehicle: v.id,
      locatedAt: at(t),
      location: loc,
      heading: r(s.heading, 1),
      speed: 0,
      metadata: { modifiedAt: at(t + LAG_MS) },
    });
  }
  return fixture(
    'positions',
    `${SPEC} (GET /vehicles/locations: LatestVehicleLocation, a live call to the provider, odometer km, engine runtime ms; GET /vehicles/{vehicleId}/locations: VehicleLocation with metadata.modifiedAt; ${DOCS}/vehicles/list-latest-vehicle-locations, ${DOCS}/vehicles/list-historical-vehicle-locations)`,
    [
      { request: { method: 'GET', path: '/vehicles/locations' }, response: list([latest]) },
      {
        request: { method: 'GET', path: `/vehicles/${v.id}/locations` },
        response: list(history),
      },
    ],
    1,
  );
}

function stats(v: ReturnType<typeof h3>): ReplayFixture {
  const { s } = v;
  const logs: TerminalStatLog[] = [];
  let n = 0;
  for (let t = -HISTORY_MS; t <= -STATS_EVERY_MS; t += STATS_EVERY_MS) {
    // Parked: the counters stand still; the engine is off.
    const base = {
      provider: v.provider,
      vehicle: v.id,
      timestamp: at(t),
      metadata: { modifiedAt: at(t + LAG_MS) },
    };
    logs.push(
      {
        ...base,
        id: ulidish('vcl_st_', ++n),
        sourceId: `${t}:engine_state`,
        type: 'engine_state',
        state: s.engineOn ? 'idle' : 'off',
      },
      {
        ...base,
        id: ulidish('vcl_st_', ++n),
        sourceId: `${t}:odometer`,
        type: 'odometer',
        odometer: r(s.odometerMi * KM_PER_MI, 2),
      },
      {
        ...base,
        id: ulidish('vcl_st_', ++n),
        sourceId: `${t}:engine_runtime`,
        type: 'engine_runtime',
        duration: Math.round(s.engineHours * 3_600_000),
      },
    );
  }
  return fixture(
    'stats',
    `${SPEC} (GET /vehicles/{vehicleId}/stats/historical?types=: VehicleStatLog, one value field by type: odometer km, engine_runtime duration ms, engine_state on/off/idle; ${DOCS}/vehicles/list-historical-vehicle-stats)`,
    [
      {
        request: { method: 'GET', path: `/vehicles/${v.id}/stats/historical` },
        response: list(logs),
      },
    ],
  );
}

function faults(v: ReturnType<typeof h3>): ReplayFixture {
  const coolant = (status: 'open' | 'closed', t: number, n: number): TerminalFaultEvent => ({
    id: ulidish('fc_evt_', n),
    provider: v.provider,
    vehicle: v.id,
    protocol: 'j1939',
    status,
    code: 'SPN110-FMI0',
    description:
      'Engine Coolant Temperature - Data Valid But Above Normal Operational Range - Most Severe Level',
    observedAt: at(t),
    milStatus: status === 'open' ? 'on' : 'off',
    j1939: {
      spn: 110,
      fmi: 0,
      spnDescription: 'Engine Coolant Temperature',
      fmiDescription: 'Data Valid But Above Normal Operational Range - Most Severe Level',
      occurrenceCount: 1,
      sourceAddress: 0,
    },
    metadata: { addedAt: at(t + LAG_MS), modifiedAt: at(t + LAG_MS) },
  });
  const scr: TerminalFaultEvent = {
    id: ulidish('fc_evt_', 3),
    provider: v.provider,
    vehicle: v.id,
    protocol: 'j1939',
    status: 'open',
    code: 'SPN3031-FMI9',
    description: 'Aftertreatment 1 SCR Intake Temperature - Abnormal Update Rate',
    observedAt: at(-5 * 60_000),
    milStatus: 'off',
    j1939: {
      spn: 3031,
      fmi: 9,
      spnDescription: 'Aftertreatment 1 SCR Intake Temperature',
      fmiDescription: 'Abnormal Update Rate',
      occurrenceCount: 2,
      sourceAddress: 61,
    },
    metadata: { addedAt: at(-5 * 60_000 + LAG_MS), modifiedAt: at(-5 * 60_000 + LAG_MS) },
  };
  return fixture(
    'faults',
    `${SPEC} (GET /fault-codes/events?modifiedAfter=&vehicleIds=: FaultCodeEvent, protocol j1939 with spn/fmi/sourceAddress/occurrenceCount, status open/pending/closed, observedAt, milStatus; ${DOCS}/fault-codes/list-fault-code-events)`,
    [
      {
        request: { method: 'GET', path: '/fault-codes/events' },
        response: list([coolant('open', -20 * 60_000, 1), coolant('closed', -15 * 60_000, 2), scr]),
      },
    ],
  );
}

/** Every Terminal doc-derived fixture, by its path under ./doc-derived/, in replay order. */
export function buildTerminalDocDerivedFixtures(): Record<string, ReplayFixture> {
  const v = h3();
  return {
    'connections/01-connections.json': connections(v.provider),
    'providers/01-providers.json': providers(v.provider),
    'vehicles/01-vehicles.json': vehicles(v),
    'positions/01-locations.json': positions(v),
    'stats/01-stats-historical.json': stats(v),
    'faults/01-fault-code-events.json': faults(v),
  };
}
