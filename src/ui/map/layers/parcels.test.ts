/**
 * The imagery builder's layer defs (parcels, tile lines, NAIP online + AOI): ids follow the
 * contract (validateSpec), the specs are valid MapLibre style (the runtime validator), the rows
 * they need resolve (status, cache policy), and applyLayers adds and re-adds them on a fake map.
 */
import { describe, expect, test } from 'vitest';
import { applyLayers, type MapLike, validateSpec } from './apply';
import { naipAoiLayer, naipLayer } from './naip';
import { PARCELS_SOURCE_LAYER, parcelsLayer } from './parcels';
import { LAYER_DEFS } from './registry';
import { row } from './test-fixtures';
import { TILE_SOURCE_LAYER, tileLayer } from './tile';
import { styleErrors } from './tile-style-validate';
import { type MapLibreLayerDef, resolveLayers } from './types';

const ORIGIN = 'http://localhost:3107';
const ctx = (
  r: ReturnType<typeof row> | null,
  flavor: 'light' | 'dark' = 'dark',
  variant: 'wall' | 'phone' = 'wall',
) => ({
  origin: ORIGIN,
  row: r,
  flavor,
  variant,
});

const parcelsRow = row('parcels', {
  cachePolicy: 'private',
  minzoom: 12,
  url: '/api/tiles/parcels/{z}/{x}/{y}?v=abc',
});
const tileRow = row('tile_lines', {
  cachePolicy: 'private',
  minzoom: 12,
  url: '/api/tiles/tile_lines/{z}/{x}/{y}?v=def',
});
const naipTemplate =
  'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=jpg&f=image';
const naipRow = row('naip', {
  kind: 'xyz',
  urlOrKey: naipTemplate,
  url: naipTemplate,
  minzoom: 11,
  maxzoom: 19,
  version: null,
});
const aoiRow = row('naip_aoi', {
  kind: 'pmtiles',
  urlOrKey: 'naip/aoi.1a2b3c4d.pmtiles',
  url: '/api/storage/tiles/naip/aoi.1a2b3c4d.pmtiles',
  version: '1a2b3c4d',
  minzoom: 12,
  maxzoom: 17,
  meta: { bounds: [-84.1, 41.8, -83.6, 42] },
});

const cases: [MapLibreLayerDef, ReturnType<typeof row>][] = [
  [parcelsLayer, parcelsRow],
  [tileLayer, tileRow],
  [naipLayer, naipRow],
  [naipAoiLayer, aoiRow],
];

describe.each(cases)('%s', (def, r) => {
  test('ids follow the contract and MapLibre accepts the spec (both flavours, both variants)', () => {
    for (const flavor of ['light', 'dark'] as const) {
      for (const variant of ['wall', 'phone'] as const) {
        const spec = def.spec(ctx(r, flavor, variant));
        expect(() => validateSpec(def.key, spec)).not.toThrow();
        expect(styleErrors(spec)).toEqual([]);
        expect(spec.layers.length).toBeGreaterThan(0);
      }
    }
  });

  test('no row: nothing to draw, and the rail shows the build hint', () => {
    expect(def.spec(ctx(null))).toEqual({ sources: {}, layers: [] });
    const [resolved] = resolveLayers([def], []);
    expect(resolved?.status).toBe('missing');
    expect(def.buildHint).toMatch(/pnpm|Tile tool/);
  });

  test('a row with another cache policy is never drawn', () => {
    const other = { ...r, cachePolicy: r.cachePolicy === 'public' ? 'private' : 'public' } as const;
    expect(resolveLayers([def], [other])[0]?.status).toBe('mismatch');
    expect(resolveLayers([def], [r])[0]?.status).toBe('ready');
  });
});

describe('specifics', () => {
  test('parcels and tile lines read their private MVT layers with absolute, versioned URLs', () => {
    const p = parcelsLayer.spec(ctx(parcelsRow));
    expect(p.sources['layer:parcels']).toMatchObject({
      type: 'vector',
      tiles: [`${ORIGIN}/api/tiles/parcels/{z}/{x}/{y}?v=abc`],
      promoteId: 'id',
    });
    expect(
      p.layers.every((l) => !('source-layer' in l) || l['source-layer'] === PARCELS_SOURCE_LAYER),
    ).toBe(true);
    // The label falls back to the parcel number when the tiles carry no owner (non-managers).
    expect(JSON.stringify(p.layers.find((l) => l.id === 'layer:parcels:label'))).toContain(
      '"coalesce",["get","owner_name"],["get","parcel_no"]',
    );
    const t = tileLayer.spec(ctx(tileRow));
    expect(t.sources['layer:tile_lines']).toMatchObject({
      tiles: [`${ORIGIN}/api/tiles/tile_lines/{z}/{x}/{y}?v=def`],
    });
    expect(t.layers.map((l) => l.id)).toEqual([
      'layer:tile_lines:casing',
      'layer:tile_lines:line',
      'layer:tile_lines:label',
    ]);
    expect(
      t.layers.every((l) => !('source-layer' in l) || l['source-layer'] === TILE_SOURCE_LAYER),
    ).toBe(true);
  });

  test('NAIP: online-only raster from the image service; AOI from the tiles bucket over pmtiles://', () => {
    expect(naipLayer).toMatchObject({ kind: 'online', offline: false, cachePolicy: 'public' });
    const online = naipLayer.spec(ctx(naipRow));
    expect(online.sources['layer:naip']).toMatchObject({
      type: 'raster',
      tileSize: 256,
      tiles: [naipTemplate],
    });
    expect(naipAoiLayer).toMatchObject({ kind: 'raster', offline: true, cachePolicy: 'public' });
    const aoi = naipAoiLayer.spec(ctx(aoiRow));
    expect(aoi.sources['layer:naip_aoi']).toMatchObject({
      type: 'raster',
      url: `pmtiles://${ORIGIN}/api/storage/tiles/naip/aoi.1a2b3c4d.pmtiles`,
      bounds: [-84.1, 41.8, -83.6, 42],
    });
  });

  test('registered once each, in their rail groups', () => {
    const keys = LAYER_DEFS.map((d) => d.key);
    for (const k of ['parcels', 'tile_lines', 'naip', 'naip_aoi'])
      expect(keys.filter((x) => x === k)).toHaveLength(1);
    const resolved = resolveLayers(LAYER_DEFS, [parcelsRow, tileRow, naipRow, aoiRow]);
    expect(
      resolved
        .filter((r) => ['parcels', 'tile_lines', 'naip', 'naip_aoi'].includes(r.def.key))
        .map((r) => [r.def.key, r.def.group]),
    ).toEqual([
      ['naip_aoi', 'imagery'],
      ['naip', 'imagery'],
      ['tile_lines', 'tile'],
      ['parcels', 'parcels'],
    ]);
  });
});

/** A fake map like apply.test.ts's: records sources and layers. */
function fakeMap(): MapLike & {
  layers: { id: string; type: string; layout?: Record<string, unknown> }[];
  sources: Map<string, unknown>;
} {
  const layers: { id: string; type: string; layout?: Record<string, unknown> }[] = [
    { id: 'fields-fill', type: 'fill' },
    { id: 'place-labels', type: 'symbol' },
  ];
  const sources = new Map<string, unknown>([['fields', {}]]);
  return {
    layers,
    sources,
    getStyle: () => ({ layers, sources: Object.fromEntries(sources) }),
    getSource: (id) => sources.get(id),
    addSource: (id, s) => sources.set(id, s),
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => layers.find((l) => l.id === id),
    addLayer: (l, before) => {
      const i = before ? layers.findIndex((x) => x.id === before) : -1;
      const entry = {
        id: l.id,
        type: l.type,
        layout: (l as { layout?: Record<string, unknown> }).layout,
      };
      if (i >= 0) layers.splice(i, 0, entry);
      else layers.push(entry);
    },
    removeLayer: (id) => {
      const i = layers.findIndex((l) => l.id === id);
      if (i >= 0) layers.splice(i, 1);
    },
    setLayoutProperty: (id, name, value) => {
      const l = layers.find((x) => x.id === id);
      if (l) l.layout = { ...(l.layout ?? {}), [name]: value };
    },
  };
}

test('applyLayers: parcels and tile lines go below the labels, NAIP below the fields; a new version re-adds', () => {
  const map = fakeMap();
  const visible = () => true;
  const c = { origin: ORIGIN, flavor: 'dark' as const, variant: 'wall' as const };
  applyLayers(
    map,
    resolveLayers([parcelsLayer, tileLayer, naipAoiLayer], [parcelsRow, tileRow, aoiRow]),
    visible,
    c,
  );
  const ids = map.layers.map((l) => l.id);
  expect(ids.indexOf('layer:naip_aoi:raster')).toBeLessThan(ids.indexOf('fields-fill'));
  expect(ids.indexOf('layer:parcels:line')).toBeLessThan(ids.indexOf('place-labels'));
  expect(ids.indexOf('layer:tile_lines:line')).toBeLessThan(ids.indexOf('place-labels'));
  const newer = { ...tileRow, version: 'v2', url: '/api/tiles/tile_lines/{z}/{x}/{y}?v=v2' };
  const r = applyLayers(
    map,
    resolveLayers([parcelsLayer, tileLayer, naipAoiLayer], [parcelsRow, newer, aoiRow]),
    visible,
    c,
  );
  expect(r.added).toEqual([
    'layer:tile_lines:casing',
    'layer:tile_lines:line',
    'layer:tile_lines:label',
  ]);
});

test('the validator really validates (a zoom expression MapLibre refuses is reported)', () => {
  const bad = {
    sources: { 'layer:x': { type: 'vector' as const, tiles: ['http://x/{z}/{x}/{y}'] } },
    layers: [
      {
        id: 'layer:x:line',
        type: 'line' as const,
        source: 'layer:x',
        'source-layer': 'x',
        paint: {
          'line-width': [
            '+',
            ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 4],
            2,
          ] as unknown as number,
        },
      },
    ],
  };
  expect(styleErrors(bad).join(' ')).toMatch(/zoom/);
});
