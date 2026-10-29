import { describe, expect, test } from 'vitest';
import { customersLayer, fieldsLayer, fleetLayer } from '../layers/builtin';
import { soilsLayer } from '../layers/soils';
import { row } from '../layers/test-fixtures';
import { LAYER_GROUPS, type MapLibreLayerDef, resolveLayers } from '../layers/types';
import { GROUP_HINTS, layerKeyOfSource, type RailModelInput, railModel } from './model';

const naipDef: MapLibreLayerDef = {
  key: 'naip',
  render: 'maplibre',
  group: 'imagery',
  label: 'Aerial photos (online)',
  legend: null,
  kind: 'online',
  offline: false,
  cachePolicy: 'public',
  defaultVisible: false,
  order: 10,
  requiresRow: true,
  buildHint: 'Run pnpm gis:naip',
  anchor: 'below-fields',
  minzoom: 0,
  maxzoom: 22,
  spec: () => ({ sources: {}, layers: [] }),
};

const DEFS = [fieldsLayer, soilsLayer, naipDef, fleetLayer, customersLayer];

function model(
  over: Partial<RailModelInput> = {},
  rows = [row('soils', { sourceVintage: 'SSURGO MI091 2025-09-05' }), row('naip', { kind: 'xyz' })],
) {
  return railModel({
    resolved: resolveLayers(DEFS, rows),
    overrides: {},
    loaded: true,
    online: true,
    failing: new Set(),
    zoom: 12,
    ...over,
  });
}

const item = (groups: ReturnType<typeof model>, key: string) => {
  const found = groups.flatMap((g) => g.items).find((i) => i.key === key);
  if (!found) throw new Error(`no item ${key}`);
  return found;
};

describe('railModel', () => {
  test('every group in rail order; empty groups say what will fill them', () => {
    const groups = model();
    expect(groups.map((g) => g.group)).toEqual([...LAYER_GROUPS]);
    expect(groups.map((g) => g.label)).toEqual([
      'Fields',
      'Soils',
      'Elevation and drainage',
      'Imagery',
      'Tile maps',
      'Parcels',
      'Live fleet',
      'Custom-work customers',
    ]);
    const terrain = groups.find((g) => g.group === 'terrain');
    expect(terrain?.items).toEqual([]);
    expect(terrain?.hint).toBe(GROUP_HINTS.terrain);
    expect(groups.find((g) => g.group === 'soils')?.hint).toBeNull();
  });

  test('defaults and overrides decide on/off', () => {
    expect(item(model(), 'fields').on).toBe(true);
    expect(item(model(), 'soils').on).toBe(false);
    const g = model({ overrides: { soils: true, fields: false } });
    expect(item(g, 'soils').on).toBe(true);
    expect(item(g, 'fields').on).toBe(false);
  });

  test('a built layer is "loading" until the registry answers, then "missing" without its row', () => {
    expect(item(model({ loaded: false }, []), 'soils')).toMatchObject({
      status: 'loading',
      toggleable: false,
    });
    expect(item(model({}, []), 'soils')).toMatchObject({
      status: 'missing',
      toggleable: false,
      message: soilsLayer.buildHint,
    });
    // Built-ins that need no row are ready at once.
    expect(item(model({ loaded: false }, []), 'customers').status).toBe('ready');
  });

  test('a cache-policy mismatch is never toggleable', () => {
    const g = model({}, [row('soils', { cachePolicy: 'private' })]);
    expect(item(g, 'soils')).toMatchObject({ status: 'mismatch', toggleable: false });
    expect(item(g, 'soils').message).toMatch(/private/);
  });

  test('online-only layers say offline (browser offline, or their tiles failing), local ones never', () => {
    expect(item(model({ online: false }), 'naip')).toMatchObject({
      status: 'offline',
      toggleable: true,
    });
    expect(item(model({ failing: new Set(['naip']) }), 'naip').status).toBe('offline');
    expect(item(model({ online: false }), 'soils').status).toBe('ready');
    expect(item(model({ online: false }), 'fields').status).toBe('ready');
  });

  test('zoom hint when on but zoomed out past the layer; legend and source only while on', () => {
    const off = item(model({ zoom: 8 }), 'soils');
    expect(off).toMatchObject({ zoomHint: null, legend: null });
    const on = item(model({ zoom: 8, overrides: { soils: true } }), 'soils');
    expect(on.zoomHint).toBe('Zoom in to see it (from zoom 10)');
    expect(on.legend).toBe(soilsLayer.legend);
    expect(on.source).toBe('SSURGO MI091 2025-09-05');
    expect(item(model({ zoom: 10, overrides: { soils: true } }), 'soils').zoomHint).toBeNull();
  });

  test('the synthetic fixture is flagged', () => {
    const g = model({ overrides: { soils: true } }, [row('soils', { meta: { fixture: true } })]);
    expect(item(g, 'soils')).toMatchObject({
      synthetic: true,
      source: 'Synthetic test fixture, not survey data',
    });
  });
});

describe('layerKeyOfSource', () => {
  test('maps layer source ids to keys; anything else is null', () => {
    expect(layerKeyOfSource('layer:soils')).toBe('soils');
    expect(layerKeyOfSource('layer:naip_aoi:raster')).toBe('naip_aoi');
    expect(layerKeyOfSource('fields')).toBeNull();
    expect(layerKeyOfSource(undefined)).toBeNull();
    expect(layerKeyOfSource('layer:Bad')).toBeNull();
  });
});
