/** Tile as-built attribute parsing and mapping (pure), and the import:tile arguments. */
import { describe, expect, test } from 'vitest';
import { deterministicId } from '../../src/domain/ids';
import type { VectorFeature } from '../gis/parcels-io';
import { parseTileArgs } from './tile';
import {
  detectTileColumns,
  mapTileFeatures,
  parseDepthFt,
  parseInstalled,
  parseKind,
  parseSizeIn,
  parseTileColumnMap,
} from './tile-map';

const KEY = 'Drawing.geojson';
const line = (
  props: Record<string, unknown>,
  geometry: VectorFeature['geometry'] = {
    type: 'LineString',
    coordinates: [
      [-84.05, 41.9],
      [-84.05, 41.91],
    ],
  },
): VectorFeature => ({ geometry, properties: props, layer: 't' });

describe('units', () => {
  test('pipe size in inches (mm when it says so or is too big for inches)', () => {
    expect(parseSizeIn('4')).toBe(4);
    expect(parseSizeIn('6 in')).toBe(6);
    expect(parseSizeIn('5"')).toBe(5);
    expect(parseSizeIn('10-inch')).toBe(10);
    expect(parseSizeIn('100 mm')).toBe(3.94);
    expect(parseSizeIn(150)).toBe(5.91);
    expect(parseSizeIn('')).toBeNull();
    expect(parseSizeIn('n/a')).toBeNull();
    expect(parseSizeIn(-3)).toBeNull();
  });

  test('depth in feet (inches when marked, named *_IN, or too deep for feet)', () => {
    expect(parseDepthFt('3.5')).toBe(3.5);
    expect(parseDepthFt('4 ft')).toBe(4);
    expect(parseDepthFt('42 in')).toBe(3.5);
    expect(parseDepthFt('36"')).toBe(3);
    expect(parseDepthFt(48)).toBe(4);
    expect(parseDepthFt(30, true)).toBe(2.5);
    expect(parseDepthFt(null)).toBeNull();
  });

  test('install dates: ISO, US, or a bare year (kept as a year, not a made-up day)', () => {
    expect(parseInstalled('2019-06-14')).toEqual({ date: '2019-06-14', year: null });
    expect(parseInstalled('6/14/2019')).toEqual({ date: '2019-06-14', year: null });
    expect(parseInstalled('1998')).toEqual({ date: null, year: 1998 });
    expect(parseInstalled('2019-02-30')).toEqual({ date: null, year: null });
    expect(parseInstalled(new Date('2020-05-01T00:00:00Z'))).toEqual({
      date: '2020-05-01',
      year: null,
    });
    expect(parseInstalled('spring')).toEqual({ date: null, year: null });
  });

  test('kinds', () => {
    expect(parseKind('Main')).toBe('main');
    expect(parseKind('SUBMAIN')).toBe('submain');
    expect(parseKind('Sub-main')).toBe('submain');
    expect(parseKind('lateral')).toBe('lateral');
    expect(parseKind('Outlet header')).toBe('main');
    expect(parseKind('?')).toBe('unknown');
  });
});

describe('columns', () => {
  test('detected by usual names, or named with --map', () => {
    expect(detectTileColumns(['Size', 'DEPTH_IN', 'Install_Date', 'TYPE'])).toEqual({
      size: 'Size',
      depth: 'DEPTH_IN',
      installed: 'Install_Date',
      kind: 'TYPE',
    });
    expect(detectTileColumns(['PIPE', 'D'], parseTileColumnMap('size=pipe,depth=d'))).toEqual({
      size: 'PIPE',
      depth: 'D',
    });
    expect(() => parseTileColumnMap('colour=x')).toThrow(/bad --map/);
    expect(() => detectTileColumns(['A'], { size: 'B' })).toThrow(/no attribute/);
  });
});

describe('mapTileFeatures', () => {
  test('lines become rows with deterministic ids from the file name and feature number', () => {
    const r = mapTileFeatures(
      [
        line({
          TYPE: 'Main',
          SIZE: '6 in',
          DEPTH: '4',
          INSTALLED: '2019-06-14',
          NOTES: 'outlet to ditch',
        }),
        line({ TYPE: 'Lateral', SIZE: '4"', DEPTH: '42 in', INSTALLED: '1998' }),
        line({ TYPE: 'outlet' }, { type: 'Point', coordinates: [-84.05, 41.9] }),
      ],
      { fileKey: KEY },
    );
    expect(r.records).toHaveLength(2);
    expect(r.skipped).toEqual({ notLine: 1, empty: 0 });
    expect(r.records[0]).toMatchObject({
      sourceId: 'drawing.geojson#1',
      id: deterministicId('import', 'tile:drawing.geojson#1'),
      kind: 'main',
      sizeIn: 6,
      depthFt: 4,
      installedOn: '2019-06-14',
      notes: 'outlet to ditch',
    });
    expect(r.records[0]?.geometry.type).toBe('MultiLineString');
    expect(r.records[1]).toMatchObject({
      sourceId: 'drawing.geojson#2',
      kind: 'lateral',
      depthFt: 3.5,
      installedOn: null,
      notes: 'installed 1998',
    });
  });

  test('a feature id column keeps ids stable when lines are reordered; duplicates are refused', () => {
    const r = mapTileFeatures([line({ LINE_ID: 'B7' }), line({ LINE_ID: 'A1' })], { fileKey: KEY });
    expect(r.records.map((x) => x.sourceId)).toEqual(['drawing.geojson#B7', 'drawing.geojson#A1']);
    expect(() => mapTileFeatures([line({ ID: 1 }), line({ ID: 1 })], { fileKey: KEY })).toThrow(
      /share the id/,
    );
  });

  test('defaults fill only what a feature lacks; no kind column → the default kind', () => {
    const r = mapTileFeatures([line({ SIZE: '5' }), line({})], {
      fileKey: KEY,
      defaults: {
        sizeIn: 4,
        depthFt: 3,
        installer: 'Example Drainage',
        installedOn: '2020-04-01',
        kind: 'lateral',
      },
    });
    expect(r.records.map((x) => [x.sizeIn, x.depthFt, x.installer, x.installedOn, x.kind])).toEqual(
      [
        [5, 3, 'Example Drainage', '2020-04-01', 'lateral'],
        [4, 3, 'Example Drainage', '2020-04-01', 'lateral'],
      ],
    );
  });

  test('multi-part lines, collections, and too-short or projected lines', () => {
    const r = mapTileFeatures(
      [
        line(
          {},
          {
            type: 'MultiLineString',
            coordinates: [
              [
                [-84, 41.9],
                [-84.01, 41.9],
              ],
              [[-84.02, 41.9]],
            ],
          },
        ),
        line(
          {},
          {
            type: 'GeometryCollection',
            geometries: [
              {
                type: 'LineString',
                coordinates: [
                  [-84, 41.9],
                  [-84, 41.91],
                ],
              },
            ],
          },
        ),
        line({}, { type: 'LineString', coordinates: [[-84, 41.9]] }),
      ],
      { fileKey: KEY },
    );
    expect(r.records.map((x) => x.geometry.coordinates.length)).toEqual([1, 1]);
    expect(r.skipped.empty).toBe(1);
    expect(() =>
      mapTileFeatures(
        [
          line(
            {},
            {
              type: 'LineString',
              coordinates: [
                [500000, 4637000],
                [500100, 4637000],
              ],
            },
          ),
        ],
        { fileKey: KEY },
      ),
    ).toThrow(/\.prj/);
  });
});

describe('import:tile arguments', () => {
  test('defaults and options', () => {
    expect(parseTileArgs(['tile.zip'])).toMatchObject({
      input: 'tile.zip',
      origin: 'installer_drawing',
      field: null,
      replace: false,
    });
    expect(
      parseTileArgs([
        'plow.geojson',
        '--origin',
        'deere_tile_plow',
        '--field',
        'Kowalski North 80',
        '--size',
        '4',
        '--depth',
        '3.5',
        '--kind',
        'lateral',
        '--installed-on',
        '2026-05-01',
        '--replace',
      ]),
    ).toMatchObject({
      origin: 'deere_tile_plow',
      field: 'Kowalski North 80',
      sizeIn: 4,
      depthFt: 3.5,
      kind: 'lateral',
      installedOn: '2026-05-01',
      replace: true,
    });
  });

  test('refuses bad input', () => {
    expect(() => parseTileArgs([])).toThrow(/one file/);
    expect(() => parseTileArgs(['a', '--origin', 'manual'])).toThrow(/--origin/);
    expect(() => parseTileArgs(['a', '--size', 'big'])).toThrow(/--size/);
    expect(() => parseTileArgs(['a', '--kind', 'drain'])).toThrow(/--kind/);
    expect(() => parseTileArgs(['a', '--installed-on', '2026'])).toThrow(/YYYY-MM-DD/);
  });
});
