/**
 * Builds the DOC-DERIVED AEMP replay fixtures (docs/contracts-1f.md §B.6): one Fleet page per
 * replayed provider (`aempEndpoints('replay')`: the stand-in's `kubota` and `samsara`), so
 * `CONNECTOR_AEMP=replay` puts L1 and SP2 on the board as last-known machines.
 *
 * SHAPES: replay bodies are JSON only (src/connectors/replay.ts), so both are the standard's JSON
 * forms: `kubota` a BARE Fleet object (the shape of Trackunit's aemp-iso-api.json schema, PascalCase
 * as in ISO's edition-1 common.xsd), `samsara` Samsara's own `{"Fleet": …}` wrapper
 * (getAempEquipmentList in developers.samsara.com/openapi/samsara-api.json: version "1",
 * EquipmentID, EngineStatus without EngineNumber). The XML forms are exercised through the
 * stand-in and the parser's tests. VALUES: the simulated demo farm (src/sim, seed 1): no real
 * farm data; every machine id is one the demo seed maps (`simExternalRefs`).
 *
 * The committed JSON under ./doc-derived/ is this module's output (./fixtures.test.ts fails when
 * they drift). Regenerate with
 *   pnpm exec tsx src/connectors/aemp/fixtures/write.ts   then   pnpm lint:fix
 * Every section is dated at the fixture's anchor; replay shifts it to the moment of the call.
 */

import { simTelematicsMachines } from '../../../sim/types';
import { simDefPct } from '../../../sim/vendors/aemp/routes';
import { createDemoWorld, type DemoWorld } from '../../../sim/world';
import type { ReplayFixture } from '../../replay';

const SEED = 1;
export const AEMP_ANCHOR = '2026-10-15T13:00:00.000Z';

const REF_KUBOTA =
  "ISO/TS 15143-3 ed. 1 common.xsd (https://standards.iso.org/iso/15143/-3/ed-1/en/common.xsd): Fleet { version, snapshotTime, Links[], Equipment[] { EquipmentHeader, Location, CumulativeOperatingHours, FuelRemaining, DEFRemaining } } as a bare JSON object, the shape of Trackunit's aemp-iso-api.json (https://developers.trackunit.com/openapi/aemp-iso-api.json); the sections of Geotab's Kubota data set (https://support.geotab.com/oem-integration/doc/kubota-data-set)";
const REF_SAMSARA =
  'Samsara getAempEquipmentList (https://developers.samsara.com/openapi/samsara-api.json, GET /beta/aemp/Fleet/{pageNumber}): {"Fleet": { version "1", snapshotTime, Links, Equipment[] { EquipmentHeader.EquipmentID, Location, CumulativeOperatingHours, Distance, FuelRemaining, DEFRemaining, EngineStatus } }}';
const SIMULATED =
  'Values: the simulated demo farm (src/sim, seed 1, harvest-day), no real farm data.';

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r1 = (v: number) => Math.round(v * 10) / 10;

function machines(world: DemoWorld, provider: string) {
  const at = new Date(AEMP_ANCHOR);
  return simTelematicsMachines(world.farm, 'aemp', { provider }).flatMap((m) => {
    const s = world.machineAt(m.id, at);
    return s && m.telematics ? [{ m, s, id: m.telematics.id }] : [];
  });
}

function kubotaFixture(world: DemoWorld): ReplayFixture {
  const datetime = AEMP_ANCHOR;
  const body = {
    version: 1,
    snapshotTime: AEMP_ANCHOR,
    Links: [{ rel: 'self', href: 'https://kubota-aemp.example.invalid/Fleet/1' }],
    Equipment: machines(world, 'kubota').map(({ m, s, id }) => ({
      EquipmentHeader: {
        OEMName: 'Kubota',
        Model: m.model,
        EquipmentID: m.unitNo,
        SerialNumber: id,
        PIN: id,
      },
      Location: { datetime, Latitude: r6(s.lat), Longitude: r6(s.lng) },
      CumulativeOperatingHours: { datetime, Hour: r1(s.engineHours) },
      FuelRemaining: { datetime, Percent: Math.round(s.fuelPct) },
      DEFRemaining: { datetime, Percent: simDefPct(m.id) },
    })),
  };
  return {
    format: 1,
    source: 'aemp',
    stream: 'fleet',
    kind: 'doc-derived',
    reference: `${REF_KUBOTA}. ${SIMULATED}`,
    anchor: AEMP_ANCHOR,
    exchanges: [
      { request: { method: 'GET', path: '/kubota/Fleet/1' }, response: { status: 200, body } },
    ],
  };
}

function samsaraFixture(world: DemoWorld): ReplayFixture {
  const datetime = AEMP_ANCHOR;
  const body = {
    Fleet: {
      version: '1',
      snapshotTime: AEMP_ANCHOR,
      Links: [{ rel: 'self', href: 'https://api.samsara.com/aemp/Fleet/1' }],
      Equipment: machines(world, 'samsara').map(({ m, s, id }) => ({
        EquipmentHeader: {
          EquipmentID: id,
          OEMName: m.make,
          Model: m.model,
          SerialNumber: `SN-${m.unitNo}`,
        },
        Location: { Latitude: r6(s.lat), Longitude: r6(s.lng), datetime },
        CumulativeOperatingHours: { Hour: r1(s.engineHours), datetime },
        Distance: { Odometer: r1(s.odometerMi * 1.609344), OdometerUnits: 'kilometre', datetime },
        FuelRemaining: { Percent: Math.round(s.fuelPct), datetime },
        DEFRemaining: { Percent: simDefPct(m.id), datetime },
        EngineStatus: { Running: s.engineOn, datetime },
      })),
    },
  };
  return {
    format: 1,
    source: 'aemp',
    stream: 'fleet',
    kind: 'doc-derived',
    reference: `${REF_SAMSARA}. ${SIMULATED}`,
    anchor: AEMP_ANCHOR,
    exchanges: [
      { request: { method: 'GET', path: '/samsara/Fleet/1' }, response: { status: 200, body } },
    ],
  };
}

/** Every AEMP doc-derived fixture, by its path under ./doc-derived/. */
export function buildAempDocDerivedFixtures(): Record<string, ReplayFixture> {
  const world = createDemoWorld({ scenario: 'harvest-day', seed: SEED });
  return {
    'fleet/01-kubota-fleet.json': kubotaFixture(world),
    'fleet/02-samsara-fleet.json': samsaraFixture(world),
  };
}
