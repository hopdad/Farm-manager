/** applyLayers against a fake map that records the style like MapLibre does. */
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import { describe, expect, test } from 'vitest';
import { FIELD_LAYER_IDS } from '../style';
import { type ApplyContext, applyLayers, type MapLike, validateSpec } from './apply';
import { customersLayer, fieldsLayer, fleetLayer } from './builtin';
import { row, soilsDef } from './test-fixtures';
import { resolveLayers } from './types';

class FakeMap implements MapLike {
  layers: { id: string; type: string; layout: Record<string, unknown> }[] = [];
  sources: Record<string, SourceSpecification> = {};
  calls: string[] = [];
  constructor() {
    this.replaceStyle();
  }
  /** What a basemap flavour switch does: back to the base style only. */
  replaceStyle() {
    this.sources = { protomaps: { type: 'vector' }, fields: { type: 'vector' } };
    this.layers = [
      { id: 'water', type: 'fill', layout: {} },
      { id: FIELD_LAYER_IDS.fill, type: 'fill', layout: {} },
      { id: FIELD_LAYER_IDS.outline, type: 'line', layout: {} },
      { id: 'places', type: 'symbol', layout: {} },
      { id: FIELD_LAYER_IDS.label, type: 'symbol', layout: {} },
    ];
  }
  getStyle() {
    return { layers: this.layers, sources: this.sources };
  }
  getSource(id: string) {
    return this.sources[id];
  }
  addSource(id: string, source: SourceSpecification) {
    if (this.sources[id]) throw new Error(`source ${id} exists`);
    this.sources[id] = source;
    this.calls.push(`addSource ${id}`);
  }
  removeSource(id: string) {
    delete this.sources[id];
    this.calls.push(`removeSource ${id}`);
  }
  getLayer(id: string) {
    return this.layers.find((l) => l.id === id);
  }
  addLayer(layer: LayerSpecification, beforeId?: string) {
    if (this.getLayer(layer.id)) throw new Error(`layer ${layer.id} exists`);
    const entry = { id: layer.id, type: layer.type, layout: { ...(layer.layout ?? {}) } };
    const i = beforeId ? this.layers.findIndex((l) => l.id === beforeId) : -1;
    if (i === -1) this.layers.push(entry);
    else this.layers.splice(i, 0, entry);
    this.calls.push(`addLayer ${layer.id}${beforeId ? ` before ${beforeId}` : ''}`);
  }
  removeLayer(id: string) {
    this.layers = this.layers.filter((l) => l.id !== id);
    this.calls.push(`removeLayer ${id}`);
  }
  setLayoutProperty(id: string, name: string, value: unknown) {
    const l = this.getLayer(id);
    if (!l) throw new Error(`no layer ${id}`);
    l.layout[name] = value;
  }
  visibility(id: string) {
    return this.getLayer(id)?.layout.visibility;
  }
}

const ctx: ApplyContext = { origin: 'http://localhost:3000', flavor: 'dark', variant: 'wall' };
const defs = [fieldsLayer, fleetLayer, soilsDef, customersLayer];

describe('applyLayers', () => {
  test('adds ready MapLibre layers at their anchor, hidden or shown per visibility', () => {
    const map = new FakeMap();
    const resolved = resolveLayers(defs, [row('soils')]);
    const visible = new Set(['soils']);
    const r = applyLayers(map, resolved, (k, d) => visible.has(k) || d, ctx);
    expect(r.added).toEqual([
      'layer:soils:line',
      'layer:customers:outline',
      'layer:customers:label',
    ]);
    // below-fields: right under the fields fill; customers on top.
    expect(map.layers.map((l) => l.id).indexOf('layer:soils:line')).toBe(
      map.layers.map((l) => l.id).indexOf(FIELD_LAYER_IDS.fill) - 1,
    );
    expect(map.layers.at(-1)?.id).toBe('layer:customers:label');
    expect(map.visibility('layer:soils:line')).toBe('visible');
    expect(map.visibility('layer:customers:outline')).toBe('none');
    expect(map.visibility(FIELD_LAYER_IDS.fill)).toBe('visible');
    expect(map.sources['layer:soils']).toMatchObject({
      tiles: ['http://localhost:3000/api/tiles/soils/{z}/{x}/{y}?v=v1'],
    });
  });

  test('is idempotent; a visibility change only flips layout', () => {
    const map = new FakeMap();
    const resolved = resolveLayers(defs, [row('soils')]);
    applyLayers(map, resolved, () => true, ctx);
    map.calls = [];
    const again = applyLayers(map, resolved, () => true, ctx);
    expect(again).toEqual({ added: [], removed: [] });
    expect(map.calls).toEqual([]);
    applyLayers(map, resolved, (k) => k !== 'fields', ctx);
    expect(map.calls).toEqual([]);
    expect(map.visibility(FIELD_LAYER_IDS.fill)).toBe('none');
    expect(map.visibility(FIELD_LAYER_IDS.label)).toBe('none');
  });

  test('a new version re-adds the layer; a lost row removes it', () => {
    const map = new FakeMap();
    applyLayers(map, resolveLayers(defs, [row('soils')]), () => true, ctx);
    const next = row('soils', { version: 'v2', url: '/api/tiles/soils/{z}/{x}/{y}?v=v2' });
    const r = applyLayers(map, resolveLayers(defs, [next]), () => true, ctx);
    expect(r.removed).toContain('layer:soils');
    expect(r.added).toEqual(['layer:soils:line']);
    expect(map.sources['layer:soils']).toMatchObject({
      tiles: ['http://localhost:3000/api/tiles/soils/{z}/{x}/{y}?v=v2'],
    });
    const gone = applyLayers(map, resolveLayers(defs, []), () => true, ctx);
    expect(gone.removed).toEqual(['layer:soils:line', 'layer:soils']);
    expect(map.getSource('layer:soils')).toBeUndefined();
  });

  test('puts layers back after the style was replaced (flavour switch)', () => {
    const map = new FakeMap();
    const resolved = resolveLayers(defs, [row('soils')]);
    applyLayers(map, resolved, () => true, ctx);
    map.replaceStyle();
    const r = applyLayers(map, resolved, () => true, ctx);
    expect(r.added).toContain('layer:soils:line');
    expect(map.getLayer('layer:customers:outline')).toBeDefined();
  });

  test('removes leftover layer: entries nobody owns', () => {
    const map = new FakeMap();
    map.addSource('layer:old', { type: 'vector' });
    map.addLayer({ id: 'layer:old:fill', type: 'fill', source: 'layer:old' } as LayerSpecification);
    const r = applyLayers(map, resolveLayers([fieldsLayer], []), () => true, ctx);
    expect(r.removed).toEqual(['layer:old:fill', 'layer:old']);
  });

  test('validateSpec enforces the id rules', () => {
    expect(() =>
      validateSpec('soils', { sources: { soils: { type: 'vector' } }, layers: [] }),
    ).toThrow(/source id/);
    expect(() =>
      validateSpec('soils', {
        sources: {},
        layers: [{ id: 'soils-fill', type: 'fill', source: 'x' } as LayerSpecification],
      }),
    ).toThrow(/layer id/);
  });
});
