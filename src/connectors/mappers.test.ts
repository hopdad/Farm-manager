/**
 * Golden mapping tests on doc-shaped payloads (Samsara SDK reference examples; Deere and Motive
 * doc-derived), plus the small pure helpers around them.
 */
import { describe, expect, test } from 'vitest';
import { mapDeereBreadcrumb, speedToMph } from './deere/mapper';
import { mapMotivePosition } from './motive/client';
import {
  mapSamsaraPosition,
  mapSamsaraStat,
  samsaraPositionItems,
  samsaraStatItems,
} from './samsara/mapper';
import { samsaraLocationsFeedSchema, samsaraStatsFeedSchema } from './samsara/schemas';

/** Shape from Samsara's reference (VehicleLocationsListResponse), extra fields included. */
const SAMSARA_FEED = {
  data: [
    {
      id: '112',
      name: 'Truck A7',
      locations: [
        {
          time: '2020-01-27T07:06:25Z',
          latitude: 41.8895,
          longitude: -84.0412,
          heading: -90,
          speed: 48.3,
          isEcuSpeed: true,
          reverseGeo: { formattedLocation: 'Adrian, MI' },
        },
      ],
      externalIds: { maintenanceId: '250020' },
    },
  ],
  pagination: { endCursor: 'MjkY', hasNextPage: true },
};

describe('Samsara mapping', () => {
  test('locations feed → one raw item per event → NormalizedPosition', () => {
    const feed = samsaraLocationsFeedSchema.parse(SAMSARA_FEED);
    const items = samsaraPositionItems(feed);
    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe('112:2020-01-27T07:06:25.000Z');
    expect(mapSamsaraPosition(items[0]?.payload)).toEqual([
      {
        source: 'samsara',
        externalMachineId: '112',
        sourceOrg: '',
        ts: '2020-01-27T07:06:25.000Z',
        lng: -84.0412,
        lat: 41.8895,
        heading: 270,
        speedMph: 48.3,
        engineOn: null,
        positionSource: 'eld',
      },
    ]);
  });

  test('a corrupt landed payload throws (counts an attempt)', () => {
    expect(() => mapSamsaraPosition({ id: '112', location: { time: 'x' } })).toThrow();
  });

  test('stats feed → engine hours, odometer miles, fuel percent', () => {
    const feed = samsaraStatsFeedSchema.parse({
      data: [
        {
          id: '112',
          name: 'Truck A7',
          obdEngineSeconds: [{ time: '2020-01-27T07:06:25Z', value: 4_320_000 }],
          obdOdometerMeters: [{ time: '2020-01-27T07:06:25Z', value: 160_934_400 }],
          fuelPercents: [{ time: '2020-01-27T07:06:25Z', value: 54 }],
          engineStates: [{ time: '2020-01-27T07:06:25Z', value: 'On' }],
        },
      ],
      pagination: { endCursor: 'x', hasNextPage: false },
    });
    const stats = samsaraStatItems(feed).flatMap((i) => mapSamsaraStat(i.payload));
    expect(stats).toEqual([
      expect.objectContaining({ externalMachineId: '112', engineHours: 1200 }),
      expect.objectContaining({ fuelPct: 54 }),
      expect.objectContaining({ odometerMi: 100_000 }),
    ]);
  });
});

describe('Deere mapping', () => {
  test('breadcrumb → working position in the org it was read from', () => {
    expect(
      mapDeereBreadcrumb({
        orgId: 'org-home',
        machineId: 'jd-c1',
        breadcrumb: {
          point: { lat: 41.9, lon: -84.05 },
          eventTimestamp: '2026-10-15T14:00:10Z',
          speed: { value: 8.0, unit: 'km/hr' },
          heading: { value: 360, unit: 'deg' },
          machineState: 'Working',
        },
      }),
    ).toEqual([
      {
        source: 'deere',
        externalMachineId: 'jd-c1',
        sourceOrg: 'org-home',
        ts: '2026-10-15T14:00:10.000Z',
        lng: -84.05,
        lat: 41.9,
        heading: 0,
        speedMph: 5,
        engineOn: true,
        positionSource: 'deere_working',
      },
    ]);
    expect(speedToMph({ value: 10, unit: 'mph' })).toBe(10);
    expect(speedToMph({ value: 10, unit: 'furlongs/fortnight' })).toBeNull();
    expect(speedToMph(undefined)).toBeNull();
  });
});

describe('Motive mapping (placeholder)', () => {
  test('current location → ELD position', () => {
    expect(
      mapMotivePosition({
        id: '42',
        number: 'S1',
        location: {
          lat: 41.9,
          lon: -84,
          bearing: 180,
          kph: 80.5,
          located_at: '2026-10-15T14:00:00Z',
        },
      })[0],
    ).toMatchObject({ source: 'motive', externalMachineId: '42', heading: 180, speedMph: 50 });
  });
});
