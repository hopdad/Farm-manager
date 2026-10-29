import { describe, expect, test } from 'vitest';
import { legendSchema } from '../../../domain/map-layers';
import { DRAINAGE_CLASSES } from '../../../domain/soils';
import { applyLayers, type MapLike, validateSpec } from './apply';
import { LAYER_DEFS } from './registry';
import {
  DRAINAGE_COLORS,
  DRAINAGE_UNKNOWN_COLOR,
  drainageColorExpression,
  SOILS_LEGEND,
  soilsLayer,
} from './soils';
import { row } from './test-fixtures';
import { resolveLayers } from './types';

const ctx = {
  origin: 'http://192.168.1.20:3000',
  flavor: 'dark' as const,
  variant: 'wall' as const,
};

describe('soils layer def', () => {
  test('is registered once, public, in the soils group, and needs its row', () => {
    expect(LAYER_DEFS.filter((d) => d.key === 'soils')).toEqual([soilsLayer]);
    expect(soilsLayer).toMatchObject({
      group: 'soils',
      cachePolicy: 'public',
      render: 'maplibre',
      requiresRow: true,
      anchor: 'below-fields',
      offline: true,
    });
  });

  test('spec: one vector source on the row URL (absolute, ?v= kept), fill + outline, valid ids', () => {
    const r = row('soils', {
      url: '/api/tiles/soils/{z}/{x}/{y}?v=fixture-abc',
      attribution: 'Soils: USDA NRCS SSURGO',
    });
    const spec = soilsLayer.spec({ ...ctx, row: r });
    validateSpec('soils', spec);
    expect(spec.sources).toEqual({
      'layer:soils': {
        type: 'vector',
        tiles: ['http://192.168.1.20:3000/api/tiles/soils/{z}/{x}/{y}?v=fixture-abc'],
        minzoom: 10,
        maxzoom: 16,
        attribution: 'Soils: USDA NRCS SSURGO',
      },
    });
    expect(spec.layers.map((l) => [l.id, l.type])).toEqual([
      ['layer:soils:fill', 'fill'],
      ['layer:soils:outline', 'line'],
    ]);
    expect(spec.layers.every((l) => 'source-layer' in l && l['source-layer'] === 'soils')).toBe(
      true,
    );
  });

  test('without a row it draws nothing (the rail shows the build hint instead)', () => {
    expect(soilsLayer.spec({ ...ctx, row: null })).toEqual({ sources: {}, layers: [] });
    const [r] = resolveLayers([soilsLayer], []);
    expect(r?.status).toBe('missing');
    expect(soilsLayer.buildHint).toMatch(/pnpm gis:soils/);
  });

  test('colour by drainage class: every class has its own colour, unknown is grey', () => {
    const expr = drainageColorExpression() as unknown[];
    expect(expr[0]).toBe('match');
    for (const c of DRAINAGE_CLASSES) {
      const i = expr.indexOf(c);
      expect(i, c).toBeGreaterThan(1);
      expect(expr[i + 1]).toBe(DRAINAGE_COLORS[c]);
    }
    expect(expr[expr.length - 1]).toBe(DRAINAGE_UNKNOWN_COLOR);
    expect(new Set(Object.values(DRAINAGE_COLORS)).size).toBe(DRAINAGE_CLASSES.length);
  });

  test('legend lists every class in order and passes the registry schema', () => {
    expect(legendSchema.parse(SOILS_LEGEND)).toEqual(SOILS_LEGEND);
    expect(SOILS_LEGEND.items.slice(0, DRAINAGE_CLASSES.length).map((i) => i.label)).toEqual([
      ...DRAINAGE_CLASSES,
    ]);
  });

  test('applyLayers puts it under the field fill and re-adds it on a new version', () => {
    const layers: { id: string; type: string; layout: Record<string, unknown> }[] = [
      { id: 'fields-fill', type: 'fill', layout: {} },
      { id: 'places', type: 'symbol', layout: {} },
    ];
    const sources: Record<string, unknown> = {};
    const calls: string[] = [];
    const map: MapLike = {
      getStyle: () => ({ layers, sources }),
      getSource: (id) => sources[id],
      addSource: (id, s) => {
        sources[id] = s;
        calls.push(`+src ${id}`);
      },
      removeSource: (id) => {
        delete sources[id];
        calls.push(`-src ${id}`);
      },
      getLayer: (id) => layers.find((l) => l.id === id),
      addLayer: (l, before) => {
        const i = before ? layers.findIndex((x) => x.id === before) : layers.length;
        layers.splice(i, 0, { id: l.id, type: l.type, layout: { ...(l.layout ?? {}) } });
        calls.push(`+${l.id}`);
      },
      removeLayer: (id) => {
        layers.splice(
          layers.findIndex((l) => l.id === id),
          1,
        );
        calls.push(`-${id}`);
      },
      setLayoutProperty: (id, name, value) => {
        const l = layers.find((x) => x.id === id);
        if (l) l.layout[name] = value;
      },
    };
    const visible = () => true;
    applyLayers(
      map,
      resolveLayers([soilsLayer], [row('soils', { version: 'a', url: '/t?v=a' })]),
      visible,
      ctx,
    );
    expect(layers.map((l) => l.id)).toEqual([
      'layer:soils:fill',
      'layer:soils:outline',
      'fields-fill',
      'places',
    ]);
    calls.length = 0;
    applyLayers(
      map,
      resolveLayers([soilsLayer], [row('soils', { version: 'a', url: '/t?v=a' })]),
      visible,
      ctx,
    );
    expect(calls).toEqual([]);
    applyLayers(
      map,
      resolveLayers([soilsLayer], [row('soils', { version: 'b', url: '/t?v=b' })]),
      visible,
      ctx,
    );
    expect(calls).toContain('+src layer:soils');
    expect((sources['layer:soils'] as { tiles: string[] }).tiles[0]).toMatch(/v=b$/);
  });
});
