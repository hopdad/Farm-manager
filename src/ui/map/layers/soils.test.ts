/**
 * The soils layer def and its colour-by modes (soil map Phase A): the spec (ids, sources, the
 * label points and the selected outline, valid MapLibre style), the colour expressions evaluated
 * by MapLibre's own expression engine against the TS classification the in-view list and the
 * sheet use, one legend per mode, the paint each mode sets (no source change), and the draw
 * order that keeps soils above an aerial photo and their labels above the field fills.
 */
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { legendSchema } from '../../../domain/map-layers';
import { DRAINAGE_CLASSES } from '../../../domain/soils';
import { FIELD_LAYER_IDS, fieldLayers, TENURE_COLORS } from '../style';
import { applyLayers, type MapLike, validateSpec } from './apply';
import { CUSTOMER_OUTLINE_COLOR } from './builtin';
import { PARCEL_LINE_COLOR } from './parcels';
import { LAYER_DEFS } from './registry';
import {
  applySoilsMode,
  DEFAULT_SOIL_MAP_MODE,
  DRAINAGE_COLORS,
  DRAINAGE_UNKNOWN_COLOR,
  drainageColorExpression,
  FARMLAND_COLORS,
  FARMLAND_GROUPS,
  farmlandColorExpression,
  farmlandGroupOf,
  HYDGRP_CLASSES,
  HYDGRP_COLORS,
  hydgrpColorExpression,
  isSoilMapMode,
  NCCPI_BREAKS,
  NCCPI_COLORS,
  nccpiClassOf,
  nccpiColorExpression,
  placeSoilsLayers,
  SELECTED_COLOR,
  SOIL_LABEL_MINZOOM,
  SOIL_MAP_MODE_LABELS,
  SOIL_MAP_MODES,
  SOIL_TYPE_OUTLINE_COLORS,
  SOIL_UNKNOWN_COLOR,
  SOILS_IDS,
  SOILS_LEGEND,
  type SoilMapMode,
  type SoilsMapLike,
  selectedFilter,
  soilClassOf,
  soilMapModeOf,
  soilsLayer,
  soilsLegend,
  soilsModePaint,
} from './soils';
import { row } from './test-fixtures';
import { TILE_KIND_COLORS } from './tile';
import { styleErrors } from './tile-style-validate';
import { resolveLayers } from './types';

const ctx = {
  origin: 'http://192.168.1.20:3000',
  flavor: 'dark' as const,
  variant: 'wall' as const,
};

/** Chroma (0-1: max minus min channel) of a #rrggbb colour: 0 for white, grey and black. */
function chroma(hex: string): number {
  const ch = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  return Math.max(...ch) - Math.min(...ch);
}
function lightness(hex: string): number {
  const ch = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  return (Math.max(...ch) + Math.min(...ch)) / 2;
}

// MapLibre's expression engine (maplibre-gl's own style-spec dependency; tests only).
type Evaluator = (props: Record<string, unknown>, zoom?: number) => unknown;
function evaluator(expr: unknown): Evaluator {
  const fromMaplibre = createRequire(
    createRequire(import.meta.url).resolve('maplibre-gl/package.json'),
  );
  const spec = fromMaplibre('@maplibre/maplibre-gl-style-spec') as {
    createExpression(
      e: unknown,
      rootKey: string,
    ):
      | { result: 'success'; value: { evaluate(g: object, f: object): unknown } }
      | { result: 'error'; value: { message: string }[] };
  };
  const parsed = spec.createExpression(expr, 'layers[0].paint.fill-color');
  if (parsed.result !== 'success') {
    throw new Error(parsed.value.map((e) => e.message).join('; '));
  }
  const { value } = parsed;
  return (properties, zoom = 14) => value.evaluate({ zoom }, { type: 'Polygon', properties });
}

/** Tile properties as app.mvt_soils writes them: an absent property is missing, never null. */
const tileProps = (u: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(u).filter(([, v]) => v !== null && v !== undefined));

/** Farmland class values from the SSURGO domain (mapunit.farmlndcl), plus edge cases. */
const FARMLAND_VALUES: [string | null, ReturnType<typeof farmlandGroupOf>][] = [
  ['All areas are prime farmland', 'prime'],
  ['Prime farmland if drained', 'prime_if_drained'],
  [
    'Prime farmland if drained and either protected from flooding or not frequently flooded during the growing season',
    'prime_if_drained',
  ],
  ['Prime farmland if irrigated and drained', 'prime_if_drained'],
  [
    'Prime farmland if protected from flooding or not frequently flooded during the growing season',
    'prime_if_other',
  ],
  ['Prime farmland if irrigated', 'prime_if_other'],
  [
    'Prime farmland if subsoiled, completely removing the root inhibiting soil layer',
    'prime_if_other',
  ],
  ['Farmland of statewide importance', 'statewide'],
  ['Farmland of statewide importance, if drained', 'statewide'],
  ['Farmland of local importance', 'local'],
  ['Farmland of local importance, if irrigated', 'local'],
  ['Farmland of unique importance', 'unique'],
  ['Not prime farmland', 'not_prime'],
  ['Something new the survey adds', null],
  ['', null],
  [null, null],
];

// ---------------------------------------------------------------------------------------------
// A fake map: style layers in order, paint, moveLayer, and what applyLayers needs
// ---------------------------------------------------------------------------------------------

function fakeMap(initial: string[]) {
  const isSymbol = (id: string) => id === 'places' || id === FIELD_LAYER_IDS.label;
  const layers: { id: string; type: string; layout: Record<string, unknown> }[] = initial.map(
    (id) => ({ id, type: isSymbol(id) ? 'symbol' : 'fill', layout: {} }),
  );
  const paint = new Map<string, Record<string, unknown>>();
  const sources: Record<string, unknown> = {};
  const calls: string[] = [];
  const map: MapLike & SoilsMapLike = {
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
      paint.set(l.id, { ...((l as { paint?: Record<string, unknown> }).paint ?? {}) });
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
    getPaintProperty: (id, name) => paint.get(id)?.[name],
    setPaintProperty: (id, name, value) => {
      paint.set(id, { ...(paint.get(id) ?? {}), [name]: value });
      calls.push(`paint ${id} ${name}`);
    },
    moveLayer: (id, before) => {
      const from = layers.findIndex((l) => l.id === id);
      const [l] = layers.splice(from, 1);
      if (!l) return;
      const to = before ? layers.findIndex((x) => x.id === before) : layers.length;
      layers.splice(to, 0, l);
      calls.push(`move ${id}${before ? ` before ${before}` : ''}`);
    },
  };
  return { map, layers, sources, paint, calls };
}

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

  test('spec: the tiles on the row URL, the label points; fill, outline, selected, labels', () => {
    const r = row('soils', {
      url: '/api/tiles/soils/{z}/{x}/{y}?v=fixture-abc',
      attribution: 'Soils: USDA NRCS SSURGO',
    });
    const spec = soilsLayer.spec({ ...ctx, row: r });
    validateSpec('soils', spec);
    expect(styleErrors(spec)).toEqual([]);
    expect(spec.sources).toEqual({
      'layer:soils': {
        type: 'vector',
        tiles: ['http://192.168.1.20:3000/api/tiles/soils/{z}/{x}/{y}?v=fixture-abc'],
        minzoom: 10,
        maxzoom: 16,
        attribution: 'Soils: USDA NRCS SSURGO',
      },
      'layer:soils:labels': {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      },
    });
    expect(spec.layers.map((l) => [l.id, l.type])).toEqual([
      ['layer:soils:fill', 'fill'],
      ['layer:soils:outline', 'line'],
      ['layer:soils:selected', 'line'],
      ['layer:soils:label', 'symbol'],
    ]);
    const tiled = spec.layers.filter((l) => l.type !== 'symbol');
    expect(tiled.every((l) => 'source-layer' in l && l['source-layer'] === 'soils')).toBe(true);
    const label = spec.layers.find((l) => l.id === SOILS_IDS.label);
    expect(label).toMatchObject({ source: 'layer:soils:labels', minzoom: SOIL_LABEL_MINZOOM });
    for (const flavor of ['light', 'dark'] as const) {
      for (const variant of ['wall', 'phone'] as const) {
        const s = soilsLayer.spec({ origin: ctx.origin, row: r, flavor, variant });
        expect(styleErrors(s), `${flavor} ${variant}`).toEqual([]);
      }
    }
  });

  test('labels: the symbol from z13, symbol and name from z16, bigger polygons placed first', () => {
    const spec = soilsLayer.spec({ ...ctx, row: row('soils') });
    const label = spec.layers.find((l) => l.id === SOILS_IDS.label);
    const layout = (label as { layout: Record<string, unknown> }).layout;
    const field = layout['text-field'] as unknown[];
    expect(field[0]).toBe('step');
    expect(field[3]).toBe(16);
    expect(JSON.stringify(field[2])).toContain('musym');
    expect(JSON.stringify(field[2])).not.toContain('muname');
    expect(JSON.stringify(field[4])).toContain('muname');
    expect(layout['symbol-sort-key']).toEqual(['get', 'rank']);
  });

  test('the spec never depends on the mode (a mode switch never re-adds the source)', () => {
    const r = row('soils');
    const a = JSON.stringify(soilsLayer.spec({ ...ctx, row: r }));
    for (const mode of SOIL_MAP_MODES) {
      applySoilsMode(fakeMap([FIELD_LAYER_IDS.fill]).map, mode, ctx);
      expect(JSON.stringify(soilsLayer.spec({ ...ctx, row: r }))).toBe(a);
    }
    // It starts drawn the default (today's drainage) way.
    const fill = soilsLayer.spec({ ...ctx, row: r }).layers[0] as {
      paint: Record<string, unknown>;
    };
    expect(fill.paint['fill-color']).toEqual(drainageColorExpression());
  });

  test('without a row it draws nothing (the rail shows the build hint instead)', () => {
    expect(soilsLayer.spec({ ...ctx, row: null })).toEqual({ sources: {}, layers: [] });
    const [r] = resolveLayers([soilsLayer], []);
    expect(r?.status).toBe('missing');
    expect(soilsLayer.buildHint).toMatch(/pnpm gis:soils/);
  });

  test('applyLayers puts it under the field fill and re-adds it on a new version', () => {
    const { map, calls, layers, sources } = fakeMap([FIELD_LAYER_IDS.fill, 'places']);
    const visible = () => true;
    const rows = (v: string) =>
      resolveLayers([soilsLayer], [row('soils', { version: v, url: `/t?v=${v}` })]);
    applyLayers(map, rows('a'), visible, ctx);
    expect(layers.map((l) => l.id)).toEqual([
      'layer:soils:fill',
      'layer:soils:outline',
      'layer:soils:selected',
      'layer:soils:label',
      FIELD_LAYER_IDS.fill,
      'places',
    ]);
    calls.length = 0;
    applyLayers(map, rows('a'), visible, ctx);
    expect(calls).toEqual([]);
    applyLayers(map, rows('b'), visible, ctx);
    expect(calls).toContain('+src layer:soils');
    expect((sources['layer:soils'] as { tiles: string[] }).tiles[0]).toMatch(/v=b$/);
  });
});

describe('colour-by modes', () => {
  test('five modes, labelled, today’s drainage view by default; anything else reads as it', () => {
    expect([...SOIL_MAP_MODES]).toEqual(['type', 'drainage', 'hydgrp', 'farmland', 'nccpi']);
    expect(SOIL_MAP_MODE_LABELS).toEqual({
      type: 'Soil type',
      drainage: 'Drainage',
      hydgrp: 'Hydrologic group',
      farmland: 'Farmland class',
      nccpi: 'Productivity',
    });
    expect(DEFAULT_SOIL_MAP_MODE).toBe('drainage');
    expect(isSoilMapMode('hydgrp')).toBe(true);
    expect(isSoilMapMode('texture')).toBe(false);
    expect(soilMapModeOf('nccpi')).toBe('nccpi');
    expect(soilMapModeOf('texture')).toBe('drainage');
    expect(soilMapModeOf(undefined)).toBe('drainage');
    expect(soilMapModeOf(3)).toBe('drainage');
  });

  test('drainage: every class has its own colour, unknown is grey (MapLibre agrees)', () => {
    const expr = drainageColorExpression() as unknown[];
    expect(expr[0]).toBe('match');
    const ev = evaluator(expr);
    for (const c of DRAINAGE_CLASSES) {
      expect(ev({ drainage_class: c }), c).toBe(DRAINAGE_COLORS[c]);
      expect(soilClassOf('drainage', { drainage_class: c }, 'dark').color).toBe(DRAINAGE_COLORS[c]);
    }
    expect(ev({})).toBe(DRAINAGE_UNKNOWN_COLOR);
    expect(ev({ drainage_class: 'Moist' })).toBe(DRAINAGE_UNKNOWN_COLOR);
    expect(new Set(Object.values(DRAINAGE_COLORS)).size).toBe(DRAINAGE_CLASSES.length);
  });

  test('hydrologic group: A-D and the dual groups each have a colour, unrated is grey', () => {
    const ev = evaluator(hydgrpColorExpression());
    for (const g of HYDGRP_CLASSES) {
      expect(ev({ hydgrp: g }), g).toBe(HYDGRP_COLORS[g]);
      expect(soilClassOf('hydgrp', { hydgrp: g }, 'dark')).toEqual({
        label: g,
        color: HYDGRP_COLORS[g],
      });
    }
    expect(ev({})).toBe(SOIL_UNKNOWN_COLOR);
    expect(ev({ hydgrp: 'E' })).toBe(SOIL_UNKNOWN_COLOR);
    expect(soilClassOf('hydgrp', { hydgrp: null }, 'dark').color).toBe(SOIL_UNKNOWN_COLOR);
    expect(new Set([...Object.values(HYDGRP_COLORS), SOIL_UNKNOWN_COLOR]).size).toBe(
      HYDGRP_CLASSES.length + 1,
    );
  });

  test('farmland class: grouped the same way by MapLibre and by farmlandGroupOf', () => {
    const ev = evaluator(farmlandColorExpression());
    for (const [value, group] of FARMLAND_VALUES) {
      expect(farmlandGroupOf(value), String(value)).toBe(group);
      const color = group ? FARMLAND_COLORS[group] : SOIL_UNKNOWN_COLOR;
      expect(ev(tileProps({ farmland_class: value })), String(value)).toBe(color);
      expect(soilClassOf('farmland', { farmland_class: value }, 'dark').color).toBe(color);
    }
    // Every group is reachable and has its own colour.
    expect(new Set(FARMLAND_VALUES.map(([, g]) => g).filter(Boolean))).toEqual(
      new Set(FARMLAND_GROUPS),
    );
    expect(new Set(Object.values(FARMLAND_COLORS)).size).toBe(FARMLAND_GROUPS.length);
  });

  test('productivity: NCCPI on fixed breaks (a break belongs to the class above it)', () => {
    const ev = evaluator(nccpiColorExpression());
    const cases: [number, number][] = [
      [0, 0],
      [0.299, 0],
      [0.3, 1],
      [0.449, 1],
      [0.45, 2],
      [0.6, 3],
      [0.749, 3],
      [0.75, 4],
      [1, 4],
    ];
    for (const [nccpi, cls] of cases) {
      expect(nccpiClassOf(nccpi), String(nccpi)).toBe(cls);
      expect(ev({ nccpi }), String(nccpi)).toBe(NCCPI_COLORS[cls]);
      expect(soilClassOf('nccpi', { nccpi }, 'dark')).toEqual({
        label: nccpi.toFixed(2),
        color: NCCPI_COLORS[cls],
      });
    }
    expect(NCCPI_BREAKS).toHaveLength(NCCPI_COLORS.length - 1);
    expect(ev({})).toBe(SOIL_UNKNOWN_COLOR);
    expect(nccpiClassOf(null)).toBeNull();
    expect(nccpiClassOf(Number.NaN)).toBeNull();
    expect(soilClassOf('nccpi', {}, 'dark').color).toBe(SOIL_UNKNOWN_COLOR);
  });

  test('Soil type: no fill (transparent, still tappable), bold outlines that suit the aerial', () => {
    const paint = soilsModePaint('type', ctx);
    expect(paint).toContainEqual([SOILS_IDS.fill, 'fill-opacity', 0]);
    const color = paint.find(([, n]) => n === 'line-color')?.[2];
    expect(color).toBe(SOIL_TYPE_OUTLINE_COLORS.dark);
    expect(soilClassOf('type', { musym: 'BnB' }, 'dark')).toEqual({ label: 'BnB', color });
    expect(soilsModePaint('type', { ...ctx, flavor: 'light' })).toContainEqual([
      SOILS_IDS.outline,
      'line-color',
      SOIL_TYPE_OUTLINE_COLORS.light,
    ]);
    for (const mode of SOIL_MAP_MODES.filter((m) => m !== 'type')) {
      const opacity = soilsModePaint(mode, ctx).find(([, n]) => n === 'fill-opacity')?.[2];
      expect(opacity, mode).toBeGreaterThan(0);
    }
  });

  test('Soil type boundaries never read as field boundaries: another colour, thinner', () => {
    // No line the map draws with these colours: field tenures, tile lines, parcels, customers,
    // the open map unit.
    const taken = [
      ...Object.values(TENURE_COLORS),
      ...Object.values(TILE_KIND_COLORS),
      PARCEL_LINE_COLOR,
      CUSTOMER_OUTLINE_COLOR,
      SELECTED_COLOR,
    ].map((c) => c.toLowerCase());
    for (const flavor of ['dark', 'light'] as const) {
      const own = SOIL_TYPE_OUTLINE_COLORS[flavor];
      expect(taken, flavor).not.toContain(own.toLowerCase());
      // Every one of those is a strong hue, except the grey of a field whose tenure isn't set yet
      // (1f); the soil lines are neutral (white, slate ink), so they can't pass for a cash-rent
      // yellow or a custom-work orange, and sit far from that grey in lightness.
      const neutral = TENURE_COLORS.unknown.toLowerCase();
      for (const c of taken) {
        if (c === neutral) expect(Math.abs(lightness(c) - lightness(own)), c).toBeGreaterThan(0.3);
        else expect(chroma(c), c).toBeGreaterThan(0.3);
      }
      expect(chroma(own), flavor).toBeLessThan(0.15);
      expect(soilsLegend('type', flavor).items[0]?.color).toBe(SOIL_TYPE_OUTLINE_COLORS[flavor]);
    }
    // Thinner than the field outline at every zoom the soils draw, on the wall and on phones.
    const fieldOutline = fieldLayers(false, 'dark').below.find(
      (l) => l.id === FIELD_LAYER_IDS.outline,
    ) as { paint: Record<string, unknown> };
    const fieldWidth = evaluator(fieldOutline.paint['line-width']);
    for (const variant of ['wall', 'phone'] as const) {
      const width = soilsModePaint('type', { ...ctx, variant }).find(
        ([, n]) => n === 'line-width',
      )?.[2];
      const soilWidth = evaluator(width);
      for (let z = 10; z <= 20; z += 0.5) {
        expect(soilWidth({}, z) as number, `${variant} z${z}`).toBeLessThan(
          (fieldWidth({}, z) as number) * 0.8,
        );
      }
    }
  });

  test('every mode sets the same properties of the same layers, all valid style', () => {
    const shape = (m: SoilMapMode) => soilsModePaint(m, ctx).map(([id, n]) => `${id} ${n}`);
    for (const mode of SOIL_MAP_MODES) {
      expect(shape(mode), mode).toEqual(shape('drainage'));
      const spec = soilsLayer.spec({ ...ctx, row: row('soils') });
      for (const [id, name, value] of soilsModePaint(mode, ctx)) {
        const l = spec.layers.find((x) => x.id === id) as { paint: Record<string, unknown> };
        l.paint[name] = value;
      }
      expect(styleErrors(spec), mode).toEqual([]);
    }
  });
});

describe('legends', () => {
  test('one per mode, each valid for the registry schema', () => {
    for (const mode of SOIL_MAP_MODES) {
      const legend = soilsLegend(mode);
      expect(legendSchema.parse(legend), mode).toEqual(legend);
      expect(legend.items.length, mode).toBeGreaterThan(0);
      expect(legend.note, mode).toBeTruthy();
    }
    expect(new Set(SOIL_MAP_MODES.map((m) => soilsLegend(m).title)).size).toBe(5);
  });

  test('drainage is today’s legend: every class in order, then not rated', () => {
    expect(soilsLegend('drainage')).toBe(SOILS_LEGEND);
    expect(SOILS_LEGEND.items.slice(0, DRAINAGE_CLASSES.length).map((i) => i.label)).toEqual([
      ...DRAINAGE_CLASSES,
    ]);
    expect(SOILS_LEGEND.note).toMatch(/Dominant component/);
  });

  test('each legend shows the colours its mode paints', () => {
    const colors = (m: SoilMapMode) => soilsLegend(m).items.map((i) => i.color);
    expect(colors('hydgrp')).toEqual([
      ...HYDGRP_CLASSES.map((g) => HYDGRP_COLORS[g]),
      SOIL_UNKNOWN_COLOR,
    ]);
    expect(soilsLegend('hydgrp').items[3]?.label).toBe('D: high runoff potential');
    expect(colors('farmland')).toEqual([
      ...FARMLAND_GROUPS.map((g) => FARMLAND_COLORS[g]),
      SOIL_UNKNOWN_COLOR,
    ]);
    expect(colors('nccpi')).toEqual([...NCCPI_COLORS, SOIL_UNKNOWN_COLOR]);
    expect(soilsLegend('nccpi').items.map((i) => i.label)).toContain('0.60 to 0.75');
    // Soil type: outlines (as lines), in the flavour's colour.
    const type = soilsLegend('type', 'light');
    expect(type.items[0]).toMatchObject({ swatch: 'line', color: SOIL_TYPE_OUTLINE_COLORS.light });
    expect(type.note).toMatch(/zoom 13/);
    expect(type.note).toMatch(/zoom 16/);
  });
});

describe('applySoilsMode', () => {
  const added = () => {
    const f = fakeMap([
      'background',
      FIELD_LAYER_IDS.fill,
      FIELD_LAYER_IDS.outline,
      'places',
      FIELD_LAYER_IDS.label,
    ]);
    applyLayers(f.map, resolveLayers([soilsLayer], [row('soils')]), () => true, ctx);
    f.calls.length = 0;
    return f;
  };

  test('sets only paint, only what differs, and nothing on a second call', () => {
    const f = added();
    const changed = applySoilsMode(f.map, 'hydgrp', ctx);
    expect(changed.map(([id, n]) => `${id} ${n}`)).toEqual([`${SOILS_IDS.fill} fill-color`]);
    expect(f.paint.get(SOILS_IDS.fill)?.['fill-color']).toEqual(hydgrpColorExpression());
    expect(f.calls.every((c) => c.startsWith('paint ') || c.startsWith('move '))).toBe(true);
    expect(f.calls.some((c) => c.includes('src'))).toBe(false);
    f.calls.length = 0;
    expect(applySoilsMode(f.map, 'hydgrp', ctx)).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  test('Soil type clears the fill and bolds the outline; drainage restores today’s view', () => {
    const f = added();
    const before = Object.fromEntries(
      [SOILS_IDS.fill, SOILS_IDS.outline].map((id) => [id, { ...f.paint.get(id) }]),
    );
    applySoilsMode(f.map, 'type', ctx);
    expect(f.paint.get(SOILS_IDS.fill)?.['fill-opacity']).toBe(0);
    expect(f.paint.get(SOILS_IDS.outline)?.['line-color']).toBe(SOIL_TYPE_OUTLINE_COLORS.dark);
    applySoilsMode(f.map, 'drainage', ctx);
    for (const id of [SOILS_IDS.fill, SOILS_IDS.outline]) {
      expect(f.paint.get(id)).toEqual(before[id]);
    }
  });

  test('does nothing before the layers exist', () => {
    const f = fakeMap([FIELD_LAYER_IDS.fill]);
    expect(applySoilsMode(f.map, 'nccpi', ctx)).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  test('keeps soils above a photo added later, and labels just under the field names', () => {
    const f = added();
    // An aerial photo anchored under the fields too, added after the soils: it lands on top.
    f.map.addLayer({ id: 'layer:naip:raster', type: 'raster', source: 'x' }, FIELD_LAYER_IDS.fill);
    placeSoilsLayers(f.map);
    expect(f.layers.map((l) => l.id)).toEqual([
      'background',
      'layer:naip:raster',
      SOILS_IDS.fill,
      SOILS_IDS.outline,
      SOILS_IDS.selected,
      FIELD_LAYER_IDS.fill,
      FIELD_LAYER_IDS.outline,
      'places',
      SOILS_IDS.label,
      FIELD_LAYER_IDS.label,
    ]);
    f.calls.length = 0;
    placeSoilsLayers(f.map);
    expect(f.calls).toEqual([]);
  });

  test('the selected outline matches one map unit, or none', () => {
    const ev = evaluator(selectedFilter('99901001'));
    expect(ev({ mukey: '99901001' })).toBe(true);
    expect(ev({ mukey: '99901002' })).toBe(false);
    expect(evaluator(selectedFilter(null))({ mukey: '99901001' })).toBe(false);
  });
});
