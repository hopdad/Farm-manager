import type { FilterSpecification, LayerSpecification } from 'maplibre-gl';
import { describe, expect, test } from 'vitest';
import { FIELD_LAYER_IDS, FIELDS_SOURCE } from '../map/style';
import {
  applyHighlight,
  HIGHLIGHT_LAYER_IDS,
  type HighlightMap,
  highlightFilter,
  needsReveal,
  panelPadding,
  removeHighlight,
  tilePreview,
} from './highlight';

/** A fake map: an ordered layer list and the sources that exist. */
function fakeMap(opts: { sources?: string[]; layers?: string[] } = {}) {
  const sources = new Set(opts.sources ?? [FIELDS_SOURCE]);
  const layers: { id: string; filter?: unknown }[] = (opts.layers ?? []).map((id) => ({ id }));
  const map: HighlightMap & { order(): string[]; filterOf(id: string): unknown } = {
    getSource: (id) => (sources.has(id) ? {} : undefined),
    getLayer: (id) => layers.find((l) => l.id === id),
    addLayer(layer: LayerSpecification, beforeId?: string) {
      if (layers.some((l) => l.id === layer.id)) throw new Error(`duplicate ${layer.id}`);
      const entry = { id: layer.id, filter: (layer as { filter?: unknown }).filter };
      const i = beforeId ? layers.findIndex((l) => l.id === beforeId) : -1;
      if (i >= 0) layers.splice(i, 0, entry);
      else layers.push(entry);
    },
    removeLayer(id) {
      layers.splice(
        layers.findIndex((l) => l.id === id),
        1,
      );
    },
    setFilter(id, filter: FilterSpecification | null) {
      const l = layers.find((x) => x.id === id);
      if (l) l.filter = filter;
    },
    order: () => layers.map((l) => l.id),
    filterOf: (id) => layers.find((l) => l.id === id)?.filter,
  };
  return map;
}

const BASE = ['background', FIELD_LAYER_IDS.fill, FIELD_LAYER_IDS.outline, FIELD_LAYER_IDS.label];
const OURS = [HIGHLIGHT_LAYER_IDS.fill, HIGHLIGHT_LAYER_IDS.casing, HIGHLIGHT_LAYER_IDS.line];

describe('applyHighlight', () => {
  test('adds fill, casing and line just under the field names, filtered to the field', () => {
    const map = fakeMap({ layers: BASE });
    applyHighlight(map, 'f1', 'wall');
    expect(map.order()).toEqual([
      'background',
      FIELD_LAYER_IDS.fill,
      FIELD_LAYER_IDS.outline,
      ...OURS,
      FIELD_LAYER_IDS.label,
    ]);
    for (const id of OURS) expect(map.filterOf(id)).toEqual(highlightFilter('f1'));
  });

  test('is idempotent and switches fields by filter', () => {
    const map = fakeMap({ layers: BASE });
    applyHighlight(map, 'f1', 'phone');
    applyHighlight(map, 'f1', 'phone');
    applyHighlight(map, 'f2', 'phone');
    expect(map.order().filter((id) => id.startsWith('field-panel-'))).toEqual(OURS);
    expect(map.filterOf(HIGHLIGHT_LAYER_IDS.line)).toEqual(['==', ['get', 'id'], 'f2']);
  });

  test('null removes it; without field names it goes on top; without fields it waits', () => {
    const map = fakeMap({ layers: BASE });
    applyHighlight(map, 'f1', 'wall');
    applyHighlight(map, null, 'wall');
    expect(map.order()).toEqual(BASE);

    const noLabels = fakeMap({ layers: ['background', FIELD_LAYER_IDS.fill] });
    applyHighlight(noLabels, 'f1', 'wall');
    expect(noLabels.order()).toEqual(['background', FIELD_LAYER_IDS.fill, ...OURS]);
    removeHighlight(noLabels);
    expect(noLabels.order()).toEqual(['background', FIELD_LAYER_IDS.fill]);

    const noSource = fakeMap({ sources: [], layers: ['background'] });
    applyHighlight(noSource, 'f1', 'wall');
    expect(noSource.order()).toEqual(['background']);
  });
});

describe('tilePreview', () => {
  const previewMap = (props: Record<string, unknown>[] | Error, hasSource = true) => ({
    getSource: () => (hasSource ? {} : undefined),
    querySourceFeatures: () => {
      if (props instanceof Error) throw props;
      return props.map((properties) => ({ properties }));
    },
  });

  test('name, acres and tenure from a loaded tile', () => {
    expect(
      tilePreview(
        previewMap([{ id: 'f1', name: 'Calder 160', acres: 158.2, tenure: 'owned' }]),
        'f1',
      ),
    ).toEqual({ name: 'Calder 160', acres: 158.2, tenure: 'owned' });
  });

  test('null when nothing is loaded, no source, or the map throws; odd values are dropped', () => {
    expect(tilePreview(previewMap([]), 'f1')).toBeNull();
    expect(tilePreview(previewMap([{ name: 'x' }], false), 'f1')).toBeNull();
    expect(tilePreview(previewMap(new Error('style not loaded')), 'f1')).toBeNull();
    expect(tilePreview(previewMap([{ name: 'x', acres: 'big', tenure: 'leased' }]), 'f1')).toEqual({
      name: 'x',
      acres: null,
      tenure: null,
    });
  });
});

describe('revealing the boundary', () => {
  const mapRect = { left: 0, top: 72, right: 1920, bottom: 1080 };

  test('the wall panel pads the right side, the phone sheet the bottom', () => {
    expect(
      panelPadding(mapRect, { left: 1184, top: 84, right: 1824, bottom: 1068 }, 'wall'),
    ).toEqual({ top: 32, right: 32 + 736, bottom: 32, left: 32 });
    expect(
      panelPadding(
        { left: 0, top: 52, right: 412, bottom: 839 },
        { left: 0, top: 378, right: 412, bottom: 839 },
        'phone',
      ),
    ).toEqual({ top: 32, right: 32, bottom: 32 + 461, left: 32 });
    expect(panelPadding(mapRect, null, 'wall')).toEqual({
      top: 32,
      right: 32,
      bottom: 32,
      left: 32,
    });
  });

  test('moves only when a corner is outside the free area', () => {
    const size = { width: 1920, height: 1008 };
    const pad = { top: 32, right: 768, bottom: 32, left: 32 };
    const inside = [
      { x: 400, y: 300 },
      { x: 600, y: 500 },
    ];
    const underPanel = [
      { x: 1300, y: 300 },
      { x: 1400, y: 500 },
    ];
    expect(needsReveal(size, pad, inside)).toBe(false);
    expect(needsReveal(size, pad, underPanel)).toBe(true);
    expect(needsReveal(size, pad, [{ x: -10, y: 300 }])).toBe(true);
    // A window too small to fit anything: leave the map alone.
    expect(needsReveal({ width: 300, height: 200 }, pad, underPanel)).toBe(false);
  });
});
