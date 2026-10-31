/**
 * Layer modes in the rail (soil map Phase A): the soils entry of the registry, cleaning saved
 * modes, the store the rail persists, and what the rail model shows (the picker while on, the
 * chosen mode's legend). The rail's own persistence round trip: ./persist.test.ts.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { fieldsLayer } from '../layers/builtin';
import {
  DEFAULT_SOIL_MAP_MODE,
  SOIL_MAP_MODES,
  SOILS_LEGEND,
  soilsLayer,
  soilsLegend,
} from '../layers/soils';
import { row } from '../layers/test-fixtures';
import { resolveLayers } from '../layers/types';
import { railModel } from './model';
import { LAYER_MODES, layerModeOf, normalizeModes, soilsModes, useLayerModeStore } from './modes';
import { parseRailPrefs } from './persist';

describe('the modes registry', () => {
  test('soils is drawn five ways, drainage by default', () => {
    expect(Object.keys(LAYER_MODES)).toEqual(['soils']);
    expect(soilsModes.options.map((o) => o.id)).toEqual([...SOIL_MAP_MODES]);
    expect(soilsModes.options.map((o) => o.label)).toEqual([
      'Soil type',
      'Drainage',
      'Hydrologic group',
      'Farmland class',
      'Productivity',
    ]);
    expect(soilsModes.defaultMode).toBe(DEFAULT_SOIL_MAP_MODE);
    expect(soilsModes.legend('hydgrp', { flavor: 'dark', variant: 'wall' })).toEqual(
      soilsLegend('hydgrp'),
    );
    expect(soilsModes.legend('junk', { flavor: 'dark', variant: 'wall' })).toBe(SOILS_LEGEND);
  });

  test('layerModeOf: the chosen mode, the default when unset or unknown, null without modes', () => {
    expect(layerModeOf({ soils: 'type' }, 'soils')).toBe('type');
    expect(layerModeOf({}, 'soils')).toBe('drainage');
    expect(layerModeOf({ soils: 'texture' }, 'soils')).toBe('drainage');
    expect(layerModeOf({ fields: 'type' }, 'fields')).toBeNull();
  });

  test('normalizeModes keeps valid choices only, and leaves defaults out', () => {
    expect(normalizeModes({ soils: 'nccpi', parcels: 'owners', fields: 'x' })).toEqual({
      soils: 'nccpi',
    });
    expect(normalizeModes({ soils: 'drainage' })).toEqual({});
    expect(normalizeModes({ soils: 'texture' })).toEqual({});
    // What the rail does with saved prefs: parse (generic), then normalize (per layer).
    const saved = parseRailPrefs(JSON.stringify({ modes: { soils: 'farmland', naip: 'x' } }));
    expect(normalizeModes(saved.modes)).toEqual({ soils: 'farmland' });
  });
});

describe('useLayerModeStore', () => {
  beforeEach(() => useLayerModeStore.getState().reset());

  test('setMode, back to the default, hydrate and reset', () => {
    const s = () => useLayerModeStore.getState();
    s().setMode('soils', 'type');
    expect(s().modes).toEqual({ soils: 'type' });
    s().setMode('soils', 'drainage');
    expect(s().modes).toEqual({});
    s().setMode('soils', 'texture');
    expect(s().modes).toEqual({});
    s().setMode('parcels', 'owners');
    expect(s().modes).toEqual({});
    s().hydrate({ soils: 'nccpi', naip: 'x' });
    expect(s().modes).toEqual({ soils: 'nccpi' });
    s().reset();
    expect(s().modes).toEqual({});
  });
});

describe('the rail model with modes', () => {
  const resolved = resolveLayers([fieldsLayer, soilsLayer], [row('soils'), row('fields')]);
  const soils = (input: Partial<Parameters<typeof railModel>[0]> = {}) =>
    railModel({
      resolved,
      overrides: { soils: true },
      loaded: true,
      online: true,
      failing: new Set(),
      zoom: 14,
      ...input,
    })
      .flatMap((g) => g.items)
      .find((i) => i.key === 'soils');

  test('on: the picker with the chosen mode, and that mode’s legend', () => {
    const item = soils({ modes: { soils: 'farmland' } });
    expect(item?.mode?.current).toBe('farmland');
    expect(item?.mode?.options.map((o) => o.id)).toEqual([...SOIL_MAP_MODES]);
    expect(item?.legend).toEqual(soilsLegend('farmland'));
    // Nothing chosen: drainage, today's legend.
    expect(soils()?.mode?.current).toBe('drainage');
    expect(soils()?.legend).toBe(SOILS_LEGEND);
  });

  test('the legend follows the flavour (Soil type outlines: yellow on dark, amber on light)', () => {
    expect(soils({ modes: { soils: 'type' }, flavor: 'light' })?.legend).toEqual(
      soilsLegend('type', 'light'),
    );
    expect(soils({ modes: { soils: 'type' } })?.legend).toEqual(soilsLegend('type', 'dark'));
  });

  test('off, missing or loading: no picker and no legend', () => {
    expect(soils({ overrides: { soils: false } })?.mode).toBeNull();
    expect(soils({ overrides: { soils: false } })?.legend).toBeNull();
    const missing = railModel({
      resolved: resolveLayers([soilsLayer], []),
      overrides: { soils: true },
      loaded: true,
      online: true,
      failing: new Set(),
      zoom: 14,
    })
      .flatMap((g) => g.items)
      .find((i) => i.key === 'soils');
    expect(missing?.status).toBe('missing');
    expect(missing?.mode).toBeNull();
  });

  test('a layer without modes has none', () => {
    const fields = railModel({
      resolved,
      overrides: { fields: true },
      loaded: true,
      online: true,
      failing: new Set(),
      zoom: 14,
    })
      .flatMap((g) => g.items)
      .find((i) => i.key === 'fields');
    expect(fields?.on).toBe(true);
    expect(fields?.mode).toBeNull();
  });
});
