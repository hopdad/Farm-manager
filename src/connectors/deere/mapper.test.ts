/**
 * Deere mappers against the documented shapes (developer.deere.com dev-docs examples, see
 * ./schemas.ts) and the M0 stand-in's shapes, which both must keep mapping.
 */
import { describe, expect, test } from 'vitest';
import {
  ACRES_PER_HECTARE,
  areaAcres,
  breadcrumbHeading,
  breadcrumbMachineState,
  breadcrumbSpeedMph,
  deereBoundaryToMultiPolygon,
  deereFlagGeometry,
  deereLinkId,
  mapDeereBreadcrumb,
  speedToMph,
} from './mapper';
import {
  deereBoundarySchema,
  deereBreadcrumbSchema,
  deereFieldOperationsSchema,
  deereFlagsSchema,
} from './schemas';

/** The Machine Locations doc's own example breadcrumb (heading as a string, rawState). */
const DOC_BREADCRUMB = {
  '@type': 'Breadcrumb',
  createTimestamp: '2018-12-18T08:30:03.789Z',
  speed: { '@type': 'measurementAsDouble', valueAsDouble: 35, unit: 'km1hr-1' },
  heading: { '@type': 'measurementAsInteger', valueAsInteger: '33' },
  machineState: { '@type': 'Breadcrumb$MachineState', rawState: 1 },
  fuelLevel: { '@type': 'measurementAsDouble', valueAsDouble: 19, unit: 'prcnt' },
  origin: 'BREADCRUMB',
  correlationId: '1162b8ad-bbca-4c91-8c0e-2f2794b250a1',
  point: {
    '@type': 'Point',
    lat: 18.513935,
    lon: 73.927629,
    altitude: { '@type': 'measurementAsDouble', valueAsDouble: 0, unit: 'm' },
  },
  eventTimestamp: '2018-11-18T08:40:51.000Z',
  links: [
    { '@type': 'Link', rel: 'machine', uri: 'https://sandboxapi.deere.com/platform/machines/7099' },
  ],
};

describe('breadcrumbs: documented and stand-in shapes', () => {
  test('the documented example parses and maps (km1hr-1, string heading)', () => {
    const b = deereBreadcrumbSchema.parse(DOC_BREADCRUMB);
    expect(breadcrumbSpeedMph(b)).toBe(21.7);
    expect(breadcrumbHeading(b)).toBe(33);
    expect(breadcrumbMachineState(b)).toBeNull();
    const [p] = mapDeereBreadcrumb({ orgId: 'o1', machineId: '7099', breadcrumb: b });
    expect(p).toMatchObject({
      source: 'deere',
      externalMachineId: '7099',
      sourceOrg: 'o1',
      ts: '2018-11-18T08:40:51.000Z',
      lng: 73.927629,
      lat: 18.513935,
      heading: 33,
      speedMph: 21.7,
      positionSource: 'deere_working',
    });
  });

  test('machine state as the schema documents it, and as the stand-in sends it', () => {
    const doc = deereBreadcrumbSchema.parse({
      ...DOC_BREADCRUMB,
      machineState: { '@type': 'Breadcrumb$MachineState', value: 'Working' },
    });
    expect(breadcrumbMachineState(doc)).toBe('Working');
    const sim = deereBreadcrumbSchema.parse({
      point: { lat: 41.9, lon: -83.9 },
      eventTimestamp: '2026-10-29T12:00:00Z',
      speed: { value: 7.4, unit: 'km/hr' },
      heading: { value: 271.5, unit: 'deg' },
      machineState: 'Working',
    });
    expect(breadcrumbMachineState(sim)).toBe('Working');
    expect(breadcrumbSpeedMph(sim)).toBe(4.6);
    expect(breadcrumbHeading(sim)).toBe(271.5);
  });

  test('a speed without a unit, or with an unknown one, is unknown', () => {
    const b = deereBreadcrumbSchema.parse({
      ...DOC_BREADCRUMB,
      speed: { '@type': 'measurementAsDouble', valueAsDouble: 35 },
    });
    expect(breadcrumbSpeedMph(b)).toBeNull();
    expect(speedToMph({ value: 10, unit: 'mi1hr-1' })).toBe(10);
    expect(speedToMph({ value: 16.09344, unit: 'km1hr-1' })).toBe(10);
  });

  test('a non-numeric heading string is refused by the schema', () => {
    expect(
      deereBreadcrumbSchema.safeParse({
        ...DOC_BREADCRUMB,
        heading: { valueAsInteger: 'north' },
      }).success,
    ).toBe(false);
  });
});

describe('boundaries', () => {
  const ring = (pts: [number, number][], type: 'exterior' | 'interior') => ({
    '@type': 'Ring',
    points: pts.map(([lon, lat]) => ({ '@type': 'Point', lat, lon })),
    type,
    passable: true,
  });

  test('rings → a closed GeoJSON MultiPolygon, exterior first, holes kept', () => {
    const b = deereBoundarySchema.parse({
      '@type': 'Boundary',
      id: 'b1',
      multipolygons: [
        {
          '@type': 'Polygon',
          rings: [
            ring(
              [
                [-83.91, 41.9],
                [-83.92, 41.9],
                [-83.92, 41.91],
              ],
              'interior',
            ),
            ring(
              [
                [-84, 41.8],
                [-83.8, 41.8],
                [-83.8, 42],
                [-84, 42],
                [-84, 41.8],
              ],
              'exterior',
            ),
          ],
        },
      ],
    });
    const mp = deereBoundaryToMultiPolygon(b);
    expect(mp.type).toBe('MultiPolygon');
    expect(mp.coordinates).toHaveLength(1);
    expect(mp.coordinates[0]?.[0]?.[0]).toEqual([-84, 41.8]);
    expect(mp.coordinates[0]?.[1]).toEqual([
      [-83.91, 41.9],
      [-83.92, 41.9],
      [-83.92, 41.91],
      [-83.91, 41.9],
    ]);
  });

  test('two exterior rings in one Deere polygon become two polygons; none is an error', () => {
    const b = deereBoundarySchema.parse({
      multipolygons: [
        {
          rings: [
            ring(
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
              'exterior',
            ),
            ring(
              [
                [2, 2],
                [3, 2],
                [3, 3],
                [2, 2],
              ],
              'exterior',
            ),
          ],
        },
      ],
    });
    expect(deereBoundaryToMultiPolygon(b).coordinates).toHaveLength(2);
    const holesOnly = deereBoundarySchema.parse({
      multipolygons: [
        {
          rings: [
            ring(
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
              'interior',
            ),
          ],
        },
      ],
    });
    expect(() => deereBoundaryToMultiPolygon(holesOnly)).toThrow(RangeError);
  });

  test('areas in ha or ac', () => {
    expect(areaAcres({ value: 1, unit: 'ha' })).toBeCloseTo(ACRES_PER_HECTARE, 9);
    expect(areaAcres({ value: 80, unit: 'ac' })).toBe(80);
    expect(areaAcres({ value: 1, unit: 'm2' })).toBeNull();
    expect(areaAcres(undefined)).toBeNull();
  });
});

describe('flags and links', () => {
  /** The Flags doc's GET example: geometry is a JSON string. */
  const DOC_FLAGS = {
    links: [{ rel: 'self', uri: 'https://sandboxapi.deere.com/platform/organizations/1234/flags' }],
    total: 1,
    values: [
      {
        '@type': 'Flag',
        geometry: '{"type": "Point", "coordinates": [-93.14959274063109, 41.66881548411553]}',
        notes: 'A big rock on the left after entering the field',
        archived: false,
        proximityAlertEnabled: false,
        links: [
          {
            rel: 'field',
            uri: 'https://sandboxapi.deere.com/platform/organizations/1234/fields/7b387eaa-187f-4bd8-acbc-c81748b6ad3b',
          },
        ],
        id: '688c20bb-9609-4590-95c9-649ba65c06df',
        createdTime: '2018-07-01T21:00:11Z',
        lastModifiedTime: '2018-07-01T21:10:10Z',
      },
    ],
  };

  test('the documented flag list parses; its geometry string becomes GeoJSON', () => {
    const flags = deereFlagsSchema.parse(DOC_FLAGS);
    const f = flags.values[0];
    expect(f && deereFlagGeometry(f)).toEqual({
      type: 'Point',
      coordinates: [-93.14959274063109, 41.66881548411553],
    });
    expect(deereLinkId(f?.links, 'field')).toBe('7b387eaa-187f-4bd8-acbc-c81748b6ad3b');
    expect(deereLinkId(f?.links, 'nope')).toBeNull();
  });

  test('geometries Deere rejects are refused here too', () => {
    expect(() =>
      deereFlagGeometry({ geometry: '{"type":"MultiPoint","coordinates":[[0,0]]}' }),
    ).toThrow();
    expect(() => deereFlagGeometry({ geometry: 'not json' })).toThrow();
    expect(
      deereFlagGeometry({
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      }),
    ).toMatchObject({ type: 'LineString' });
  });

  test('link ids ignore matrix parameters, queries and trailing slashes', () => {
    const links = [
      { rel: 'a', uri: 'https://x/platform/fields/f1;start=0;count=10' },
      { rel: 'b', uri: 'https://x/platform/fields/f%202/?embed=x' },
    ];
    expect(deereLinkId(links, 'a')).toBe('f1');
    expect(deereLinkId(links, 'b')).toBe('f 2');
  });
});

describe('field operations', () => {
  test('the documented list example parses (mixed-case types, a tank mix product)', () => {
    const page = deereFieldOperationsSchema.parse({
      links: [{ rel: 'self', uri: 'https://sandboxapi.deere.com/platform/x' }],
      total: 2,
      values: [
        {
          '@type': 'FieldOperation',
          fieldOperationType: 'Tillage',
          adaptMachineType: 'unknown',
          cropSeason: '2012',
          modifiedTime: '2018-05-16T15:04:24.787Z',
          startDate: '2012-04-03T14:12:13.000Z',
          endDate: '2012-04-06T15:53:37.408Z',
          fieldOperationMachines: [
            {
              '@type': 'FieldOperationMachine',
              erid: 'e',
              machineId: 637795,
              vin: 'WXYEJKB73894JE3',
            },
          ],
          id: 'MjIzMDMxXzU4NDFkMDM2YTA2ZDkwMDk3MGYyNDJkMw',
          links: [],
        },
        {
          '@type': 'FieldOperation',
          fieldOperationType: 'application',
          cropSeason: '2013',
          startDate: '2013-07-03T16:36:08.000Z',
          products: { '@type': 'Product', name: 'Tank Mix', tankMix: true },
          id: 'MjIzMDMxXzU4NDFkMDM2YTA2ZDkwMDk3MGYyNDJkNg',
        },
      ],
    });
    expect(page.values.map((v) => v.fieldOperationType)).toEqual(['Tillage', 'application']);
  });
});
