import type { FilterSpecification, LayerSpecification } from 'maplibre-gl';
import { describe, expect, test } from 'vitest';
import { DROP_HOVER_LAYER_IDS } from '../style';
import { hoverFilter, removeDropHover, showDropHover } from './hover';

function fakeMap(opts: { source?: boolean; labels?: boolean } = {}) {
  const layers = new Map<string, LayerSpecification>();
  const order: string[] = [];
  const filters = new Map<string, FilterSpecification | null>();
  const added: { id: string; before?: string }[] = [];
  return {
    layers,
    order,
    filters,
    added,
    getSource: (id: string) => (opts.source === false || id !== 'fields' ? undefined : { id }),
    getLayer: (id: string) =>
      layers.get(id) ?? (id === 'fields-label' && opts.labels !== false ? { id } : undefined),
    addLayer: (layer: LayerSpecification, before?: string) => {
      layers.set(layer.id, layer);
      order.push(layer.id);
      added.push({ id: layer.id, before });
    },
    removeLayer: (id: string) => {
      layers.delete(id);
      order.splice(order.indexOf(id), 1);
    },
    setFilter: (id: string, f: FilterSpecification | null) => {
      filters.set(id, f);
    },
  };
}

describe('the drag hover highlight', () => {
  test('two layers over the fields source, under the field names, then only filters', () => {
    const map = fakeMap();
    expect(showDropHover(map, null, true)).toBe(true);
    expect(map.added).toEqual([
      { id: DROP_HOVER_LAYER_IDS.fill, before: 'fields-label' },
      { id: DROP_HOVER_LAYER_IDS.line, before: 'fields-label' },
    ]);
    const fill = map.layers.get(DROP_HOVER_LAYER_IDS.fill) as LayerSpecification & {
      filter: unknown;
      source: string;
    };
    expect(fill.source).toBe('fields');
    // Null matches nothing.
    expect(fill.filter).toEqual(['==', ['get', 'id'], '']);
    showDropHover(map, 'field-1', true);
    expect(map.added).toHaveLength(2);
    expect(map.filters.get(DROP_HOVER_LAYER_IDS.line)).toEqual(hoverFilter('field-1'));
    removeDropHover(map);
    expect(map.order).toEqual([]);
    removeDropHover(map);
  });

  test('never the field panel’s layers; nothing before the fields source exists', () => {
    expect(Object.values(DROP_HOVER_LAYER_IDS).some((id) => id.startsWith('field-panel'))).toBe(
      false,
    );
    const map = fakeMap({ source: false });
    expect(showDropHover(map, 'x', false)).toBe(false);
    expect(map.added).toEqual([]);
    const noLabels = fakeMap({ labels: false });
    showDropHover(noLabels, 'x', false);
    expect(noLabels.added[0]?.before).toBeUndefined();
  });
});
