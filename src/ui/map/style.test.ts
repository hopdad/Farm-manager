import { describe, expect, test } from 'vitest';
import { buildMapStyle, FIELD_LAYER_IDS, insertAppLayers, styleUrls } from './style';
import type { BasemapInfo, FieldsLayerInfo } from './types';

const origin = 'http://192.168.1.20:3000';
const fields: FieldsLayerInfo = {
  tilesPath: '/api/tiles/fields/{z}/{x}/{y}?v=abc123',
  minzoom: 8,
  maxzoom: 16,
  version: 'abc123',
};
const basemap: BasemapInfo = {
  pmtilesPath: '/api/storage/tiles/basemap.0123abcd.pmtiles',
  spritePathPrefix: '/api/storage/tiles/assets/sprites/v4',
  build: '20261028.pmtiles',
  synthetic: false,
  bbox: [-84.45, 41.65, -83.1, 42.15],
  maxzoom: 15,
};
const glyphsPath = '/api/storage/tiles/assets/fonts/{fontstack}/{range}.pbf';

describe('buildMapStyle', () => {
  test('with a basemap: local pmtiles, glyphs and sprite on the page origin only', () => {
    const style = buildMapStyle({ origin, basemap, glyphsPath, fields, flavor: 'dark' });
    expect(style.glyphs).toBe(`${origin}/api/storage/tiles/assets/fonts/{fontstack}/{range}.pbf`);
    expect(style.sprite).toBe(`${origin}/api/storage/tiles/assets/sprites/v4/dark`);
    expect(style.sources.protomaps).toMatchObject({
      type: 'vector',
      url: `pmtiles://${origin}/api/storage/tiles/basemap.0123abcd.pmtiles`,
    });
    expect(style.sources.fields).toMatchObject({
      tiles: [`${origin}/api/tiles/fields/{z}/{x}/{y}?v=abc123`],
      minzoom: 8,
      maxzoom: 16,
    });
    for (const url of styleUrls(style)) expect(new URL(url).origin).toBe(origin);
  });

  test('field fills sit under the first basemap label layer; field names on top', () => {
    const style = buildMapStyle({ origin, basemap, glyphsPath, fields, flavor: 'light' });
    const ids = style.layers.map((l) => l.id);
    const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
    expect(ids.indexOf(FIELD_LAYER_IDS.fill)).toBeLessThan(firstSymbol);
    expect(ids.indexOf(FIELD_LAYER_IDS.outline)).toBeLessThan(firstSymbol);
    expect(ids.at(-1)).toBe(FIELD_LAYER_IDS.label);
    expect(ids).toContain('places_locality');
    // Every font the style uses is one of the downloaded font stacks.
    const fonts = new Set(JSON.stringify(style.layers).match(/Noto Sans[ A-Za-z0-9]*/g));
    for (const f of fonts) {
      expect([
        'Noto Sans Regular',
        'Noto Sans Medium',
        'Noto Sans Italic',
        'Noto Sans Devanagari Regular v1',
      ]).toContain(f);
    }
  });

  test('without a basemap: plain background + fields; labels only with fonts', () => {
    const style = buildMapStyle({
      origin,
      basemap: null,
      glyphsPath: null,
      fields,
      flavor: 'dark',
    });
    expect(Object.keys(style.sources)).toEqual(['fields']);
    expect(style.glyphs).toBeUndefined();
    expect(style.layers.map((l) => l.id)).toEqual(['background', 'fields-fill', 'fields-outline']);
    const withFonts = buildMapStyle({ origin, basemap: null, glyphsPath, fields, flavor: 'dark' });
    expect(withFonts.layers.map((l) => l.id)).toContain('fields-label');
  });

  test('synthetic basemaps are attributed as such', () => {
    const style = buildMapStyle({
      origin,
      basemap: { ...basemap, synthetic: true },
      glyphsPath,
      fields,
      flavor: 'dark',
    });
    expect((style.sources.protomaps as { attribution?: string }).attribution).toMatch(/Synthetic/);
  });

  test('insertAppLayers without symbol layers appends', () => {
    const base = [{ id: 'bg', type: 'background' as const }];
    const fill = { id: 'f', type: 'background' as const };
    expect(insertAppLayers(base, [fill], []).map((l) => l.id)).toEqual(['bg', 'f']);
  });
});
