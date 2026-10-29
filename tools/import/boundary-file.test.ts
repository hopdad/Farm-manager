import { describe, expect, test } from 'vitest';
import {
  extractBoundaries,
  nameFromFileName,
  parseBoundaryFiles,
  readBoundaryFiles,
} from './boundary-file';
import { rectangle, shapefileFiles, UTM17N_PRJ, zip } from './testing/shapefile';

const enc = new TextEncoder();
const file = (name: string, bytes: Uint8Array | string) => ({
  name,
  bytes: typeof bytes === 'string' ? enc.encode(bytes) : bytes,
});

/** An Ops-Center-style export: one shapefile, a row per field with client/farm/field names. */
function opsCenterZip() {
  return zip(
    shapefileFiles('Boundaries/Hopson Farms', [
      {
        geometry: rectangle(-84.06, 41.89, 800, 800),
        attributes: { CLIENT_NAME: 'Hopson Farms', FARM_NAME: 'Home', FIELD_NAME: 'North 160' },
      },
      {
        geometry: rectangle(-84.04, 41.89, 400, 800),
        attributes: { CLIENT_NAME: 'Hopson Farms', FARM_NAME: 'Home', FIELD_NAME: 'Creek 80' },
      },
    ]),
  );
}

describe('readBoundaryFiles / extractBoundaries', () => {
  test('a zipped shapefile: names, farm and client from the .dbf (10-character column names)', async () => {
    const r = await parseBoundaryFiles([file('export.zip', opsCenterZip())]);
    expect(r.errors).toEqual([]);
    expect(r.featureCount).toBe(2);
    expect(r.attributes.sort()).toEqual(['CLIENT_NAM', 'FARM_NAME', 'FIELD_NAME']);
    expect(r.boundaries.map((b) => [b.name, b.farmName, b.clientName, b.nameSource])).toEqual([
      ['North 160', 'Home', 'Hopson Farms', 'attribute'],
      ['Creek 80', 'Home', 'Hopson Farms', 'attribute'],
    ]);
    const north = r.boundaries[0];
    expect(north?.geometry.type).toBe('MultiPolygon');
    const ring = north?.geometry.coordinates[0]?.[0] ?? [];
    expect(ring[0]?.[0]).toBeCloseTo(-84.06, 6);
    expect(north?.sourceRef).toBe('export.zip: Boundaries/Hopson Farms#1');
  });

  test('the .prj reprojects UTM 17N metres to longitude/latitude', async () => {
    const utm = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [292_800, 4_648_000],
          [293_600, 4_648_000],
          [293_600, 4_648_800],
          [292_800, 4_648_800],
          [292_800, 4_648_000],
        ],
      ],
    };
    const files = shapefileFiles('field', [{ geometry: utm, attributes: { NAME: 'Monroe 40' } }], {
      prj: UTM17N_PRJ,
    });
    const r = await parseBoundaryFiles([file('monroe.zip', zip(files))]);
    expect(r.errors).toEqual([]);
    const [lng, lat] = r.boundaries[0]?.geometry.coordinates[0]?.[0]?.[0] ?? [];
    expect(lng).toBeGreaterThan(-84);
    expect(lng).toBeLessThan(-83);
    expect(lat).toBeGreaterThan(41.5);
    expect(lat).toBeLessThan(42.5);
    expect(r.warnings).toEqual([]);
  });

  test('projected coordinates without a .prj are refused, not imported into the ocean', async () => {
    const utm = rectangle(0, 0, 1, 1);
    utm.coordinates[0] = [
      [292_800, 4_648_000],
      [293_600, 4_648_000],
      [293_600, 4_648_800],
      [292_800, 4_648_000],
    ];
    const files = shapefileFiles('field', [{ geometry: utm, attributes: { NAME: 'X' } }], {
      prj: null,
    });
    const r = await parseBoundaryFiles([file('noprj.zip', zip(files))]);
    expect(r.boundaries).toEqual([]);
    expect(r.errors[0]).toMatch(/not longitude\/latitude.*\.prj/);
  });

  test('an unzipped set: the .shp with its .dbf and .prj', async () => {
    const files = shapefileFiles('Fields', [
      { geometry: rectangle(-84.06, 41.89, 500, 500), attributes: { Field: 'Home 40' } },
    ]);
    const r = await parseBoundaryFiles(
      Object.entries(files).map(([name, bytes]) => file(name, bytes)),
    );
    expect(r.errors).toEqual([]);
    expect(r.boundaries.map((b) => b.name)).toEqual(['Home 40']);
    expect(r.boundaries[0]?.sourceRef).toBe('Fields.shp: Fields#1');
  });

  test('one shapefile per field in folders: the folder names a generic "Boundary" file', async () => {
    const z = zip({
      ...shapefileFiles('Hopson/Home/Kowalski North/Boundary', [
        { geometry: rectangle(-84.06, 41.89, 500, 500), attributes: { AREA: '61.8' } },
      ]),
      ...shapefileFiles('Hopson/Home/Pond 20/Boundary', [
        { geometry: rectangle(-84.05, 41.89, 300, 300), attributes: { AREA: '22.2' } },
      ]),
    });
    const r = await parseBoundaryFiles([file('per-field.zip', z)]);
    expect(r.errors).toEqual([]);
    expect(r.boundaries.map((b) => [b.name, b.nameSource]).sort()).toEqual([
      ['Kowalski North', 'file name'],
      ['Pond 20', 'file name'],
    ]);
  });

  test('GeoJSON: features of one field are combined; null geometry is a warning', async () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'Split 80' },
          geometry: rectangle(-84.06, 41.89, 300, 300),
        },
        {
          type: 'Feature',
          properties: { name: 'split  80 ' },
          geometry: rectangle(-84.05, 41.89, 300, 300),
        },
        { type: 'Feature', properties: { name: 'Nothing' }, geometry: null },
      ],
    };
    const r = await parseBoundaryFiles([file('fields.geojson', `﻿${JSON.stringify(fc)}`)]);
    expect(r.errors).toEqual([]);
    expect(r.boundaries).toHaveLength(1);
    expect(r.boundaries[0]?.geometry.coordinates).toHaveLength(2);
    expect(r.boundaries[0]?.featureCount).toBe(2);
    expect(r.warnings).toEqual(['fields#3 (Nothing): no geometry, skipped']);
  });

  test('points, a missing name column and a non-WGS84 GeoJSON are errors with a fix', async () => {
    const pts = await parseBoundaryFiles([
      file(
        'p.geojson',
        JSON.stringify({
          type: 'Feature',
          properties: { name: 'Well' },
          geometry: { type: 'Point', coordinates: [-84, 41.9] },
        }),
      ),
    ]);
    expect(pts.errors).toEqual(['p#1 (Well) is a Point, not a polygon']);

    const layers = await readBoundaryFiles([file('export.zip', opsCenterZip())]);
    const named = extractBoundaries(layers, { nameAttr: 'TRACT' });
    expect(named.errors[0]).toMatch(/no attribute 'TRACT' \(attributes: .*FIELD_NAME/);

    await expect(
      readBoundaryFiles([
        file(
          'm.geojson',
          JSON.stringify({
            type: 'FeatureCollection',
            crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
            features: [],
          }),
        ),
      ]),
    ).rejects.toThrow(/EPSG::3857.*WGS84/);
    await expect(readBoundaryFiles([file('notes.txt', 'x')])).rejects.toThrow(/unsupported/);
  });

  test('a Deere field id column groups features and is carried along', async () => {
    const layers = [
      {
        fileName: 'deere',
        features: [
          {
            type: 'Feature' as const,
            properties: { DEERE_FIELD_ID: 'f-1', FIELD_NAME: 'A' },
            geometry: rectangle(-84.06, 41.89, 300, 300),
          },
          {
            type: 'Feature' as const,
            properties: { DEERE_FIELD_ID: 'f-1', FIELD_NAME: 'A' },
            geometry: rectangle(-84.05, 41.89, 300, 300),
          },
        ],
      },
    ];
    const r = extractBoundaries(layers);
    expect(r.boundaries).toHaveLength(1);
    expect(r.boundaries[0]?.deereFieldId).toBe('f-1');
  });

  test('far-away coordinates (a wrong .prj) get a warning', () => {
    const r = extractBoundaries([
      {
        fileName: 'x',
        features: [
          {
            type: 'Feature',
            properties: { name: 'Kansas' },
            geometry: rectangle(-98, 38, 300, 300),
          },
        ],
      },
    ]);
    expect(r.warnings[0]).toMatch(/far from SE Michigan/);
  });
});

describe('nameFromFileName', () => {
  test('skips generic file names and uses the folder', () => {
    expect(nameFromFileName('Client/Farm/North 40/Boundary')).toBe('North 40');
    expect(nameFromFileName('North_40')).toBe('North 40');
    expect(nameFromFileName('export/boundaries')).toBeNull();
  });
});
