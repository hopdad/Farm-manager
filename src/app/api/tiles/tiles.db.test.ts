/**
 * The tiles route's output against a real database (app.mvt_fields as farm_app): status codes,
 * headers, cache policy and the decoded MVT (layer `fields`, its properties, a polygon that lands
 * where the boundary is).
 */
import { describe, expect, test } from 'vitest';
import { AuthError } from '@/platform/auth/types';
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
    expect((await get('/api/tiles/pins/12/1/1')).status).toBe(404);
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

describe('M1 layers (0003)', () => {
  test('every tile layer has a gis.map_layers row with the same policy and zooms', async () => {
    const r = await t().pool.query<{
      key: string;
      kind: string;
      url_or_key: string;
      cache_policy: string;
      minzoom: number;
      maxzoom: number;
    }>(`select key, kind, url_or_key, cache_policy, minzoom, maxzoom from gis.map_layers
         where kind = 'mvt' order by key`);
    const rows = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    for (const [key, def] of Object.entries(TILE_LAYERS)) {
      expect(rows[key], key).toEqual({
        key,
        kind: 'mvt',
        url_or_key: `/api/tiles/${key}`,
        cache_policy: def.cachePolicy,
        minzoom: def.minzoom,
        maxzoom: def.maxzoom,
      });
    }
    expect(Object.keys(rows).sort()).toEqual(Object.keys(TILE_LAYERS).sort());
  });

  test('private layers run the access check; an AuthError becomes 401/403 no-store', async () => {
    const tile = tileFor(inside.lng, inside.lat, 14);
    const params = (layer: string) => ({ layer, z: '14', x: String(tile.x), y: String(tile.y) });
    const req = (layer: string) =>
      new Request(`http://localhost/api/tiles/${layer}/14/${tile.x}/${tile.y}`);
    let calls = 0;
    const deny401 = async () => {
      calls++;
      throw new AuthError(401);
    };
    for (const layer of ['fields', 'parcels', 'tile_lines']) {
      const res = await handleTileRequest(req(layer), params(layer), t().pool, {
        checkAccess: deny401,
      });
      expect(res.status, layer).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(calls).toBe(3);
    // Public soils never asks.
    const soils = await handleTileRequest(req('soils'), params('soils'), t().pool, {
      checkAccess: deny401,
    });
    expect(soils.status).toBe(200);
    expect(soils.headers.get('cache-control')).toBe('public, no-cache');
    expect(calls).toBe(3);
    const forbidden = await handleTileRequest(req('parcels'), params('parcels'), t().pool, {
      checkAccess: async () => {
        throw new AuthError(403, undefined, 'viewer');
      },
    });
    expect(forbidden.status).toBe(403);
    const allowed = await handleTileRequest(req('parcels'), params('parcels'), t().pool, {
      checkAccess: async () => ({ role: 'viewer' }),
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('private, no-cache');
  });

  test('versioned public tiles get the year-long CDN policy', async () => {
    const tile = tileFor(inside.lng, inside.lat, 12);
    const res = await get(`/api/tiles/soils/${tile.z}/${tile.x}/${tile.y}?v=abc`);
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=31536000, s-maxage=31536000, immutable',
    );
  });

  test('versions of the table-backed layers move with their data', async () => {
    const { pool, admin } = t();
    const v = async () => ({
      soils: await TILE_LAYERS.soils.version(pool),
      parcels: await TILE_LAYERS.parcels.version(pool),
      tileLines: await TILE_LAYERS.tile_lines.version(pool),
    });
    const before = await v();
    for (const x of Object.values(before)) expect(x).toMatch(/^[0-9a-f]{12}$/);
    await admin.query(`update gis.map_layers set version = 'ssurgo-2026a' where key = 'soils'`);
    const { fieldId } = await insertField(t().db);
    await pool.query(
      `insert into farm.tile_lines (field_id, geom, origin) values ($1,
         extensions.ST_Multi(extensions.ST_GeomFromText('LINESTRING(-84.05 41.9, -84.04 41.9)', 4326)),
         'manual')`,
      [fieldId],
    );
    const after = await v();
    expect(after.soils).toBe('ssurgo-2026a');
    expect(after.tileLines).not.toBe(before.tileLines);
    expect(after.parcels).toBe(before.parcels);
  });

  test('fields tiles carry the custom-work client (client_id, client)', async () => {
    const { pool, db } = t();
    const { fieldId, farmId } = await insertField(db, {
      geom: squareMultiPolygon(inside.lng - 0.002, inside.lat - 0.002, 120),
      name: 'Custom 40',
      tenure: 'custom',
    });
    const party = await pool.query<{ id: string }>(
      `insert into farm.parties (kind, display_name, roles) values ('org', 'Hoffman Farms', '{customer}')
       returning id`,
    );
    const v1 = await TILE_LAYERS.fields.version(pool);
    await pool.query('update farm.farms set client_party_id = $1 where id = $2', [
      party.rows[0]?.id,
      farmId,
    ]);
    expect(await TILE_LAYERS.fields.version(pool)).not.toBe(v1);
    const tile = tileFor(inside.lng, inside.lat, 14);
    const res = await get(`/api/tiles/fields/${tile.z}/${tile.x}/${tile.y}`);
    const f = decodeMvt(new Uint8Array(await res.arrayBuffer()))[0]?.features.find(
      (x) => x.properties.id === fieldId,
    );
    expect(f?.properties).toMatchObject({ client_id: party.rows[0]?.id, client: 'Hoffman Farms' });
  });
});
