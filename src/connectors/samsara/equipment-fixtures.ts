/**
 * Builds the DOC-DERIVED Samsara equipment-feed replay fixtures (docs/contracts-1f.md §B.6; CI's
 * replay step runs fleet.equipment with CONNECTOR_SAMSARA=replay), under
 * ./fixtures/doc-derived/equipment_positions/ and ./fixtures/doc-derived/equipment_stats/.
 *
 * SHAPES: Samsara's OpenAPI (https://developers.samsara.com/openapi/samsara-api.json),
 * getEquipmentLocationsFeed and getEquipmentStatsFeed (./equipment-schemas.ts). VALUES: the
 * simulated demo farm (src/sim, seed 1): the RoGator SP2, by the Samsara equipment id the demo
 * seed maps. No real farm data.
 *
 * The locations fixture answers every call with SP2's fix dated at the anchor; the 1 s
 * time-shift step dates it at the moment of the call, so each poll lands a fresh live fix (the
 * machine is parked). The stats fixture answers each of the two calls (by `types`) once, then
 * "caught up" for its cursor.
 *
 * The committed JSON is this module's output (./equipment-fixtures.test.ts fails when it drifts):
 *   pnpm exec tsx src/connectors/samsara/equipment-fixtures-write.ts   then   pnpm lint:fix
 */
import { simTelematicsMachines } from '../../sim/types';
import { createDemoWorld, type DemoWorld } from '../../sim/world';
import type { ReplayExchange, ReplayFixture } from '../replay';
import { EQUIPMENT_STAT_GROUP_NAMES, EQUIPMENT_STAT_GROUPS } from './equipment-schemas';

const SEED = 1;
export const EQUIPMENT_ANCHOR = '2026-10-15T13:00:00.000Z';
export const EQUIPMENT_POSITIONS_CURSOR = 'replay-equipment-locations-0001';
export const equipmentStatsCursor = (group: string) => `replay-equipment-stats-${group}-0001`;

const REF_LOCATIONS =
  'https://developers.samsara.com/openapi/samsara-api.json getEquipmentLocationsFeed (GET /fleet/equipment/locations/feed?after=; data[].locations[] { time, latitude, longitude, heading, speed }, pagination.endCursor/hasNextPage)';
const REF_STATS =
  'https://developers.samsara.com/openapi/samsara-api.json getEquipmentStatsFeed (GET /fleet/equipment/stats/feed?types=<at most 4>&after=; data[] { id, name, <type>: [{ time, value }] })';
const SIMULATED =
  'Values: the simulated demo farm (src/sim, seed 1, harvest-day), no real farm data.';

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r1 = (v: number) => Math.round(v * 10) / 10;

function gateways(world: DemoWorld) {
  const at = new Date(EQUIPMENT_ANCHOR);
  return simTelematicsMachines(world.farm, 'samsara', { feed: 'equipment' }).flatMap((m) => {
    const s = world.machineAt(m.id, at);
    return s && m.telematics ? [{ m, s, id: m.telematics.id }] : [];
  });
}

function positionsFixture(world: DemoWorld): ReplayFixture {
  const path = '/fleet/equipment/locations/feed';
  const body = {
    data: gateways(world).map(({ m, s, id }) => ({
      id,
      name: m.unitNo,
      locations: [
        {
          time: EQUIPMENT_ANCHOR,
          latitude: r6(s.lat),
          longitude: r6(s.lng),
          heading: r1(s.heading),
          speed: r1(Math.max(0, s.speedMph)),
        },
      ],
    })),
    pagination: { endCursor: EQUIPMENT_POSITIONS_CURSOR, hasNextPage: false },
  };
  return {
    format: 1,
    source: 'samsara',
    stream: 'equipment_positions',
    kind: 'doc-derived',
    reference: `${REF_LOCATIONS}. ${SIMULATED}`,
    anchor: EQUIPMENT_ANCHOR,
    shiftStepSeconds: 1,
    exchanges: [
      {
        request: { method: 'GET', path, query: { after: EQUIPMENT_POSITIONS_CURSOR } },
        response: { status: 200, body },
      },
      { request: { method: 'GET', path }, response: { status: 200, body } },
    ],
  };
}

function statsFixture(world: DemoWorld): ReplayFixture {
  const path = '/fleet/equipment/stats/feed';
  const time = EQUIPMENT_ANCHOR;
  const exchanges: ReplayExchange[] = [];
  for (const group of EQUIPMENT_STAT_GROUP_NAMES) {
    const types = EQUIPMENT_STAT_GROUPS[group].join(',');
    const cursor = equipmentStatsCursor(group);
    const data = gateways(world).map(({ m, s, id }) =>
      group === 'hours'
        ? {
            id,
            name: m.unitNo,
            obdEngineSeconds: [{ time, value: Math.round(s.engineHours * 3600) }],
            gatewayEngineSeconds: [{ time, value: Math.round((s.engineHours + 2.5) * 3600) }],
            fuelPercents: [{ time, value: Math.round(s.fuelPct) }],
          }
        : {
            id,
            name: m.unitNo,
            obdEngineStates: [{ time, value: s.engineOn ? 'On' : 'Off' }],
            gatewayEngineStates: [{ time, value: s.engineOn ? 'On' : 'Off' }],
            gpsOdometerMeters: [{ time, value: Math.round(s.odometerMi * 1609.344) }],
          },
    );
    exchanges.push(
      {
        // Caught up: nothing new since the first page of this call.
        request: { method: 'GET', path, query: { types, after: cursor } },
        response: {
          status: 200,
          body: { data: [], pagination: { endCursor: cursor, hasNextPage: false } },
        },
      },
      {
        request: { method: 'GET', path, query: { types } },
        response: {
          status: 200,
          body: { data, pagination: { endCursor: cursor, hasNextPage: false } },
        },
      },
    );
  }
  return {
    format: 1,
    source: 'samsara',
    stream: 'equipment_stats',
    kind: 'doc-derived',
    reference: `${REF_STATS}. ${SIMULATED}`,
    anchor: EQUIPMENT_ANCHOR,
    exchanges,
  };
}

/** Every equipment-feed fixture, by its path under ./fixtures/doc-derived/. */
export function buildSamsaraEquipmentFixtures(): Record<string, ReplayFixture> {
  const world = createDemoWorld({ scenario: 'harvest-day', seed: SEED });
  return {
    'equipment_positions/01-equipment-locations-feed.json': positionsFixture(world),
    'equipment_stats/01-equipment-stats-feed.json': statsFixture(world),
  };
}
