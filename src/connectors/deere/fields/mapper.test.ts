/**
 * deere.fields mappers against Deere's documented shapes (the portal's spec examples, see
 * ./schemas.ts): field with embedded farm and client, active boundary, flags (string geometry,
 * category → pin kind), Equipment API items (kind from isgType, else type; principalId), engine
 * hours (units).
 */
import { describe, expect, test } from 'vitest';
import { PIN_KINDS } from '../../../domain/pins';
import { deereBoundarySchema, deereEquipmentSchema } from '../schemas';
import {
  activeBoundaryOf,
  deereMachineKind,
  deereTypeName,
  engineHoursOf,
  flagCategoryOf,
  machineKindOfType,
  mapDeereBoundary,
  mapDeereEngineHours,
  mapDeereEquipment,
  mapDeereField,
  mapDeereFlag,
  pinKindOfCategory,
} from './mapper';
import { deereFieldWithRefsSchema, deereFlagWithCategorySchema } from './schemas';

const API = 'https://sandboxapi.deere.com/platform';
const ring = [
  { lat: 41.86, lon: -84.08 },
  { lat: 41.86, lon: -84.07 },
  { lat: 41.87, lon: -84.07 },
  { lat: 41.87, lon: -84.08 },
];

const boundary = (over: Record<string, unknown> = {}) =>
  deereBoundarySchema.parse({
    '@type': 'Boundary',
    id: 'b-1',
    name: ' North 80 ',
    modifiedTime: '2026-03-02T15:41:15.205Z',
    area: { '@type': 'MeasurementAsDouble', valueAsDouble: 32.37, unit: 'ha' },
    multipolygons: [{ rings: [{ points: ring, type: 'exterior' }] }],
    active: true,
    archived: false,
    links: [{ rel: 'field', uri: `${API}/organizations/1234/fields/f-1` }],
    ...over,
  });

/** Fields API spec example (FieldsReturned), with `embed=farms,clients` (schema FieldResponse). */
const FIELD = {
  '@type': 'Field',
  name: '01',
  archived: false,
  id: 'f-1',
  lastModifiedTime: '2020-09-21T15:41:15.205Z',
  farms: { '@type': 'Farms', farms: [{ '@type': 'Farm', name: 'Home 40s', id: 'farm-1' }] },
  clients: { '@type': 'Clients', clients: [{ '@type': 'Client', name: 'Aslan', id: 'client-1' }] },
  links: [{ '@type': 'Link', rel: 'owningOrganization', uri: `${API}/organizations/1234` }],
};

describe('fields and boundaries', () => {
  test('a field with its embedded farm and client and its active boundary', () => {
    const [item] = mapDeereField({
      orgId: '1234',
      orgName: 'Home',
      homeOrgId: '1234',
      field: deereFieldWithRefsSchema.parse(FIELD),
      boundary: boundary(),
    });
    expect(item?.homeOrgId).toBe('1234');
    expect(item?.field).toMatchObject({
      source: 'deere',
      sourceOrg: '1234',
      externalId: 'f-1',
      name: '01',
      farm: { externalId: 'farm-1', name: 'Home 40s' },
      client: { externalId: 'client-1', name: 'Aslan' },
      archived: false,
      modifiedAt: '2020-09-21T15:41:15.205Z',
    });
    const b = item?.field.boundary;
    expect(b).toMatchObject({ externalId: 'b-1', fieldExternalId: 'f-1', name: 'North 80' });
    expect(b?.geom.coordinates[0]?.[0]).toHaveLength(5); // closed
    expect(b?.areaAc).toBeCloseTo(80, 0);
  });

  test('without the embed a field has no farm or client; archived travels', () => {
    const [item] = mapDeereField({
      orgId: '1234',
      orgName: null,
      homeOrgId: null,
      field: deereFieldWithRefsSchema.parse({ id: 'f-2', name: ' ', archived: true }),
      boundary: null,
    });
    expect(item?.field).toMatchObject({
      name: 'f-2',
      farm: null,
      client: null,
      archived: true,
      boundary: null,
    });
  });

  test('the active boundary of a field: active, not archived, latest modified', () => {
    const list = [
      boundary({ id: 'old', active: true, modifiedTime: '2025-01-01T00:00:00Z' }),
      boundary({ id: 'new', active: true, modifiedTime: '2026-01-01T00:00:00Z' }),
      boundary({ id: 'inactive', active: false, modifiedTime: '2027-01-01T00:00:00Z' }),
      boundary({ id: 'archived', archived: true, modifiedTime: '2027-01-01T00:00:00Z' }),
      boundary({ id: 'other', links: [{ rel: 'field', uri: `${API}/organizations/1/fields/x` }] }),
    ];
    expect(activeBoundaryOf('f-1', list)?.id).toBe('new');
    expect(activeBoundaryOf('nope', list)).toBeNull();
  });

  test('a boundary with no id or no exterior ring is no boundary', () => {
    expect(mapDeereBoundary('1', 'f', boundary({ id: undefined }))).toBeNull();
    const noExterior = boundary({
      multipolygons: [{ rings: [{ points: ring, type: 'interior' }] }],
    });
    expect(mapDeereBoundary('1', 'f', noExterior)).toBeNull();
  });
});

describe('flags', () => {
  /** Flags API spec example (FlagsGet), with an embedded category. */
  const FLAG = {
    '@type': 'Flag',
    geometry: '{"type": "Point", "coordinates": [-93.14959274063109, 41.66881548411553]}',
    notes: 'A big rock on the left after entering the field',
    archived: false,
    proximityAlertEnabled: false,
    flagCategory: { '@type': 'FlagCategory', categoryTitle: 'Rocks', id: 'c-1' },
    links: [
      { rel: 'owningOrganization', uri: `${API}/organizations/1234` },
      {
        rel: 'field',
        uri: `${API}/organizations/1234/fields/7b387eaa-187f-4bd8-acbc-c81748b6ad3b`,
      },
    ],
    id: '688c20bb-9609-4590-95c9-649ba65c06df',
    createdTime: '2018-07-01T21:00:11Z',
    lastModifiedTime: '2018-07-01T21:10:10Z',
  };

  test('a flag: geometry from the string, its field, category and times', () => {
    const f = mapDeereFlag('1234', deereFlagWithCategorySchema.parse(FLAG));
    expect(f).toEqual({
      source: 'deere',
      sourceOrg: '1234',
      externalId: '688c20bb-9609-4590-95c9-649ba65c06df',
      fieldExternalId: '7b387eaa-187f-4bd8-acbc-c81748b6ad3b',
      geometry: { type: 'Point', coordinates: [-93.14959274063109, 41.66881548411553] },
      note: 'A big rock on the left after entering the field',
      category: 'Rocks',
      archived: false,
      createdAt: '2018-07-01T21:00:11.000Z',
      modifiedAt: '2018-07-01T21:10:10.000Z',
    });
  });

  test('archived, no category, no field, no notes; a bad geometry drops the flag', () => {
    const f = mapDeereFlag(
      '1',
      deereFlagWithCategorySchema.parse({
        id: 'x',
        archived: true,
        geometry: {
          type: 'LineString',
          coordinates: [
            [-84, 41.8],
            [-84.01, 41.81],
          ],
        },
      }),
    );
    expect(f).toMatchObject({ archived: true, category: null, fieldExternalId: null, note: null });
    const bad = deereFlagWithCategorySchema.parse({ id: 'y', geometry: '{"type":"Circle"}' });
    expect(mapDeereFlag('1', bad)).toBeNull();
    const broken = deereFlagWithCategorySchema.parse({ id: 'z', geometry: '{not json' });
    expect(mapDeereFlag('1', broken)).toBeNull();
  });

  test('category titles: categoryTitle, else name, trimmed', () => {
    const of = (c: object) =>
      flagCategoryOf(deereFlagWithCategorySchema.parse({ ...FLAG, flagCategory: c }));
    expect(of({ categoryTitle: ' Rocks ' })).toBe('Rocks');
    expect(of({ name: 'Wet Spot' })).toBe('Wet Spot');
    expect(of({ categoryTitle: '' })).toBeNull();
  });

  test.each([
    ['Rocks', 'rock'],
    ['rock', 'rock'],
    ['Stone pile', 'rock'],
    ['Wet Spot', 'wet_hole'],
    ['wet_hole', 'wet_hole'],
    ['Water hole', 'wet_hole'],
    ['Tile Blowout', 'tile_blowout'],
    ['TILE', 'tile_blowout'],
    ['Washout', 'washout'],
    ['wash-out', 'washout'],
    ['Erosion', 'washout'],
    ['Hazard', 'hazard'],
    ['Power line', 'hazard'],
    ['Old well', 'hazard'],
    ['Weeds', 'note'],
    ['Note', 'note'],
    ['', 'note'],
  ])('category %j → %s', (category, kind) => {
    expect(pinKindOfCategory(category)).toBe(kind);
    expect(PIN_KINDS).toContain(pinKindOfCategory(category));
  });

  test('no category is a note', () => {
    expect(pinKindOfCategory(null)).toBe('note');
    expect(pinKindOfCategory(undefined)).toBe('note');
  });
});

describe('equipment', () => {
  /** Equipment API spec example (equipmentForList), trimmed. */
  const ITEM = deereEquipmentSchema.parse({
    name: '1H0S680SCE0766303',
    serialNumber: '1H0S680SCE0766303',
    modelYear: '2014',
    make: { name: 'JOHN DEERE', id: '1111' },
    type: { name: 'Combine', id: 222 },
    isgType: { name: 'Combine', id: 2 },
    model: { name: 'S680', id: 65985 },
    organization: [{ '@type': 'Resource', id: 1234 }],
    telematicsCapable: true,
    archived: false,
    principalId: 217373,
    id: 'org-equipment-9',
  });

  test('keyed by principalId (never the organization-equipment id), make, model, year', () => {
    expect(mapDeereEquipment('1234', ITEM)).toEqual({
      machine: {
        source: 'deere',
        sourceOrg: '1234',
        externalId: '217373',
        name: '1H0S680SCE0766303',
        kind: 'combine',
        make: 'JOHN DEERE',
        model: 'S680',
        year: 2014,
        vin: '1H0S680SCE0766303',
      },
      typeName: 'Combine',
      archived: false,
      telematicsCapable: true,
    });
    const noPrincipal = deereEquipmentSchema.parse({ id: 'e-1', name: 'x' });
    expect(mapDeereEquipment('1', noPrincipal)).toBeNull();
  });

  test.each([
    ['Combine', 'combine'],
    ['Tractor', 'tractor'],
    ['4WD Tractor', 'tractor'],
    ['Row Crop Tractors', 'tractor'],
    ['Self-Propelled Sprayer', 'sprayer'],
    ['Sprayer', 'sprayer'],
    ['Grain Cart', 'grain_cart'],
    ['Planter', 'planter'],
    ['Pickup', 'pickup'],
    ['Drone', 'drone'],
    ['Scraper', null],
    ['Loader', null],
    ['Compact Track Loader', null],
    ['Utility Vehicle', null],
    ['Gator', null],
    ['Truck', null],
    ['Truck Tractor', null],
    ['Other', null],
    ['', null],
  ])('type %j → %s', (name, kind) => {
    expect(machineKindOfType(name)).toBe(kind);
  });

  test('the ISG type wins; the deprecated EquipmentType is the fallback', () => {
    expect(deereMachineKind({ isgType: { name: 'Combine' }, type: { name: 'Tractor' } })).toBe(
      'combine',
    );
    expect(deereMachineKind({ type: { name: 'Tractor' } })).toBe('tractor');
    expect(deereMachineKind({ isgType: { name: 'Gizmo' }, type: { name: 'Sprayer' } })).toBe(
      'sprayer',
    );
    expect(deereMachineKind({})).toBeNull();
    expect(deereTypeName({ isgType: { name: 'Utility Vehicle' } })).toBe('Utility Vehicle');
    expect(deereTypeName({ type: { name: 'Gator' } })).toBe('Gator');
    expect(deereTypeName({})).toBe('unknown');
  });

  test('a name falls back to the serial number, then the principalId; odd years are null', () => {
    const e = deereEquipmentSchema.parse({ id: 'e', principalId: '9', modelYear: '14' });
    expect(mapDeereEquipment('1', e)?.machine).toMatchObject({
      name: 'Deere 9',
      year: null,
      vin: null,
      make: null,
      kind: null,
    });
  });
});

describe('engine hours', () => {
  test.each([
    [{ valueAsDouble: 1.1833333, unit: 'Hours' }, 1.2],
    [{ valueAsDouble: 4312.04, unit: 'hr' }, 4312],
    [{ valueAsDouble: 600, unit: 'Minutes' }, 10],
    [{ valueAsDouble: 36_000, unit: 'Seconds' }, 10],
    [{ valueAsDouble: 12 }, 12],
    [{ valueAsDouble: 12, unit: 'km' }, null],
    [{ valueAsDouble: -1, unit: 'Hours' }, null],
  ])('%j → %s h', (reading, hours) => {
    expect(engineHoursOf(reading)).toBe(hours);
  });

  test('a report as a NormalizedVehicleStat (the spec example)', () => {
    expect(
      mapDeereEngineHours({
        orgId: '1234',
        principalId: '4321',
        report: {
          reading: {
            '@type': 'measurementAsDouble',
            valueAsDouble: 1.1833333,
            links: null,
            unit: 'Hours',
          },
          reportTime: '2010-10-04T15:06:34.000Z',
          source: 'TM',
          links: [{ rel: 'machine', uri: `${API}/machines/4321` }],
        },
      }),
    ).toEqual([
      {
        source: 'deere',
        externalMachineId: '4321',
        sourceOrg: '1234',
        ts: '2010-10-04T15:06:34.000Z',
        engineHours: 1.2,
      },
    ]);
    expect(
      mapDeereEngineHours({
        orgId: '1',
        principalId: '2',
        report: {
          reading: { valueAsDouble: 5, unit: 'liters' },
          reportTime: '2026-01-01T00:00:00Z',
        },
      }),
    ).toEqual([]);
  });
});
