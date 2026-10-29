/**
 * A tiny deterministic `SimWorld` that satisfies the contract (src/sim/types.ts) without the
 * sim agent's world: the stand-in's own tests use it, and `pnpm vendor-sim --stub-world` serves
 * it until the real `createSimWorld` lands. Ids are `demoId('stub:<key>')`.
 *
 *   S1  semi        ELD 'stub-veh-s1'  drives east-west on a section road at 50 mph (5 mi legs)
 *   S2  semi        ELD 'stub-veh-s2'  queued at the elevator (stopped inside its yard)
 *   C1  combine     Deere 'stub-jd-c1' works passes in the field 40 of every 60 sim minutes,
 *                                       then transports along the road (no breadcrumbs then)
 *   GC1 grain cart  Deere 'stub-jd-gc1' + ELD 'stub-veh-gc1' always transporting (ELD only)
 *
 * Every machine's state is a pure function of sim time.
 */
import type { MultiPolygon, Polygon } from 'geojson';
import { demoId } from '../../domain/ids';
import {
  type CreateSimWorld,
  type LngLat,
  SIM_DEERE_HOME_ORG,
  type SimFarm,
  type SimMachineSample,
  type SimWorld,
} from '../types';

export const STUB_STARTS_AT = new Date('2026-10-15T11:00:00.000Z'); // 7:00 a.m. in Adrian

const id = (key: string) => demoId(`stub:${key}`);

/** Square of ~half a mile with its south-west corner at (lng, lat). */
function square(lng: number, lat: number, dLng: number, dLat: number): MultiPolygon {
  return {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [lng, lat],
          [lng + dLng, lat],
          [lng + dLng, lat + dLat],
          [lng, lat + dLat],
          [lng, lat],
        ],
      ],
    ],
  };
}

const FIELD_SW: LngLat = [-84.06, 41.89];
const FIELD_D: LngLat = [0.00971, 0.00725]; // ~805 m at 41.9° N
const ROAD_LAT = 41.8895; // just south of the field
const ROAD_W = -84.1;
const MI_DEG_LNG = 1 / 51.5; // degrees of longitude per mile at 41.9° N
const ELEVATOR: LngLat = [-84.02, 41.895];

function polygonAround([lng, lat]: LngLat, d = 0.0008): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng - d, lat - d],
        [lng + d, lat - d],
        [lng + d, lat + d],
        [lng - d, lat + d],
        [lng - d, lat - d],
      ],
    ],
  };
}

export function buildStubFarm(): SimFarm {
  const farmId = id('farm:home');
  const fieldId = id('field:north-160');
  return {
    parties: [
      {
        id: id('party:elevator'),
        key: 'stub:elevator',
        kind: 'org',
        displayName: 'Stub Grain Co.',
        roles: ['elevator'],
        orgId: null,
      },
    ],
    farms: [
      {
        id: farmId,
        key: 'stub:home',
        name: 'Home farm (stub)',
        clientPartyId: null,
        deereFarmId: 'stub-df-home',
        deereOrgId: SIM_DEERE_HOME_ORG,
      },
    ],
    fields: [
      {
        id: fieldId,
        key: 'stub:north-160',
        name: 'North 160',
        farmId,
        tenure: 'owned',
        landlordPartyId: null,
        countyFips: '26091',
        boundary: square(FIELD_SW[0], FIELD_SW[1], FIELD_D[0], FIELD_D[1]),
        acres: 160,
        entrance: [FIELD_SW[0] + FIELD_D[0] / 2, FIELD_SW[1]],
        entranceNodeId: 'stub-n-field',
        deereFieldId: 'stub-fld-north',
        deereBoundaryId: 'stub-bnd-north',
        boundaryId: id('boundary:north-160'),
      },
    ],
    machines: [
      {
        id: id('machine:s1'),
        key: 'stub:s1',
        kind: 'semi',
        unitNo: 'S1',
        make: 'Peterbilt',
        model: '579',
        year: 2022,
        vendorIds: { eld: 'stub-veh-s1' },
      },
      {
        id: id('machine:s2'),
        key: 'stub:s2',
        kind: 'semi',
        unitNo: 'S2',
        make: 'Kenworth',
        model: 'T880',
        year: 2021,
        vendorIds: { eld: 'stub-veh-s2' },
      },
      {
        id: id('machine:c1'),
        key: 'stub:c1',
        kind: 'combine',
        unitNo: 'C1',
        make: 'John Deere',
        model: 'X9 1100',
        year: 2024,
        vendorIds: { deere: 'stub-jd-c1' },
        deereOrgId: SIM_DEERE_HOME_ORG,
        implementWidthFt: 45,
      },
      {
        id: id('machine:gc1'),
        key: 'stub:gc1',
        kind: 'grain_cart',
        unitNo: 'GC1',
        make: 'John Deere',
        model: '8R 410',
        year: 2023,
        vendorIds: { deere: 'stub-jd-gc1', eld: 'stub-veh-gc1' },
        deereOrgId: SIM_DEERE_HOME_ORG,
      },
    ],
    elevators: [
      {
        id: id('elevator:stub'),
        key: 'stub:elevator',
        partyId: id('party:elevator'),
        name: 'Stub Grain Co.',
        geofence: polygonAround(ELEVATOR),
        entrance: ELEVATOR,
        entranceNodeId: 'stub-n-elevator',
      },
    ],
    shop: {
      id: id('shop'),
      name: 'Shop (stub)',
      location: [-84.08, 41.8895],
      geofence: polygonAround([-84.08, 41.8895], 0.0004),
      nodeId: 'stub-n-shop',
    },
    roads: {
      nodes: [
        { id: 'stub-n-west', lngLat: [ROAD_W, ROAD_LAT] },
        { id: 'stub-n-east', lngLat: [ROAD_W + 5 * MI_DEG_LNG, ROAD_LAT] },
      ],
      edges: [{ from: 'stub-n-west', to: 'stub-n-east', lengthMi: 5, name: 'Stub Hwy' }],
    },
  };
}

/** Back-and-forth along the road: position after `miles` driven from the west end. */
function onRoad(miles: number, legMi: number): { lng: number; heading: number } {
  const lap = miles % (2 * legMi);
  const east = lap < legMi;
  const along = east ? lap : 2 * legMi - lap;
  return { lng: ROAD_W + along * MI_DEG_LNG, heading: east ? 90 : 270 };
}

export function createStubSimWorld(
  opts: Parameters<CreateSimWorld>[0] = { scenario: 'harvest-day' },
): SimWorld {
  const farm = buildStubFarm();
  const byId = new Map(farm.machines.map((m) => [m.id, m]));
  const field = farm.fields[0] as (typeof farm.fields)[number];
  const t0 = STUB_STARTS_AT.getTime();
  const idle = opts.scenario === 'winter-idle';

  const machineAt = (machineId: string, simTime: Date): SimMachineSample | null => {
    const m = byId.get(machineId);
    if (!m) return null;
    const hours = (simTime.getTime() - t0) / 3_600_000;
    const base = {
      engineHours: 1200 + Math.max(0, hours),
      odometerMi: 0,
      fuelPct: 80,
      fieldId: null,
    };
    if (idle) {
      return {
        ...base,
        lng: farm.shop.location[0],
        lat: farm.shop.location[1],
        heading: 0,
        speedMph: 0,
        activity: 'idle',
        engineOn: false,
        engineHours: 1200,
      };
    }
    const fuel = Math.max(5, 90 - (((hours % 24) + 24) % 24) * 3);
    switch (m.unitNo) {
      case 'S1':
      case 'GC1': {
        const speed = m.unitNo === 'S1' ? 50 : 18;
        const miles = Math.max(0, hours) * speed;
        const r = onRoad(miles, 5);
        return {
          ...base,
          lng: r.lng,
          lat: ROAD_LAT,
          heading: r.heading,
          speedMph: speed,
          activity: 'transport',
          engineOn: true,
          odometerMi: 50_000 + miles,
          fuelPct: fuel,
        };
      }
      case 'S2':
        return {
          ...base,
          lng: ELEVATOR[0],
          lat: ELEVATOR[1],
          heading: 180,
          speedMph: 0,
          activity: 'queued',
          engineOn: true,
          odometerMi: 61_000,
          fuelPct: fuel,
        };
      case 'C1': {
        const minuteOfHour = (((hours * 60) % 60) + 60) % 60;
        if (minuteOfHour < 40) {
          // Passes north-south, ~5 mph, stepping east one header width per pass.
          const passMin = 1.2; // ~0.1 mi per pass at 5 mph
          const pass = Math.floor(minuteOfHour / passMin);
          const f = (minuteOfHour % passMin) / passMin;
          const north = pass % 2 === 0;
          const x = FIELD_SW[0] + ((pass % 40) + 0.5) * (FIELD_D[0] / 40);
          const y = FIELD_SW[1] + FIELD_D[1] * (0.05 + 0.9 * (north ? f : 1 - f));
          return {
            ...base,
            lng: x,
            lat: y,
            heading: north ? 0 : 180,
            speedMph: 5,
            activity: 'working',
            engineOn: true,
            fuelPct: fuel,
            fieldId: field.id,
          };
        }
        return {
          ...base,
          lng: field.entrance[0] + (minuteOfHour - 40) * 0.0002,
          lat: ROAD_LAT,
          heading: 90,
          speedMph: 15,
          activity: 'transport',
          engineOn: true,
          fuelPct: fuel,
        };
      }
      default:
        return null;
    }
  };

  return {
    scenario: opts.scenario,
    seed: opts.seed ?? 1,
    farm,
    startsAt: STUB_STARTS_AT,
    machineAt,
  };
}
