/** The draw tool's pure parts: the sketch, the form, the payloads and the map GeoJSON. */
import { describe, expect, test } from 'vitest';
import {
  createTileLineSchema,
  parseBbox,
  type TileLineView,
  tileGeometrySchema,
  updateTileLineSchema,
} from '../../../db/queries/tile-lines-schema';
import {
  addPoint,
  canFinish,
  createPayload,
  describeLine,
  EMPTY_FORM,
  formOf,
  type LngLatPair,
  lengthFt,
  linesCollection,
  movePoint,
  paddedBbox,
  parseForm,
  pointsOf,
  sketchCollection,
  undoPoint,
  updatePayload,
} from './model';

const LINE: TileLineView = {
  id: '11111111-1111-4111-8111-111111111111',
  fieldId: null,
  fieldName: null,
  geometry: {
    type: 'MultiLineString',
    coordinates: [
      [
        [-84.05, 41.9],
        [-84.05, 41.91],
      ],
      [
        [-84.04, 41.9],
        [-84.04, 41.905],
        [-84.04, 41.91],
      ],
    ],
  },
  kind: 'main',
  sizeIn: 6,
  depthFt: 4,
  installedOn: '2019-06-14',
  origin: 'manual',
  installer: null,
  notes: 'outlet',
  source: 'app',
  lengthFt: 2305.4,
  version: '2026-11-02T12:00:00.000001Z',
  editable: true,
};

describe('sketch', () => {
  test('add (rounded, no duplicate double taps), undo, move, finish', () => {
    let pts: LngLatPair[] = [];
    pts = addPoint(pts, [-84.0500000123, 41.9000000456]);
    pts = addPoint(pts, [-84.05000001, 41.90000004]);
    expect(pts).toEqual([[-84.05, 41.9]]);
    expect(canFinish(pts)).toBe(false);
    pts = addPoint(pts, [-84.05, 41.91]);
    expect(canFinish(pts)).toBe(true);
    pts = movePoint(pts, 1, [-84.049, 41.911]);
    expect(pts[1]).toEqual([-84.049, 41.911]);
    expect(movePoint(pts, 9, [0, 0])).toEqual(pts);
    expect(undoPoint(pts)).toEqual([[-84.05, 41.9]]);
  });

  test('length in feet (0.01° of latitude ≈ 3,648 ft)', () => {
    expect(
      lengthFt([
        [-84.05, 41.9],
        [-84.05, 41.91],
      ]),
    ).toBeCloseTo(3648, 0);
    expect(lengthFt([[-84.05, 41.9]])).toBe(0);
  });

  test('sketch and lines GeoJSON for the tool’s map sources', () => {
    const s = sketchCollection([
      [-84.05, 41.9],
      [-84.05, 41.91],
    ]);
    expect(s.features.map((f) => [f.properties.role, f.properties.index])).toEqual([
      ['line', -1],
      ['vertex', 0],
      ['vertex', 1],
    ]);
    expect(sketchCollection([[-84, 41]]).features).toHaveLength(1);
    const l = linesCollection([LINE], LINE.id);
    expect(l.features[0]?.properties).toEqual({ id: LINE.id, kind: 'main', selected: true });
    expect(linesCollection([LINE], null, LINE.id).features).toHaveLength(0);
  });

  test('a stored line’s longest part becomes the editable sketch', () => {
    expect(pointsOf(LINE)).toEqual([
      [-84.04, 41.9],
      [-84.04, 41.905],
      [-84.04, 41.91],
    ]);
  });
});

describe('form', () => {
  test('parses sizes, depths and dates as typed', () => {
    expect(
      parseForm({
        ...EMPTY_FORM,
        sizeIn: '6"',
        depthFt: '3.5 ft',
        installedOn: '2026-05-01',
        notes: '  near ditch ',
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: 'lateral',
        sizeIn: 6,
        depthFt: 3.5,
        installedOn: '2026-05-01',
        notes: 'near ditch',
      },
    });
    expect(parseForm(EMPTY_FORM)).toEqual({
      ok: true,
      value: { kind: 'lateral', sizeIn: null, depthFt: null, installedOn: null, notes: null },
    });
    expect(parseForm({ ...EMPTY_FORM, sizeIn: 'big' })).toEqual({
      ok: false,
      error: 'Size must be a positive number',
    });
    expect(parseForm({ ...EMPTY_FORM, depthFt: '45' })).toMatchObject({ ok: false });
    expect(parseForm({ ...EMPTY_FORM, installedOn: '2026-02-31x' })).toMatchObject({ ok: false });
  });

  test('payloads pass the server’s schemas', () => {
    const create = createPayload(
      [
        [-84.05, 41.9],
        [-84.05, 41.91],
      ],
      { ...EMPTY_FORM, kind: 'main', sizeIn: '8' },
    );
    expect(typeof create).toBe('object');
    expect(createTileLineSchema.safeParse(create).success).toBe(true);
    expect(createPayload([[-84.05, 41.9]], EMPTY_FORM)).toMatch(/two points/);
    const upd = updatePayload(LINE.version, formOf(LINE), null);
    expect(updateTileLineSchema.safeParse(upd).success).toBe(true);
    expect(upd).not.toHaveProperty('geometry');
    const reshaped = updatePayload(LINE.version, formOf(LINE), [
      [-84, 41.9],
      [-84, 41.91],
    ]);
    expect(reshaped).toHaveProperty('geometry.type', 'LineString');
    expect(formOf(LINE)).toEqual({
      kind: 'main',
      sizeIn: '6',
      depthFt: '4',
      installedOn: '2019-06-14',
      notes: 'outlet',
    });
  });

  test('describeLine', () => {
    expect(describeLine(LINE)).toBe('2,305 ft · 6" main at 4 ft');
    expect(describeLine({ ...LINE, sizeIn: null, depthFt: null, kind: 'lateral' })).toBe(
      '2,305 ft · lateral',
    );
  });
});

describe('schemas and bbox', () => {
  test('geometry: lines in lng/lat with 2+ points', () => {
    expect(
      tileGeometrySchema.safeParse({
        type: 'LineString',
        coordinates: [
          [-84, 41.9],
          [-84, 41.91],
        ],
      }).success,
    ).toBe(true);
    expect(
      tileGeometrySchema.safeParse({ type: 'LineString', coordinates: [[-84, 41.9]] }).success,
    ).toBe(false);
    expect(
      tileGeometrySchema.safeParse({
        type: 'LineString',
        coordinates: [
          [500000, 41.9],
          [0, 0],
        ],
      }).success,
    ).toBe(false);
    expect(tileGeometrySchema.safeParse({ type: 'Polygon', coordinates: [] }).success).toBe(false);
  });

  test('parseBbox and paddedBbox stay inside the API limits', () => {
    expect(parseBbox('-84.1,41.8,-84,41.9')).toEqual([-84.1, 41.8, -84, 41.9]);
    expect(parseBbox('-84,41.8,-84.1,41.9')).toBeNull();
    expect(parseBbox('-90,40,-80,41')).toBeNull(); // wider than 2°
    expect(parseBbox('a,b,c,d')).toBeNull();
    expect(parseBbox(null)).toBeNull();
    const b = paddedBbox({ west: -84.1, south: 41.8, east: -84, north: 41.9 });
    expect(parseBbox(b)).not.toBeNull();
    expect(parseBbox(paddedBbox({ west: -100, south: 30, east: -70, north: 50 }))).not.toBeNull();
  });
});
