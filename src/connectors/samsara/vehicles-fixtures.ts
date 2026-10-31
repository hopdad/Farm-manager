/**
 * Builds the DOC-DERIVED Samsara vehicle-list replay fixture (slice 1f.2, terminal-pickups;
 * docs/contracts-1f.md §B.6): `GET /fleet/vehicles` for `fleet.vehicles` with
 * `CONNECTOR_SAMSARA=replay` (CI's replay step runs it).
 *
 * SHAPES: Samsara's OpenAPI (developers.samsara.com/openapi/samsara-api.json, listVehicles:
 * VehiclesListVehiclesResponseBody, GoaTagTinyResponseResponseBody, the minified gateway
 * object; checked Oct 30, 2026), through the stand-in's own record builder
 * (src/sim/vendors/samsara/vehicles-routes.ts `samsaraVehicleRecord`), so the fixture and the
 * stand-in never disagree. VALUES: the simulated demo farm (src/sim, seed 1): no real farm data;
 * the four semis (tag Semi, a VG54NA gateway) and the two pickups (tag Pickup, no gateway: Ford
 * Pro and Stellantis), under the vehicle ids the demo seed maps.
 *
 * The committed JSON (./fixtures/doc-derived/vehicles/01-vehicles.json) is this module's output;
 * ./vehicles-fixtures.test.ts fails when it drifts. Regenerate with
 *   pnpm exec tsx src/connectors/samsara/vehicles-fixtures-write.ts   then   pnpm lint:fix
 */
import { buildDemoFarm } from '../../sim/farm/build';
import { simTelematicsMachines } from '../../sim/types';
import { samsaraVehicleRecord } from '../../sim/vendors/samsara/vehicles-routes-record';
import type { ReplayFixture } from '../replay';

export const VEHICLES_ANCHOR = '2026-10-15T13:00:00.000Z';
export const VEHICLES_FIXTURE_PATH = 'vehicles/01-vehicles.json';

const REF =
  'https://developers.samsara.com/reference/listvehicles (GET /fleet/vehicles?limit=&after=: data[] with id, name, make, model, year as a string, tags[{id,name}], gateway{model,serial} (absent for a carmaker-cloud vehicle), pagination.endCursor/hasNextPage); shapes as in developers.samsara.com/openapi/samsara-api.json (VehiclesListVehiclesResponseBody)';
const SIMULATED = 'Values: the simulated demo farm (src/sim, seed 1), no real farm data.';

export function buildSamsaraVehiclesFixture(): ReplayFixture {
  const farm = buildDemoFarm();
  const data = simTelematicsMachines(farm, 'samsara', { feed: 'vehicle' }).map((m) =>
    samsaraVehicleRecord(m),
  );
  return {
    format: 1,
    source: 'samsara',
    stream: 'vehicles',
    kind: 'doc-derived',
    reference: `${REF}. ${SIMULATED}`,
    anchor: VEHICLES_ANCHOR,
    exchanges: [
      {
        request: { method: 'GET', path: '/fleet/vehicles' },
        response: {
          status: 200,
          body: { data, pagination: { endCursor: '', hasNextPage: false } },
        },
      },
    ],
  };
}
