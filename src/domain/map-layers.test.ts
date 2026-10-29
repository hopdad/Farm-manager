import { describe, expect, test } from 'vitest';
import { LAYER_KEY_RE, legendSchema, type MapLayerRow, mapLayerRowSchema } from './map-layers';

const row: MapLayerRow = {
  key: 'naip_aoi',
  kind: 'pmtiles',
  urlOrKey: 'naip/aoi.1a2b3c4d.pmtiles',
  version: '1a2b3c4d',
  cachePolicy: 'public',
  minzoom: 10,
  maxzoom: 18,
  attribution: 'USDA NAIP',
  legend: { items: [{ label: 'NAIP 2024', swatch: 'fill', color: '#888' }], note: '0.6 m' },
  sourceVintage: 'NAIP 2024',
  builtAt: '2027-01-10T15:00:00Z',
  defaultVisible: false,
  meta: { tileType: 'jpeg' },
};

describe('map layer rows', () => {
  test('a well-formed row validates', () => {
    expect(mapLayerRowSchema.parse(row)).toEqual(row);
  });

  test('keys, versions and zooms are checked like the database does', () => {
    expect(LAYER_KEY_RE.test('tile_lines')).toBe(true);
    expect(LAYER_KEY_RE.test('Tile-Lines')).toBe(false);
    expect(mapLayerRowSchema.safeParse({ ...row, key: 'Bad Key' }).success).toBe(false);
    expect(mapLayerRowSchema.safeParse({ ...row, version: 'a b' }).success).toBe(false);
    expect(mapLayerRowSchema.safeParse({ ...row, maxzoom: 30 }).success).toBe(false);
    expect(mapLayerRowSchema.safeParse({ ...row, kind: 'geojson' }).success).toBe(false);
  });

  test('legend ramps need two colours', () => {
    expect(
      legendSchema.safeParse({ items: [{ label: 'NCCPI', swatch: 'ramp', colors: ['#000'] }] })
        .success,
    ).toBe(false);
    expect(
      legendSchema.safeParse({
        items: [{ label: 'NCCPI', swatch: 'ramp', colors: ['#000', '#fff'] }],
      }).success,
    ).toBe(true);
  });
});
