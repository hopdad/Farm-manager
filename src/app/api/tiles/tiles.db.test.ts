/**
 * The tiles route's output against a real database (app.mvt_fields as farm_app): status codes,
 * headers, cache policy and the decoded MVT (layer `fields`, its properties, a polygon that lands
 * where the boundary is).
 */
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '@/test/db';
import { ADRIAN_QUARTER_SECTION, insertField, squareMultiPolygon, tileFor } from '@/test/fixtures';
import { lngLatToTilePixel } from '@/ui/map/tile-math';
import { decodeMvt } from '../../../../tools/gis/mvt';
import { handleTileRequest, MVT_CONTENT_TYPE } from './handler';
import { TILE_LAYERS, tileUrlTemplate } from './layers';

const t = setupTestDb(import.meta.url);

const ring = ADRIAN_QUARTER_SECTION.coordinates[0]?.[0] ?? [];
const [swLng, swLat] = ring[0] ?? [0, 0];
const inside = { lng: (swLng ?? 0) + 0.004, lat: (swLat ?? 0) + 0.003 };

function get(path: string, headers: Record<string, string> = {}) {
  const url = new URL(path, 'http://localhost');
  const [, , , layer = '', z = '', x = '', y = ''] = url.pathname.split('/');
  return handleTileRequest(new Request(url, { headers }), { layer, z, x, y }, t().pool);
}

describe('/api/tiles/fields', () => {
  test('a tile over a seeded field is an MVT with the field and its properties', async () => {
    const { fieldId, farmId } = await insertField(t().db, {
      geom: ADRIAN_QUARTER_SECTION,
      name: 'Kowalski North',
      tenure: 'cash_rent',
    });
    const tile = tileFor(inside.lng, inside.lat, 14);
    const res = await get(`/api/tiles/fields/${tile.z}/${tile.x}/${tile.y}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(MVT_CONTENT_TYPE);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Number(res.headers.get('content-length'))).toBe(body.length);

    const layers = decodeMvt(body);
    expect(layers.map((l) => l.name)).toEqual(['fields']);
    const layer = layers[0];
    if (!layer) throw new Error('no layer');
    expect(layer.extent).toBe(4096);
    const f = layer.features.find((x) => x.properties.id === fieldId);
    expect(f).toBeDefined();
    expect(f?.type).toBe('Polygon');
    expect(f?.properties).toMatchObject({
      id: fieldId,
      name: 'Kowalski North',
      tenure: 'cash_rent',
      farm_id: farmId,
    });
    expect(f?.properties.acres).toBeCloseTo(160, 0);
    // The polygon covers the point we picked inside the boundary.
    const [px, py] = lngLatToTilePixel(inside.lng, inside.lat, tile);
    const xs = f?.parts.flat().map((p) => p[0]) ?? [];
    const ys = f?.parts.flat().map((p) => p[1]) ?? [];
    expect(Math.min(...xs)).toBeLessThanOrEqual(px);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(px);
    expect(Math.min(...ys)).toBeLessThanOrEqual(py);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(py);
  });

  test('accepts .mvt / .pbf suffixes and versioned URLs get the immutable private policy', async () => {
    const tile = tileFor(inside.lng, inside.lat, 12);
    const plain = await get(`/api/tiles/fields/${tile.z}/${tile.x}/${tile.y}`);
    const mvt = await get(`/api/tiles/fields/${tile.z}/${tile.x}/${tile.y}.mvt?v=abc123`);
    const pbf = await get(`/api/tiles/fields/${tile.z}/${tile.x}/${tile.y}.pbf`);
    expect([plain.status, mvt.status, pbf.status]).toEqual([200, 200, 200]);
    expect(mvt.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(Buffer.from(await mvt.arrayBuffer())).toEqual(Buffer.from(await plain.arrayBuffer()));
  });

  test('If-None-Match with the ETag → 304', async () => {
    const tile = tileFor(inside.lng, inside.lat, 13);
    const first = await get(`/api/tiles/fields/${tile.z}/${tile.x}/${tile.y}`);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{20}"$/);
    const again = await get(`/api/tiles/fields/${tile.z}/${tile.x}/${tile.y}`, {
      'if-none-match': etag ?? '',
    });
    expect(again.status).toBe(304);
    expect(again.body).toBeNull();
  });

  test('an empty area is a 200 with an empty body', async () => {
    const tile = tileFor(-122.4, 37.8, 12);
    const res = await get(`/api/tiles/fields/${tile.z}/${tile.x}/${tile.y}`);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test('bad requests', async () => {
    expect((await get('/api/tiles/parcels/12/1/1')).status).toBe(404);
    expect((await get('/api/tiles/fields/12/4096/1')).status).toBe(400);
    expect((await get('/api/tiles/fields/23/0/0')).status).toBe(400);
    expect((await get('/api/tiles/fields/-1/0/0')).status).toBe(400);
    expect((await get('/api/tiles/fields/a/0/0')).status).toBe(400);
    expect((await get('/api/tiles/fields/1/0/0.png')).status).toBe(400);
    expect((await get('/api/tiles/fields/1/0/0?v=%3Cscript%3E')).status).toBe(400);
  });

  test('version() changes when a field or boundary changes', async () => {
    const { pool, db } = t();
    const v1 = await TILE_LAYERS.fields.version(pool);
    expect(v1).toMatch(/^[0-9a-f]{12}$/);
    expect(await TILE_LAYERS.fields.version(pool)).toBe(v1);
    const { fieldId } = await insertField(db, {
      geom: squareMultiPolygon(-83.9, 41.85, 400),
      name: 'Version probe',
    });
    const v2 = await TILE_LAYERS.fields.version(pool);
    expect(v2).not.toBe(v1);
    await pool.query("update farm.fields set name = 'Renamed', updated_at = now() where id = $1", [
      fieldId,
    ]);
    const v3 = await TILE_LAYERS.fields.version(pool);
    expect(v3).not.toBe(v2);
    await pool.query('update farm.fields set active = false where id = $1', [fieldId]);
    expect(await TILE_LAYERS.fields.version(pool)).toBe(v1);
  });

  test('tileUrlTemplate', () => {
    expect(tileUrlTemplate('fields', null)).toBe('/api/tiles/fields/{z}/{x}/{y}');
    expect(tileUrlTemplate('fields', 'abc')).toBe('/api/tiles/fields/{z}/{x}/{y}?v=abc');
  });

  test('a database error → 503 no-store', async () => {
    const broken = { query: async () => Promise.reject(new Error('down')) };
    const res = await handleTileRequest(
      new Request('http://localhost/api/tiles/fields/1/0/0'),
      { layer: 'fields', z: '1', x: '0', y: '0' },
      broken as never,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
