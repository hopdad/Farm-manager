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
 */
import { simTelematicsMachines } from '../../../sim/types';
import { createDemoWorld, type DemoWorld } from '../../../sim/world';
import type { ReplayExchange, ReplayFixture } from '../../replay';

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
const SIMULATED =
  'Values: the simulated demo farm (src/sim, seed 1, harvest-day), no real farm data.';

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Cursor that leads to loop page `k` (opaque to the client, like Samsara's own). */
export const loopCursor = (k: number) => `replay-loop-${String(k % LOOP_PAGES).padStart(4, '0')}`;
export const STATS_CURSOR = 'replay-stats-0001';

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
            isEcuSpeed: false,
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
        request: { method: 'GET', path, query: { after: STATS_CURSOR } },
        response: {
          status: 200,
          body: { data: [], pagination: { endCursor: STATS_CURSOR, hasNextPage: false } },
        },
      },
      {
        request: { method: 'GET', path },
        response: {
          status: 200,
          body: { data, pagination: { endCursor: STATS_CURSOR, hasNextPage: false } },
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
  };
}
