/** The spray layer def (contract §7.3) and the feature-state painter (SprayFieldState). */
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import { describe, expect, test } from 'vitest';
import { SPRAY_COLORS } from '../../weather/format';
import { applyVerdicts, type FeatureStateMap } from '../../weather/SprayFieldState';
import { FIELD_LAYER_IDS, FIELDS_SOURCE, FIELDS_SOURCE_LAYER } from '../style';
import { applyLayers, type MapLike, validateSpec } from './apply';
import { LAYER_DEFS } from './registry';
import { SPRAY_FILL_COLOR, SPRAY_FILL_LAYER_ID, sprayLayer } from './spray';
import { resolveLayers } from './types';

describe('spray layer def', () => {
  test('matches the contract: fields group, order 20, private, no row, off by default', () => {
    expect(sprayLayer).toMatchObject({
      key: 'spray',
      render: 'maplibre',
      group: 'fields',
      order: 20,
      requiresRow: false,
      cachePolicy: 'private',
      anchor: 'below-labels',
      defaultVisible: false,
      kind: 'vector',
      offline: true,
    });
    expect(sprayLayer.label).toMatch(/advisory/i);
    expect(sprayLayer.legend?.items.map((i) => [i.label, i.color])).toEqual([
      ['Go', SPRAY_COLORS.go],
      ['Caution', SPRAY_COLORS.caution],
      ['No-go', SPRAY_COLORS.no_go],
    ]);
    expect(LAYER_DEFS).toContain(sprayLayer);
  });

  test('one fill layer on the fields tiles, coloured by feature state, clear without one', () => {
    const spec = sprayLayer.spec({
      origin: 'http://x',
      row: null,
      flavor: 'dark',
      variant: 'wall',
    });
    validateSpec('spray', spec);
    expect(spec.sources).toEqual({});
    expect(spec.layers).toHaveLength(1);
    const fill = spec.layers[0] as LayerSpecification & { paint: Record<string, unknown> };
    expect(fill).toMatchObject({
      id: SPRAY_FILL_LAYER_ID,
      type: 'fill',
      source: FIELDS_SOURCE,
      'source-layer': FIELDS_SOURCE_LAYER,
    });
    expect(fill.paint['fill-color']).toEqual(SPRAY_FILL_COLOR);
    expect(SPRAY_FILL_COLOR).toEqual([
      'match',
      ['feature-state', 'verdict'],
      'go',
      SPRAY_COLORS.go,
      'caution',
      SPRAY_COLORS.caution,
      'no_go',
      SPRAY_COLORS.no_go,
      'rgba(0,0,0,0)',
    ]);
  });

  test('resolves ready without a registry row and applies below the labels', () => {
    const resolved = resolveLayers([sprayLayer], []);
    expect(resolved[0]?.status).toBe('ready');
    const layers: { id: string; type: string; layout: Record<string, unknown> }[] = [
      { id: FIELD_LAYER_IDS.fill, type: 'fill', layout: {} },
      { id: 'places', type: 'symbol', layout: {} },
    ];
    const sources: Record<string, SourceSpecification> = { fields: { type: 'vector' } };
    const map: MapLike = {
      getStyle: () => ({ layers, sources }),
      getSource: (id) => sources[id],
      addSource: (id, s) => {
        sources[id] = s;
      },
      removeSource: (id) => {
        delete sources[id];
      },
      getLayer: (id) => layers.find((l) => l.id === id),
      addLayer: (l, before) => {
        const i = before ? layers.findIndex((x) => x.id === before) : layers.length;
        layers.splice(i, 0, { id: l.id, type: l.type, layout: { ...(l.layout ?? {}) } });
      },
      removeLayer: (id) => {
        layers.splice(
          layers.findIndex((l) => l.id === id),
          1,
        );
      },
      setLayoutProperty: (id, k, v) => {
        const l = layers.find((x) => x.id === id);
        if (l) l.layout[k] = v;
      },
    };
    let visible = false;
    applyLayers(map, resolved, () => visible, {
      origin: 'http://x',
      flavor: 'light',
      variant: 'phone',
    });
    expect(layers.map((l) => l.id)).toEqual([FIELD_LAYER_IDS.fill, SPRAY_FILL_LAYER_ID, 'places']);
    expect(layers[1]?.layout.visibility).toBe('none');
    visible = true;
    applyLayers(map, resolved, () => visible, {
      origin: 'http://x',
      flavor: 'light',
      variant: 'phone',
    });
    expect(layers[1]?.layout.visibility).toBe('visible');
  });
});

describe('SprayFieldState feature state', () => {
  function fakeMap(hasSource = true) {
    const state = new Map<string, Record<string, unknown>>();
    const map = {
      getSource: (id: string) => (hasSource && id === FIELDS_SOURCE ? {} : undefined),
      setFeatureState: (
        f: { source: string; sourceLayer?: string; id?: string | number },
        s: Record<string, unknown>,
      ) => {
        expect(f.source).toBe(FIELDS_SOURCE);
        expect(f.sourceLayer).toBe(FIELDS_SOURCE_LAYER);
        state.set(String(f.id), { ...(state.get(String(f.id)) ?? {}), ...s });
      },
      removeFeatureState: (f: { id?: string | number }, key?: string) => {
        const cur = state.get(String(f.id)) ?? {};
        if (key) delete cur[key];
        state.set(String(f.id), cur);
      },
      getFeatureState: (f: { id?: string | number }) => state.get(String(f.id)) ?? {},
      on: () => map,
      off: () => map,
    };
    return { map: map as unknown as FeatureStateMap, state };
  }

  test('sets each verdict, clears fields no longer listed, waits for the fields source', () => {
    const { map, state } = fakeMap();
    const first = applyVerdicts(
      map,
      new Map(),
      new Map([
        ['a', 'go'],
        ['b', 'no_go'],
      ] as const),
    );
    expect(state.get('a')).toEqual({ verdict: 'go' });
    expect(state.get('b')).toEqual({ verdict: 'no_go' });
    const second = applyVerdicts(map, first ?? new Map(), new Map([['a', 'caution']] as const));
    expect(state.get('a')).toEqual({ verdict: 'caution' });
    expect(state.get('b')).toEqual({});
    expect([...(second ?? new Map()).keys()]).toEqual(['a']);
    expect(
      applyVerdicts(fakeMap(false).map, new Map(), new Map([['a', 'go']] as const)),
    ).toBeNull();
  });
});
