import { describe, expect, test } from 'vitest';
import { deereOperationMeasurements, deereOperationProducts, mapDeereOperation } from './mapper';
import {
  type DeereOperationRaw,
  deereOpsFieldOperationSchema,
  deereOpsFieldOperationsSchema,
  embeddedMeasurementsOf,
} from './schemas';

/** Deere's own example operation (field-operations spec, "No Header" example, trimmed). */
const DEERE_EXAMPLE = {
  '@type': 'FieldOperation',
  fieldOperationType: 'application',
  adaptMachineType: 'unknown',
  cropSeason: '2013',
  modifiedTime: '2014-03-16T15:04:24.797Z',
  startDate: '2013-07-03T16:36:08.000Z',
  endDate: '2013-07-03T16:47:23.013Z',
  products: {
    '@type': 'Product',
    name: 'Tank Mix',
    tankMix: true,
    rate: { '@type': 'EventMeasurement', value: 12.5, unitId: 'gal1ac-1' },
    carrier: {
      '@type': 'Component',
      name: 'Water',
      rate: { '@type': 'EventMeasurement', value: 12.5, unitId: 'gal1ac-1' },
    },
    components: [
      {
        '@type': 'Component',
        name: 'Touchdown Total',
        rate: { '@type': 'EventMeasurement', value: 48, unitId: 'floz1ac-1' },
      },
      {
        '@type': 'Component',
        name: 'FS MaxSupreme',
        rate: { '@type': 'EventMeasurement', value: 32, unitId: 'floz1ac-1' },
      },
    ],
  },
  fieldOperationMachines: [
    {
      '@type': 'FieldOperationMachine',
      erid: 't48a7dd0-as35-44e1-81b4-435d494f7cd5',
      machineId: 637795,
      operators: [{ '@type': 'Operator', operatorId: 'OPERATOR_ID', name: 'OPERATOR_NAME' }],
      vin: 'WXYEJKB73894JE3',
    },
  ],
  id: 'MjIzMDMxXzU4NDFkMDM2YTA2ZDkwMDk3MGYyNDJkNg',
  links: [
    {
      '@type': 'Link',
      rel: 'field',
      uri: 'https://sandboxapi.deere.com/platform/organizations/123456/fields/d61b83f4-3a12-431e-8010-596f2466dc27',
    },
  ],
};

const ev = (value: number, unitId: string) => ({ value, unitId });

function raw(op: object, over: Partial<DeereOperationRaw> = {}): DeereOperationRaw {
  return {
    orgId: '123456',
    fieldId: 'd61b83f4-3a12-431e-8010-596f2466dc27',
    operation: deereOpsFieldOperationSchema.parse(op),
    measurements: [],
    coverage: null,
    coverageStatus: 'refused',
    ...over,
  };
}

describe("mapDeereOperation (Deere's example)", () => {
  test('a tank mix application: kind, crop year, products, machine, operator', () => {
    const [op] = mapDeereOperation(
      raw(DEERE_EXAMPLE, {
        measurements: [
          {
            measurementName: 'ApplicationRateResult',
            measurementCategory: 'Result',
            area: ev(32.4, 'ac'),
            averageMaterial: ev(12.5, 'gal1ac-1'),
            totalMaterial: ev(405, 'gal'),
          },
        ],
      }),
    );
    expect(op).toMatchObject({
      source: 'deere',
      sourceOrg: '123456',
      externalId: DEERE_EXAMPLE.id,
      fieldExternalId: 'd61b83f4-3a12-431e-8010-596f2466dc27',
      kind: 'application',
      cropYear: 2013,
      crop: null,
      startedAt: '2013-07-03T16:36:08.000Z',
      endedAt: '2013-07-03T16:47:23.013Z',
      areaAc: 32.4,
      machineExternalIds: ['637795'],
      operatorName: 'OPERATOR_NAME',
      coverage: null,
      modifiedAt: '2014-03-16T15:04:24.797Z',
    });
    expect(op?.products).toEqual([
      {
        name: 'Tank Mix',
        kind: 'other',
        rate: 12.5,
        rateUnit: 'gal1ac-1',
        total: 405,
        totalUnit: 'gal',
      },
      {
        name: 'Water',
        kind: 'other',
        rate: 12.5,
        rateUnit: 'gal1ac-1',
        total: null,
        totalUnit: null,
      },
      {
        name: 'Touchdown Total',
        kind: 'chemical',
        rate: 48,
        rateUnit: 'floz1ac-1',
        total: null,
        totalUnit: null,
      },
      {
        name: 'FS MaxSupreme',
        kind: 'chemical',
        rate: 32,
        rateUnit: 'floz1ac-1',
        total: null,
        totalUnit: null,
      },
    ]);
  });

  test("Deere's mixed case maps; carting and unknown types map to nothing", () => {
    expect(
      mapDeereOperation(raw({ ...DEERE_EXAMPLE, fieldOperationType: 'Tillage' }))[0]?.kind,
    ).toBe('tillage');
    expect(
      mapDeereOperation(raw({ ...DEERE_EXAMPLE, fieldOperationType: 'HARVEST' }))[0]?.kind,
    ).toBe('harvest');
    expect(mapDeereOperation(raw({ ...DEERE_EXAMPLE, fieldOperationType: 'CARTING' }))).toEqual([]);
  });

  test('missing cropSeason: the start date’s year in Michigan; an end before the start is clamped', () => {
    const { cropSeason: _c, ...noSeason } = DEERE_EXAMPLE;
    const [op] = mapDeereOperation(
      raw({ ...noSeason, startDate: '2027-01-01T03:00:00Z', endDate: '2027-01-01T02:00:00Z' }),
    );
    expect(op?.cropYear).toBe(2026); // 22:00 on Dec 31 in Adrian
    expect(op?.endedAt).toBe(op?.startedAt);
  });

  test('coverage: the generated boundary as a MultiPolygon (rings closed); none without an exterior', () => {
    const points = [
      { lat: 41.86, lon: -83.85 },
      { lat: 41.86, lon: -83.84 },
      { lat: 41.87, lon: -83.84 },
    ];
    const [op] = mapDeereOperation(
      raw(DEERE_EXAMPLE, {
        coverage: { multipolygons: [{ rings: [{ type: 'exterior', points }] }] },
        coverageStatus: 'ok',
      }),
    );
    expect(op?.coverage).toEqual({
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [-83.85, 41.86],
            [-83.84, 41.86],
            [-83.84, 41.87],
            [-83.85, 41.86],
          ],
        ],
      ],
    });
    const [none] = mapDeereOperation(
      raw(DEERE_EXAMPLE, {
        coverage: { multipolygons: [{ rings: [{ type: 'interior', points }] }] },
        coverageStatus: 'ok',
      }),
    );
    expect(none?.coverage).toBeNull();
  });

  test('a landed item that is not an operation fails the map (the event dead-letters)', () => {
    expect(() => mapDeereOperation({ orgId: 'x' })).toThrow();
  });
});

describe('deereOperationMeasurements', () => {
  test('harvest: area, yield, total, moisture, speed in US units', () => {
    expect(
      deereOperationMeasurements('harvest', [
        {
          measurementName: 'HarvestYieldResult',
          area: ev(61.16, 'ha'),
          yield: ev(27551.2, 'bu'),
          averageYield: ev(182.7, 'bu1ac-1'),
          averageMoisture: ev(18.4, 'prcnt'),
        },
        { measurementName: 'HarvestMoistureResult', averageMoisture: ev(18.2, 'prcnt') },
        { measurementName: 'HarvestSpeedResult', averageSpeed: ev(8, 'km1hr-1') },
      ]),
    ).toEqual({
      areaAc: 151.13,
      yieldBuAc: 182.7,
      totalBu: 27551.2,
      moisturePct: 18.2,
      avgSpeedMph: 5,
    });
  });

  test('a metric yield is left out rather than stored wrong; nonsense values too', () => {
    expect(
      deereOperationMeasurements('harvest', [
        {
          measurementName: 'HarvestYieldResult',
          area: ev(10, 'ac'),
          yield: ev(60, 't'),
          averageYield: ev(11.2, 't1ha-1'),
          averageMoisture: ev(140, 'prcnt'),
        },
      ]),
    ).toEqual({ areaAc: 10 });
  });

  test("the area comes from the kind's result measurement, else any result, else any", () => {
    expect(
      deereOperationMeasurements('seeding', [
        { measurementName: 'SeedingRateTarget', area: ev(99, 'ac') },
        { measurementName: 'SeedingRateResult', area: ev(80.2, 'ac') },
      ]),
    ).toEqual({ areaAc: 80.2 });
    expect(
      deereOperationMeasurements('tillage', [
        { measurementName: 'SeedingRateTarget', area: ev(5, 'ac') },
        { measurementName: 'SomethingNewResult', area: ev(7, 'ac') },
      ]),
    ).toEqual({ areaAc: 7 });
    expect(deereOperationMeasurements('tillage', [])).toEqual({});
  });
});

describe('deereOperationProducts', () => {
  const seeding = [
    {
      measurementName: 'SeedingRateResult',
      averageMaterial: ev(34000, 'seeds1ac-1'),
      totalMaterial: ev(5_100_000, 'seeds'),
    },
  ];

  test('one variety takes the seeding rate; several keep their own (or none)', () => {
    expect(
      deereOperationProducts(
        'seeding',
        { varieties: [{ productType: 'SEED', name: 'NF 108-22' }] },
        seeding,
      ),
    ).toEqual([
      {
        name: 'NF 108-22',
        kind: 'seed',
        rate: 34000,
        rateUnit: 'seeds1ac-1',
        total: 5_100_000,
        totalUnit: 'seeds',
      },
    ]);
    expect(
      deereOperationProducts(
        'seeding',
        { varieties: [{ name: 'A' }, { name: 'B' }, { name: 'B' }, { name: ' ' }] },
        seeding,
      ).map((p) => [p.name, p.rate]),
    ).toEqual([
      ['A', null],
      ['B', null],
    ]);
  });

  test('a list of single products (the Nov 2023 form) with their product types', () => {
    expect(
      deereOperationProducts(
        'application',
        {
          products: [
            { name: '28% UAN', productType: 'FERTILIZER', rate: ev(20, 'gal1ac-1') },
            { name: 'Mystery', productType: 'SOMETHING' },
          ],
        },
        [],
      ),
    ).toEqual([
      {
        name: '28% UAN',
        kind: 'fertilizer',
        rate: 20,
        rateUnit: 'gal1ac-1',
        total: null,
        totalUnit: null,
      },
      { name: 'Mystery', kind: null, rate: null, rateUnit: null, total: null, totalUnit: null },
    ]);
  });
});

describe('schemas', () => {
  test('embedded measurement types are read as a list or a { values } collection', () => {
    const m = { measurementName: 'SeedingRateResult', area: ev(1, 'ac') };
    const asList = deereOpsFieldOperationSchema.parse({ ...DEERE_EXAMPLE, measurementTypes: [m] });
    const asCollection = deereOpsFieldOperationSchema.parse({
      ...DEERE_EXAMPLE,
      measurementTypes: { '@type': 'x', total: 1, values: [m] },
    });
    expect(embeddedMeasurementsOf(asList)).toHaveLength(1);
    expect(embeddedMeasurementsOf(asCollection)).toHaveLength(1);
    expect(embeddedMeasurementsOf(deereOpsFieldOperationSchema.parse(DEERE_EXAMPLE))).toBeNull();
  });

  test("products or varieties in a shape we don't know never fail the page", () => {
    const page = deereOpsFieldOperationsSchema.parse({
      links: [],
      values: [{ ...DEERE_EXAMPLE, products: 'weird', varieties: 42 }],
    });
    expect(page.values[0]?.products).toBeUndefined();
    expect(page.values[0]?.varieties).toBeUndefined();
  });
});
