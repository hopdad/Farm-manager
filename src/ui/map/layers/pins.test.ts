/**
 * The `pins` layer def (docs/contracts-1f.md §5.2): the contract's fixed attributes, a pure spec
 * with one empty GeoJSON source `layer:pins` and `layer:pins:*` layers MapLibre accepts (both
 * flavours, both variants), drawn without a registry row, registered once in the Fields group,
 * and applyLayers adds it on a fake map at the top.
 */
import { describe, expect, test } from 'vitest';
import { PIN_TAP_LAYERS } from '../../pins/model';
import { matchesTapLayer } from '../tap';
import { validateSpec } from './apply';
import { PINS_LAYER_IDS, PINS_SOURCE_ID, pinsLayer } from './pins';
import { LAYER_DEFS } from './registry';
import { styleErrors } from './tile-style-validate';
import { resolveLayers } from './types';

const ctx = (flavor: 'light' | 'dark', variant: 'wall' | 'phone') => ({
  origin: 'http://localhost:3111',
  row: null,
  flavor,
  variant,
});

describe('pins layer', () => {
  test('the attributes the contract fixes', () => {
    expect(pinsLayer).toMatchObject({
      key: 'pins',
      group: 'fields',
      label: 'Deere flags',
      render: 'maplibre',
      kind: 'vector',
      anchor: 'top',
      order: 30,
      minzoom: 10,
      maxzoom: 24,
      requiresRow: false,
      cachePolicy: 'private',
      offline: true,
      defaultVisible: true,
    });
    expect(pinsLayer.legend?.items.map((i) => i.label)).toEqual([
      'Wet hole',
      'Rock',
      'Tile blowout',
      'Washout',
      'Hazard',
      'Note',
    ]);
  });

  test('a pure spec: one empty GeoJSON source, polygons, lines and points layers, valid style', () => {
    for (const flavor of ['light', 'dark'] as const) {
      for (const variant of ['wall', 'phone'] as const) {
        const spec = pinsLayer.spec(ctx(flavor, variant));
        expect(() => validateSpec('pins', spec)).not.toThrow();
        expect(styleErrors(spec)).toEqual([]);
        expect(spec.sources).toEqual({
          [PINS_SOURCE_ID]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        });
        expect(spec.layers.map((l) => l.id)).toEqual(Object.values(PINS_LAYER_IDS));
        expect(spec).toEqual(pinsLayer.spec(ctx(flavor, variant)));
      }
    }
    expect(PINS_SOURCE_ID).toBe('layer:pins');
  });

  test("every pins layer is a tap layer (the board's PIN_TAP_LAYERS)", () => {
    for (const id of Object.values(PINS_LAYER_IDS)) {
      expect(matchesTapLayer(id, PIN_TAP_LAYERS)).toBe(true);
    }
    expect(matchesTapLayer('fields-fill', PIN_TAP_LAYERS)).toBe(false);
  });

  test('ready without a registry row; registered once', () => {
    expect(resolveLayers([pinsLayer], [])[0]?.status).toBe('ready');
    expect(LAYER_DEFS.filter((d) => d.key === 'pins')).toEqual([pinsLayer]);
  });
});
