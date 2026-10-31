/**
 * Builds the DOC-DERIVED Samsara (ELD) replay fixtures (contracts-m1 §10; plan 1a: "Doc-derived
 * replay fixtures for … the ELD from the public API references").
 *
 * SHAPES: Samsara's API reference for the vehicle feeds,
 *   https://developers.samsara.com/reference/getvehiclelocationsfeed
 *   https://developers.samsara.com/reference/getvehiclestatsfeed
 * as published in Samsara's official SDK (@samsarahq/samsara 14.11: VehicleLocationsListResponse,
 * VehicleLocation, VehicleStatsListResponse, PaginationResponse; ../schemas.ts). VALUES: the
 * simulated demo farm (src/sim, seed 1, harvest-day): no real farm data, and every vehicle id is
 * one the demo seed maps through ingest.external_refs, so `CONNECTOR_SAMSARA=replay` drives the board.
 *
 * The committed JSON under ./doc-derived/ is this module's output; ./fixtures.test.ts fails when
 * they drift. Regenerate with
 *   pnpm exec tsx src/connectors/samsara/fixtures/write.ts   then   pnpm lint:fix
 *
 * MOVING TRUCKS. Samsara's feed is cursor-paged: the first call (no `after`) answers each
 * vehicle's latest location and an `endCursor`; each later call passes it back as `after` and
 * gets what happened since. The positions fixture is a LOOP of such pages: one page per 30 s of
 * the simulated morning (an hour, 120 pages), each keyed on the `after` cursor that leads to it,
 * the last cursor leading back to the first page. Every page reports its locations at the
 * fixture's `anchor`, and the 1 s time-shift step moves that to the moment of the call, so each
 * poll (every 5 s in the demo cadence, 30 s live) shows the trucks one step further along their
 * hauls (into the elevator yards and back out: geofence visits included). A cursor the fixture
 * doesn't know (one saved in sim mode) falls through to the first page.
 *
 * FAULT CODES (slice 1f, fleet-faults): `types=faultCodes` is its own call (its own cursor), so
 * its exchanges name `types` in their query, and so do the stats exchanges (a replay request
 * matches on the query keys an exchange names: neither may answer the other's call). The first
 * call answers one faultCodes reading per truck in Samsara's shape (built with the stand-in's own
 * reading builder, src/sim/vendors/samsara/fault-codes.ts): S3 with a red-stop-lamp engine code
 * (critical: the fleet panel's badge and "Critical fault: mark down?"), S2 with an amber
 * aftertreatment code (warning), S1 and S4 with none; then nothing new.
 */

import { simTelematicsMachines } from '../../../sim/types';
import {
  type SamsaraSimFault,
  SIM_RED_STOP_FAULT,
} from '../../../sim/vendors/samsara/control-types';
import { faultReading, faultVehicles } from '../../../sim/vendors/samsara/fault-codes';
import { createDemoWorld, type DemoWorld } from '../../../sim/world';
import type { ReplayExchange, ReplayFixture } from '../../replay';
import { SAMSARA_FAULT_TYPE, SAMSARA_STAT_TYPES } from '../schemas';

const SEED = 1;
export const POSITIONS_ANCHOR = '2026-10-15T13:00:00.000Z';
/** The simulated hour the loop replays (08:00-09:00 EDT: hauls to Kestrel and Tamarack). */
export const LOOP_START = '2026-10-15T12:00:00.000Z';
export const LOOP_PAGES = 120;
export const LOOP_STEP_SECONDS = 30;

const REF_POSITIONS =
  'https://developers.samsara.com/reference/getvehiclelocationsfeed (GET /fleet/vehicles/locations/feed?after=, data[].locations[], pagination.endCursor/hasNextPage); shapes as in @samsarahq/samsara 14.11 (VehicleLocationsListResponse)';
const REF_STATS =
  'https://developers.samsara.com/reference/getvehiclestatsfeed (GET /fleet/vehicles/stats/feed?types=obdEngineSeconds,fuelPercents,obdOdometerMeters&after=); shapes as in @samsarahq/samsara 14.11 (VehicleStatsListResponse)';
const REF_FAULTS =
  "https://developers.samsara.com/reference/getvehiclestatsfeed (GET /fleet/vehicles/stats/feed?types=faultCodes&after=; data[].faultCodes[] = VehicleStatsFaultCodesWithDecoration: time, canBusType, j1939.checkEngineLights + diagnosticTroubleCodes[spnId, fmiId, txId, milStatus, occurrenceCount, spnDescription, fmiDescription, sourceAddressName]) and https://developers.samsara.com/docs/fault-monitoring; Samsara's OpenAPI 3.0.1 (developers.samsara.com/openapi/samsara-api.json)";
const SIMULATED =
  'Values: the simulated demo farm (src/sim, seed 1, harvest-day), no real farm data.';

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Cursor that leads to loop page `k` (opaque to the client, like Samsara's own). */
export const loopCursor = (k: number) => `replay-loop-${String(k % LOOP_PAGES).padStart(4, '0')}`;
export const STATS_CURSOR = 'replay-stats-0001';
export const FAULTS_CURSOR = 'replay-faults-0001';
/** The stats call's `types` (the replay match names it, so faultCodes calls never match it). */
export const STATS_TYPES_QUERY = SAMSARA_STAT_TYPES.join(',');

/** The trucks' codes in the faults fixture, by unit number (others: none). */
export const REPLAY_FAULTS: Readonly<Record<string, readonly SamsaraSimFault[]>> = {
  S2: [
    { system: 'j1939', spn: 3216, fmi: 2, txId: 61, occurrenceCount: 3, lamps: { warning: true } },
  ],
  S3: [SIM_RED_STOP_FAULT],
};

/**
 * The trucks on Samsara's vehicle feeds (the four M0 semis). 1f.2's pickups are on the same feeds
 * in sim; terminal-pickups adds them here (docs/contracts-1f.md part B).
 */
function eldVehicles(world: DemoWorld) {
  return simTelematicsMachines(world.farm, 'samsara', { feed: 'vehicle' }).filter(
    (m) => m.kind === 'semi',
  );
}

function page(world: DemoWorld, k: number) {
  const at = new Date(Date.parse(LOOP_START) + k * LOOP_STEP_SECONDS * 1000);
  const data = eldVehicles(world).flatMap((m) => {
    const s = world.machineAt(m.id, at);
    if (!s) return [];
    return [
      {
        id: m.telematics?.id as string,
        name: m.unitNo,
        locations: [
          {
            time: POSITIONS_ANCHOR,
            latitude: r6(s.lat),
            longitude: r6(s.lng),
            heading: r1(s.heading),
            speed: r1(Math.max(0, s.speedMph)),
          },
        ],
      },
    ];
  });
  return { data, pagination: { endCursor: loopCursor(k), hasNextPage: false } };
}

function positionsFixture(world: DemoWorld): ReplayFixture {
  const path = '/fleet/vehicles/locations/feed';
  const exchanges: ReplayExchange[] = [];
  // `after` = the cursor of page k-1 leads to page k (the last one back to page 0) ...
  for (let k = 1; k <= LOOP_PAGES; k++) {
    exchanges.push({
      request: { method: 'GET', path, query: { after: loopCursor(k - 1) } },
      response: { status: 200, body: page(world, k % LOOP_PAGES) },
    });
  }
  // ... and the first call (no cursor, or one this fixture doesn't know) gets page 0.
  exchanges.push({
    request: { method: 'GET', path },
    response: { status: 200, body: page(world, 0) },
  });
  return {
    format: 1,
    source: 'samsara',
    stream: 'positions',
    kind: 'doc-derived',
    reference: `${REF_POSITIONS}. ${SIMULATED}`,
    anchor: POSITIONS_ANCHOR,
    shiftStepSeconds: 1,
    exchanges,
  };
}

function statsFixture(world: DemoWorld): ReplayFixture {
  const path = '/fleet/vehicles/stats/feed';
  const at = new Date(LOOP_START);
  const data = eldVehicles(world).flatMap((m) => {
    const s = world.machineAt(m.id, at);
    if (!s) return [];
    return [
      {
        id: m.telematics?.id as string,
        name: m.unitNo,
        obdEngineSeconds: [{ time: POSITIONS_ANCHOR, value: Math.round(s.engineHours * 3600) }],
        fuelPercents: [{ time: POSITIONS_ANCHOR, value: Math.round(s.fuelPct) }],
        obdOdometerMeters: [{ time: POSITIONS_ANCHOR, value: Math.round(s.odometerMi * 1609.344) }],
      },
    ];
  });
  return {
    format: 1,
    source: 'samsara',
    stream: 'stats',
    kind: 'doc-derived',
    reference: `${REF_STATS}. ${SIMULATED}`,
    anchor: POSITIONS_ANCHOR,
    exchanges: [
      {
        // Caught up: nothing new since the first page.
        request: { method: 'GET', path, query: { types: STATS_TYPES_QUERY, after: STATS_CURSOR } },
        response: {
          status: 200,
          body: { data: [], pagination: { endCursor: STATS_CURSOR, hasNextPage: false } },
        },
      },
      {
        request: { method: 'GET', path, query: { types: STATS_TYPES_QUERY } },
        response: {
          status: 200,
          body: { data, pagination: { endCursor: STATS_CURSOR, hasNextPage: false } },
        },
      },
    ],
  };
}

function faultsFixture(world: DemoWorld): ReplayFixture {
  const path = '/fleet/vehicles/stats/feed';
  const anchorMs = Date.parse(POSITIONS_ANCHOR);
  const semis = new Set(eldVehicles(world).map((m) => m.telematics?.id as string));
  const data = faultVehicles(world)
    .filter((v) => semis.has(v.id))
    .map((v) => ({
      id: v.id,
      name: v.name,
      faultCodes: [faultReading(v, REPLAY_FAULTS[v.name] ?? [], anchorMs)],
    }));
  return {
    format: 1,
    source: 'samsara',
    stream: 'faults',
    kind: 'doc-derived',
    reference: `${REF_FAULTS}. ${SIMULATED}`,
    anchor: POSITIONS_ANCHOR,
    exchanges: [
      {
        // Caught up: no fault reading since the first page.
        request: {
          method: 'GET',
          path,
          query: { types: SAMSARA_FAULT_TYPE, after: FAULTS_CURSOR },
        },
        response: {
          status: 200,
          body: { data: [], pagination: { endCursor: FAULTS_CURSOR, hasNextPage: false } },
        },
      },
      {
        request: { method: 'GET', path, query: { types: SAMSARA_FAULT_TYPE } },
        response: {
          status: 200,
          body: { data, pagination: { endCursor: FAULTS_CURSOR, hasNextPage: false } },
        },
      },
    ],
  };
}

/** Every Samsara doc-derived fixture, by its path under ./doc-derived/. */
export function buildSamsaraDocDerivedFixtures(): Record<string, ReplayFixture> {
  const world = createDemoWorld({ scenario: 'harvest-day', seed: SEED });
  return {
    'positions/01-locations-feed.json': positionsFixture(world),
    'stats/01-stats-feed.json': statsFixture(world),
    'faults/01-fault-codes-feed.json': faultsFixture(world),
  };
}
