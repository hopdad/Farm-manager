/**
 * GET /api/layers' logic on a real database: the registry rows migration 0003 inserts, URLs
 * resolved per kind, the private filter, and agreement with the code's LayerDefs.
 */
import { describe, expect, test } from 'vitest';
import { makeSession } from '@/platform/auth/testing';
import { setupTestDb } from '@/test/db';
import { LAYER_DEFS } from '@/ui/map/layers/registry';
import { resolveLayers } from '@/ui/map/layers/types';
import { TILE_LAYERS } from '../tiles/layers';
import { listMapLayers, mayViewPrivate, readMapLayerRows } from './rows';

const t = setupTestDb(import.meta.url);
const storage = { publicUrl: (bucket: string, key: string) => `/api/storage/${bucket}/${key}` };

describe('listMapLayers', () => {
  test('every 0003 row, sorted, mvt URLs carrying the tiles route version', async () => {
    const { layers } = await listMapLayers(t().pool, storage, { includePrivate: true });
    expect(layers.map((l) => l.key)).toEqual(['fields', 'parcels', 'soils', 'tile_lines']);
    for (const l of layers) {
      const v = await TILE_LAYERS[l.key as keyof typeof TILE_LAYERS].version(t().pool);
      expect(l.version).toBe(v);
      expect(l.url).toBe(`/api/tiles/${l.key}/{z}/{x}/{y}?v=${v}`);
    }
    const soils = layers.find((l) => l.key === 'soils');
    expect(soils).toMatchObject({
      cachePolicy: 'public',
      minzoom: 10,
      maxzoom: 16,
      defaultVisible: false,
    });
  });

  test('private rows only for a session that may see them', async () => {
    const pub = await listMapLayers(t().pool, storage, { includePrivate: false });
    expect(pub.layers.map((l) => l.key)).toEqual(['soils']);
    expect(mayViewPrivate(null)).toBe(false);
    expect(mayViewPrivate(makeSession({ role: 'viewer' }))).toBe(true);
  });

  test('pmtiles rows resolve through storage; xyz rows stay as stored', async () => {
    await t().admin.query(
      `insert into gis.map_layers (key, kind, url_or_key, version, cache_policy, minzoom, maxzoom, meta)
       values ('naip_aoi', 'pmtiles', 'naip/aoi.1a2b3c4d.pmtiles', '1a2b3c4d', 'public', 10, 17, '{"tileType":"jpg"}'),
              ('naip', 'xyz', 'https://example.invalid/tiles/{z}/{y}/{x}', null, 'public', 0, 16, '{}')`,
    );
    try {
      const { layers } = await listMapLayers(t().pool, storage, { includePrivate: true });
      expect(layers.find((l) => l.key === 'naip_aoi')).toMatchObject({
        url: '/api/storage/tiles/naip/aoi.1a2b3c4d.pmtiles',
        version: '1a2b3c4d',
        meta: { tileType: 'jpg' },
      });
      expect(layers.find((l) => l.key === 'naip')?.url).toBe(
        'https://example.invalid/tiles/{z}/{y}/{x}',
      );
    } finally {
      await t().admin.query(`delete from gis.map_layers where key in ('naip_aoi', 'naip')`);
    }
  });

  test('a bad legend falls back to none; the row stays', async () => {
    await t().admin.query(
      `update gis.map_layers set legend = '{"items": [{"label": ""}]}'::jsonb where key = 'parcels'`,
    );
    try {
      const rows = await readMapLayerRows(t().pool);
      expect(rows.find((r) => r.key === 'parcels')?.legend).toBeNull();
    } finally {
      await t().admin.query(`update gis.map_layers set legend = null where key = 'parcels'`);
    }
  });

  test('the code’s layer defs agree with the registry (no cache-policy mismatch)', async () => {
    const { layers } = await listMapLayers(t().pool, storage, { includePrivate: true });
    const resolved = resolveLayers(LAYER_DEFS, layers);
    expect(resolved.filter((r) => r.status === 'mismatch')).toEqual([]);
    expect(resolved.find((r) => r.def.key === 'soils')?.status).toBe('ready');
  });
});
