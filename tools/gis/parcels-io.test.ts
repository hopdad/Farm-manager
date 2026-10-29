/** Vector inputs: GeoJSON, a shapefile set on disk, ArcGIS FeatureServer paging, ogr2ogr args. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  checkLngLat,
  featureServerPageUrl,
  fetchFeatureServer,
  GDAL_IMAGE,
  isArcGisLayerUrl,
  ogr2ogrArgs,
  pageExceeded,
  parseGeoJsonText,
  readVectorInput,
  readWithGdal,
  VectorInputError,
} from './parcels-io';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'farm-vector-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A one-polygon .shp (shape type 5) in memory. */
function polygonShp(ring: [number, number][]): Uint8Array {
  const nPoints = ring.length;
  const contentBytes = 4 + 32 + 4 + 4 + 4 + nPoints * 16;
  const buf = new DataView(new ArrayBuffer(100 + 8 + contentBytes));
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  buf.setInt32(0, 9994);
  buf.setInt32(24, buf.byteLength / 2);
  buf.setInt32(28, 1000, true);
  buf.setInt32(32, 5, true);
  box.forEach((v, i) => {
    buf.setFloat64(36 + i * 8, v, true);
  });
  buf.setInt32(100, 1);
  buf.setInt32(104, contentBytes / 2);
  let o = 108;
  buf.setInt32(o, 5, true);
  o += 4;
  for (const v of box) {
    buf.setFloat64(o, v, true);
    o += 8;
  }
  buf.setInt32(o, 1, true); // parts
  buf.setInt32(o + 4, nPoints, true);
  buf.setInt32(o + 8, 0, true); // part 0 starts at point 0
  o += 12;
  for (const [x, y] of ring) {
    buf.setFloat64(o, x, true);
    buf.setFloat64(o + 8, y, true);
    o += 16;
  }
  return new Uint8Array(buf.buffer);
}

/** A one-record .dbf with a character field PIN. */
function pinDbf(pin: string): Uint8Array {
  const len = 16;
  const headerLen = 32 + 32 + 1;
  const buf = new Uint8Array(headerLen + 1 + len + 1);
  const view = new DataView(buf.buffer);
  buf[0] = 0x03;
  view.setUint32(4, 1, true);
  view.setUint16(8, headerLen, true);
  view.setUint16(10, 1 + len, true);
  buf.set(new TextEncoder().encode('PIN'), 32);
  buf[32 + 11] = 'C'.charCodeAt(0);
  buf[32 + 16] = len;
  buf[64] = 0x0d;
  buf[65] = 0x20;
  buf.set(new TextEncoder().encode(pin.padEnd(len, ' ')), 66);
  buf[buf.length - 1] = 0x1a;
  return buf;
}

describe('GeoJSON', () => {
  test('a FeatureCollection, a Feature and a bare geometry', () => {
    const poly = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
    expect(
      parseGeoJsonText(
        JSON.stringify({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: poly, properties: { a: 1 } }],
        }),
        'x.geojson',
      ),
    ).toEqual([{ geometry: poly, properties: { a: 1 }, layer: 'x' }]);
    expect(
      parseGeoJsonText(
        `﻿${JSON.stringify({ type: 'Feature', geometry: poly, properties: null })}`,
        'y.json',
      )[0]?.properties,
    ).toEqual({});
    expect(parseGeoJsonText(JSON.stringify(poly), 'z.geojson')[0]?.geometry).toEqual(poly);
    expect(() => parseGeoJsonText('{nope', 'bad.json')).toThrow(VectorInputError);
    expect(() => parseGeoJsonText('{"a":1}', 'bad.json')).toThrow(/not GeoJSON/);
  });

  test('readVectorInput: file name, sha256 and features of a .geojson', async () => {
    const file = path.join(dir, 'p.geojson');
    await writeFile(file, '{"type":"FeatureCollection","features":[]}');
    const r = await readVectorInput(file);
    expect(r).toMatchObject({ name: 'p.geojson', bytes: 42, features: [], downloaded: null });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(readVectorInput(path.join(dir, 'missing.geojson'))).rejects.toThrow(
      /no such file/,
    );
    await writeFile(path.join(dir, 'x.txt'), 'x');
    await expect(readVectorInput(path.join(dir, 'x.txt'))).rejects.toThrow(/unsupported/);
  });
});

describe('shapefile set', () => {
  test('a .shp with its .dbf next to it (sidecar found by base name)', async () => {
    const ring: [number, number][] = [
      [-84.05, 41.9],
      [-84.05, 41.91],
      [-84.04, 41.91],
      [-84.04, 41.9],
      [-84.05, 41.9],
    ];
    await writeFile(path.join(dir, 'parcels.shp'), polygonShp(ring));
    await writeFile(path.join(dir, 'parcels.dbf'), pinDbf('XA0-1'));
    const r = await readVectorInput(path.join(dir, 'parcels.shp'));
    expect(r.features).toHaveLength(1);
    expect(r.features[0]?.properties).toEqual({ PIN: 'XA0-1' });
    expect(r.features[0]?.geometry?.type).toBe('Polygon');
    expect(r.features[0]?.layer).toBe('parcels');
    expect(r.bytes).toBeGreaterThan(100);
  });
});

describe('ArcGIS FeatureServer', () => {
  test('recognizes layer URLs', () => {
    expect(
      isArcGisLayerUrl('https://gis.example.com/arcgis/rest/services/Parcels/FeatureServer/0'),
    ).toBe(true);
    expect(isArcGisLayerUrl('https://gis.example.com/arcgis/rest/services/P/MapServer/12/')).toBe(
      true,
    );
    expect(isArcGisLayerUrl('https://gis.example.com/data/parcels.zip')).toBe(false);
  });

  test('page URLs ask for GeoJSON in WGS84, ordered by the object id', () => {
    const u = new URL(
      featureServerPageUrl('https://h.example/FeatureServer/0/', 'FID', 2000, 1000),
    );
    expect(u.pathname).toBe('/FeatureServer/0/query');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      where: '1=1',
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      orderByFields: 'FID',
      resultOffset: '2000',
      resultRecordCount: '1000',
      f: 'geojson',
    });
  });

  test('pageExceeded reads the flag at the top or under properties', () => {
    expect(pageExceeded({ exceededTransferLimit: true })).toBe(true);
    expect(pageExceeded({ properties: { exceededTransferLimit: true } })).toBe(true);
    expect(pageExceeded({ properties: {} })).toBe(false);
  });

  test('pages while exceededTransferLimit says so (an empty page included)', async () => {
    const feature = (n: number) => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      properties: { OBJECTID: n },
    });
    const calls: string[] = [];
    const pages: Record<string, unknown> = {
      '0': {
        type: 'FeatureCollection',
        features: [feature(1), feature(2)],
        properties: { exceededTransferLimit: true },
      },
      '2': { type: 'FeatureCollection', features: [], exceededTransferLimit: true },
      '4': { type: 'FeatureCollection', features: [feature(5)] },
    };
    const fetch = async (url: string) => {
      calls.push(url);
      if (url.endsWith('?f=json')) {
        return Response.json({
          name: 'Parcels',
          objectIdField: 'OBJECTID',
          maxRecordCount: 2,
          advancedQueryCapabilities: { supportsPagination: true },
        });
      }
      const offset = new URL(url).searchParams.get('resultOffset') ?? '';
      return Response.json(pages[offset] ?? { error: { message: 'unexpected offset' } });
    };
    const r = await fetchFeatureServer('https://h.example/arcgis/rest/services/P/FeatureServer/0', {
      fetch,
    });
    expect(r.pages).toBe(3);
    expect(r.features.map((f) => f.properties.OBJECTID)).toEqual([1, 2, 5]);
    expect(r.features[0]?.layer).toBe('Parcels');
    expect(JSON.parse(r.text).features).toHaveLength(3);
    expect(calls).toHaveLength(4);
  });

  test('a layer that cannot page is refused with the GDAL alternative; service errors surface', async () => {
    const noPaging = async () =>
      Response.json({
        objectIdField: 'OBJECTID',
        advancedQueryCapabilities: { supportsPagination: false },
      });
    await expect(
      fetchFeatureServer('https://h.example/FeatureServer/0', { fetch: noPaging }),
    ).rejects.toThrow(/ogr2ogr/);
    const err = async () => Response.json({ error: { code: 499, message: 'Token Required' } });
    await expect(
      fetchFeatureServer('https://h.example/FeatureServer/0', { fetch: err }),
    ).rejects.toThrow(/Token Required/);
  });
});

describe('GDAL (GeoPackage and friends)', () => {
  test('ogr2ogr runs in the pinned image, read-only input, GeoJSON out in WGS84', () => {
    const args = ogr2ogrArgs('/data/in', 'parcels.gpkg', '/tmp/out', 'tax_parcels');
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toContain('/data/in:/in:ro');
    expect(args).toContain(GDAL_IMAGE);
    expect(args.slice(args.indexOf('ogr2ogr'))).toEqual([
      'ogr2ogr',
      '-f',
      'GeoJSON',
      '-t_srs',
      'EPSG:4326',
      '-lco',
      'RFC7946=YES',
      '/out/out.geojson',
      '/in/parcels.gpkg',
      'tax_parcels',
    ]);
  });

  test('readWithGdal reads the converted file and reports a failed conversion', async () => {
    const ok = async (_cmd: string, args: string[]) => {
      const out = (args[args.indexOf('-v', 3) + 1] ?? '').split(':/out')[0] as string;
      await writeFile(
        path.join(out, 'out.geojson'),
        '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":null,"properties":{"PIN":"1"}}]}',
      );
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await readWithGdal(path.join(dir, 'x.gpkg'), { run: ok });
    expect(r[0]?.properties).toEqual({ PIN: '1' });
    const fail = async () => ({
      code: 1,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
    });
    await expect(readWithGdal(path.join(dir, 'x.gpkg'), { run: fail })).rejects.toThrow(/Docker/);
  });
});

test('checkLngLat', () => {
  expect(checkLngLat({ type: 'Point', coordinates: [-84, 41.9] })).toBeNull();
  expect(checkLngLat({ type: 'Point', coordinates: [500000, 4637000] })).toMatch(/\.prj/);
  expect(
    checkLngLat({
      type: 'LineString',
      coordinates: [
        [Number.NaN, 0],
        [1, 1],
      ],
    }),
  ).toMatch(/number/);
});
