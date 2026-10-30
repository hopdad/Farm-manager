/**
 * The soils layer (plan 1c "Soils layer"; contract ./types.ts, docs/contracts-m1.md §7.3). Owner:
 * soils. SSURGO map unit polygons from the public `soils` MVT (app.mvt_soils, z10+), drawn under
 * the field fills, so field boundaries stay on top. Needs its gis.map_layers row (migration 0003
 * inserts it; `pnpm gis:soils` gives it a version), else the rail says to run the loader.
 *
 * Colour-by modes (soil map Phase A): one layer, five ways to read it, chosen in the rail and
 * remembered per device (../rail/modes.ts, ../rail/persist.ts):
 *
 *   type      Soil type: map unit outlines plus their symbol, no fill (Web Soil Survey style;
 *             best over the aerial photo)
 *   drainage  the dominant component's drainage class (dry warm colours → wet blues): the M1 view
 *   hydgrp    hydrologic group, A-D runoff potential (dual groups x/D in blues: wet unless drained)
 *   farmland  farmland class (prime, prime if drained, statewide, local …)
 *   nccpi     productivity: NCCPI v3 on fixed breaks (the same colours anywhere on the farm)
 *
 * The spec (what applyLayers adds) never depends on the mode, so a mode switch never re-adds
 * the source: the rail calls `applySoilsMode` after every applyLayers, which only sets paint
 * properties (setPaintProperty: MapLibre re-evaluates the tiles it holds, no tile refetch).
 *
 * The spec also carries the label points (`layer:soils:labels`, a GeoJSON source filled from
 * GET /api/soils/labels by ../../soils/useSoilLabels.ts: one point per polygon, so a large map
 * unit isn't labelled once per tile piece) and the outline of the map unit open in the sheet
 * (`layer:soils:selected`, a filter on mukey). `placeSoilsLayers` keeps the polygons just under
 * the fields (above an aerial photo added later) and the labels just under the field names.
 *
 * Every value is the map unit's as gis.soil_mapunits holds it: drainage class and hydrologic
 * group are the dominant component's, NCCPI is weighted by component percent (docs/decisions.md).
 */
import type { FeatureCollection } from 'geojson';
import type {
  ExpressionSpecification,
  FilterSpecification,
  GeoJSONSourceSpecification,
} from 'maplibre-gl';
import type { LayerLegend } from '../../../domain/map-layers';
import { DRAINAGE_CLASSES, type DrainageClass } from '../../../domain/soils';
import { FIELD_LAYER_IDS } from '../style';
import { SOIL_LABELS_MIN_Z } from './soils-labels';
import { absoluteUrl, layerIdPrefix, layerSourceId, type MapLibreLayerDef } from './types';

export const SOILS_LAYER_KEY = 'soils';
/** The MVT layer name inside the tiles (app.mvt_soils). */
export const SOILS_SOURCE_LAYER = 'soils';

const PREFIX = layerIdPrefix(SOILS_LAYER_KEY);
/** Ids of everything the soils def adds (sources and layers). */
export const SOILS_IDS = {
  source: layerSourceId(SOILS_LAYER_KEY),
  labelsSource: `${layerSourceId(SOILS_LAYER_KEY)}:labels`,
  fill: `${PREFIX}fill`,
  outline: `${PREFIX}outline`,
  selected: `${PREFIX}selected`,
  label: `${PREFIX}label`,
} as const;

/** Map unit symbols are labelled from this zoom (the labels route answers from here). */
export const SOIL_LABEL_MINZOOM = SOIL_LABELS_MIN_Z;
/** …and their names from this one. */
export const SOIL_NAME_MINZOOM = 16;

type Flavor = 'light' | 'dark';

/** Not rated in any mode (water, pits, a class the survey left blank). */
export const SOIL_UNKNOWN_COLOR = '#9ca3af';
/** The map unit open in the sheet. */
export const SELECTED_COLOR = '#f472b6';

const typeOutlineColor = (flavor: Flavor) => (flavor === 'dark' ? '#fde047' : '#b45309');

// ---------------------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------------------

export const SOIL_MAP_MODES = ['type', 'drainage', 'hydgrp', 'farmland', 'nccpi'] as const;
export type SoilMapMode = (typeof SOIL_MAP_MODES)[number];

/** Today's view stays the default. */
export const DEFAULT_SOIL_MAP_MODE: SoilMapMode = 'drainage';

export const SOIL_MAP_MODE_LABELS: Record<SoilMapMode, string> = {
  type: 'Soil type',
  drainage: 'Drainage',
  hydgrp: 'Hydrologic group',
  farmland: 'Farmland class',
  nccpi: 'Productivity',
};

export function isSoilMapMode(x: unknown): x is SoilMapMode {
  return typeof x === 'string' && (SOIL_MAP_MODES as readonly string[]).includes(x);
}

/** A saved mode, or the default for anything else (an old or foreign value). */
export function soilMapModeOf(x: unknown): SoilMapMode {
  return isSoilMapMode(x) ? x : DEFAULT_SOIL_MAP_MODE;
}

// ---------------------------------------------------------------------------------------------
// Drainage (dominant component)
// ---------------------------------------------------------------------------------------------

/** Drainage class → colour, driest first (DRAINAGE_CLASSES order). */
export const DRAINAGE_COLORS: Record<DrainageClass, string> = {
  'Excessively drained': '#b45309',
  'Somewhat excessively drained': '#d97706',
  'Well drained': '#facc15',
  'Moderately well drained': '#a3e635',
  'Somewhat poorly drained': '#2dd4bf',
  'Poorly drained': '#38bdf8',
  'Very poorly drained': '#2563eb',
  Subaqueous: '#1e3a8a',
};
/** No drainage class (water, pits, unrated). */
export const DRAINAGE_UNKNOWN_COLOR = SOIL_UNKNOWN_COLOR;

export const SOILS_LEGEND: LayerLegend = {
  title: 'Drainage class',
  items: [
    ...DRAINAGE_CLASSES.map((c) => ({
      label: c,
      swatch: 'fill' as const,
      color: DRAINAGE_COLORS[c],
    })),
    { label: 'Not rated (water, pits)', swatch: 'fill', color: DRAINAGE_UNKNOWN_COLOR },
  ],
  note: 'Dominant component of each SSURGO map unit',
};

/** fill-color: match on the feature's drainage_class. */
export function drainageColorExpression(): ExpressionSpecification {
  const pairs = DRAINAGE_CLASSES.flatMap((c) => [c, DRAINAGE_COLORS[c]]);
  return [
    'match',
    ['coalesce', ['get', 'drainage_class'], ''],
    ...pairs,
    DRAINAGE_UNKNOWN_COLOR,
  ] as unknown as ExpressionSpecification;
}

// ---------------------------------------------------------------------------------------------
// Hydrologic group (dominant component): A-D runoff potential
// ---------------------------------------------------------------------------------------------

/**
 * SSURGO hydrologic groups (component `hydgrp`), lowest runoff first, then the dual groups. A
 * dual group (A/D, B/D, C/D) is a wet soil: D undrained, the first letter once drained (NRCS
 * National Engineering Handbook, part 630, chapter 7).
 */
export const HYDGRP_CLASSES = ['A', 'B', 'C', 'D', 'A/D', 'B/D', 'C/D'] as const;
export type HydrologicGroup = (typeof HYDGRP_CLASSES)[number];

export const HYDGRP_COLORS: Record<HydrologicGroup, string> = {
  A: '#15803d',
  B: '#84cc16',
  C: '#f59e0b',
  D: '#dc2626',
  'A/D': '#67e8f9',
  'B/D': '#38bdf8',
  'C/D': '#2563eb',
};

export const HYDGRP_LABELS: Record<HydrologicGroup, string> = {
  A: 'A: low runoff potential',
  B: 'B: moderately low runoff',
  C: 'C: moderately high runoff',
  D: 'D: high runoff potential',
  'A/D': 'A/D: A if drained, D if not',
  'B/D': 'B/D: B if drained, D if not',
  'C/D': 'C/D: C if drained, D if not',
};

export function hydgrpColorExpression(): ExpressionSpecification {
  return [
    'match',
    ['coalesce', ['get', 'hydgrp'], ''],
    ...HYDGRP_CLASSES.flatMap((g) => [g, HYDGRP_COLORS[g]]),
    SOIL_UNKNOWN_COLOR,
  ] as unknown as ExpressionSpecification;
}

// ---------------------------------------------------------------------------------------------
// Farmland class (map unit `farmlndcl`)
// ---------------------------------------------------------------------------------------------

/**
 * SSURGO's farmland classes are long sentences with many conditional variants ('Prime farmland if
 * drained and either protected from flooding or …'); the map groups them. Order matters: the
 * first rule that matches wins (`farmlandGroupOf` and the MapLibre expression share it).
 */
export const FARMLAND_GROUPS = [
  'prime',
  'prime_if_drained',
  'prime_if_other',
  'statewide',
  'local',
  'unique',
  'not_prime',
] as const;
export type FarmlandGroup = (typeof FARMLAND_GROUPS)[number];

export const FARMLAND_COLORS: Record<FarmlandGroup, string> = {
  prime: '#15803d',
  prime_if_drained: '#4ade80',
  prime_if_other: '#bef264',
  statewide: '#facc15',
  local: '#fb923c',
  unique: '#c084fc',
  not_prime: '#78716c',
};

export const FARMLAND_LABELS: Record<FarmlandGroup, string> = {
  prime: 'Prime farmland',
  prime_if_drained: 'Prime farmland if drained',
  prime_if_other: 'Prime if protected or irrigated',
  statewide: 'Farmland of statewide importance',
  local: 'Farmland of local importance',
  unique: 'Farmland of unique importance',
  not_prime: 'Not prime farmland',
};

const PRIME_IF = 'Prime farmland if';

/** The map's group for a farmland class (null: not rated, or a class no rule knows). */
export function farmlandGroupOf(cls: string | null | undefined): FarmlandGroup | null {
  const v = cls ?? '';
  if (v === 'All areas are prime farmland') return 'prime';
  if (v.startsWith(PRIME_IF) && v.includes('drained')) return 'prime_if_drained';
  if (v.startsWith(PRIME_IF)) return 'prime_if_other';
  if (v.includes('statewide importance')) return 'statewide';
  if (v.includes('local importance')) return 'local';
  if (v.includes('unique importance')) return 'unique';
  if (v === 'Not prime farmland') return 'not_prime';
  return null;
}

export function farmlandColorExpression(): ExpressionSpecification {
  const v = ['coalesce', ['get', 'farmland_class'], ''];
  const startsPrimeIf = ['==', ['index-of', PRIME_IF, v], 0];
  return [
    'case',
    ['==', v, 'All areas are prime farmland'],
    FARMLAND_COLORS.prime,
    ['all', startsPrimeIf, ['in', 'drained', v]],
    FARMLAND_COLORS.prime_if_drained,
    startsPrimeIf,
    FARMLAND_COLORS.prime_if_other,
    ['in', 'statewide importance', v],
    FARMLAND_COLORS.statewide,
    ['in', 'local importance', v],
    FARMLAND_COLORS.local,
    ['in', 'unique importance', v],
    FARMLAND_COLORS.unique,
    ['==', v, 'Not prime farmland'],
    FARMLAND_COLORS.not_prime,
    SOIL_UNKNOWN_COLOR,
  ] as unknown as ExpressionSpecification;
}

// ---------------------------------------------------------------------------------------------
// Productivity: NCCPI v3 (0-1) on fixed breaks
// ---------------------------------------------------------------------------------------------

/**
 * Fixed class breaks (the lower bounds of classes 2-5), so a colour means the same index on
 * every view and every farm. Lake-plain soils mostly sit between 0.45 and 0.75.
 */
export const NCCPI_BREAKS = [0.3, 0.45, 0.6, 0.75] as const;
/** One colour per class, low (red) to high (green), like the field Soils tab's gauge. */
export const NCCPI_COLORS = ['#b91c1c', '#ea580c', '#facc15', '#84cc16', '#15803d'] as const;
export const NCCPI_LABELS = [
  'Under 0.30',
  '0.30 to 0.45',
  '0.45 to 0.60',
  '0.60 to 0.75',
  '0.75 and over',
] as const;

/** Class index 0-4 of an NCCPI value (null when the map unit has none). */
export function nccpiClassOf(nccpi: number | null | undefined): number | null {
  if (typeof nccpi !== 'number' || !Number.isFinite(nccpi)) return null;
  let i = 0;
  for (const b of NCCPI_BREAKS) if (nccpi >= b) i++;
  return i;
}

export function nccpiColorExpression(): ExpressionSpecification {
  const stops = NCCPI_BREAKS.flatMap((b, i) => [b, NCCPI_COLORS[i + 1]]);
  return [
    'case',
    ['has', 'nccpi'],
    ['step', ['to-number', ['get', 'nccpi'], -1], NCCPI_COLORS[0], ...stops],
    SOIL_UNKNOWN_COLOR,
  ] as unknown as ExpressionSpecification;
}

// ---------------------------------------------------------------------------------------------
// One map unit's class in a mode (the in-view list, the sheet): the same answers as the paint
// ---------------------------------------------------------------------------------------------

/** What a map unit's tile feature carries (app.mvt_soils; absent = null). */
export interface SoilUnitProps {
  musym?: string | null;
  muname?: string | null;
  drainage_class?: string | null;
  hydgrp?: string | null;
  farmland_class?: string | null;
  nccpi?: number | null;
}

export interface SoilClass {
  label: string;
  color: string;
}

const NOT_RATED: SoilClass = { label: 'Not rated', color: SOIL_UNKNOWN_COLOR };

/** The colour and class label a map unit gets in `mode` (Soil type: its outline colour). */
export function soilClassOf(mode: SoilMapMode, u: SoilUnitProps, flavor: Flavor): SoilClass {
  switch (mode) {
    case 'type':
      return { label: u.musym ?? '', color: typeOutlineColor(flavor) };
    case 'drainage': {
      const c = u.drainage_class;
      return c && (DRAINAGE_CLASSES as readonly string[]).includes(c)
        ? { label: c, color: DRAINAGE_COLORS[c as DrainageClass] }
        : NOT_RATED;
    }
    case 'hydgrp': {
      const g = u.hydgrp;
      return g && (HYDGRP_CLASSES as readonly string[]).includes(g)
        ? { label: g, color: HYDGRP_COLORS[g as HydrologicGroup] }
        : NOT_RATED;
    }
    case 'farmland': {
      const g = farmlandGroupOf(u.farmland_class);
      return g ? { label: FARMLAND_LABELS[g], color: FARMLAND_COLORS[g] } : NOT_RATED;
    }
    case 'nccpi': {
      const i = nccpiClassOf(u.nccpi);
      return i === null || typeof u.nccpi !== 'number'
        ? NOT_RATED
        : { label: u.nccpi.toFixed(2), color: NCCPI_COLORS[i] as string };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Legends (one per mode)
// ---------------------------------------------------------------------------------------------

export function soilsLegend(mode: SoilMapMode, flavor: Flavor = 'dark'): LayerLegend {
  switch (mode) {
    case 'type':
      return {
        title: 'Soil map units',
        items: [
          { label: 'Map unit boundary', swatch: 'line', color: typeOutlineColor(flavor) },
          { label: 'Map unit open in the sheet', swatch: 'line', color: SELECTED_COLOR },
        ],
        note: `Labels: each map unit's symbol from zoom ${SOIL_LABEL_MINZOOM}, its name from zoom ${SOIL_NAME_MINZOOM}. Tap the map for its components`,
      };
    case 'drainage':
      return SOILS_LEGEND;
    case 'hydgrp':
      return {
        title: 'Hydrologic group',
        items: [
          ...HYDGRP_CLASSES.map((g) => ({
            label: HYDGRP_LABELS[g],
            swatch: 'fill' as const,
            color: HYDGRP_COLORS[g],
          })),
          { label: 'Not rated (water, pits)', swatch: 'fill', color: SOIL_UNKNOWN_COLOR },
        ],
        note: 'Runoff potential when thoroughly wet; dominant component of each map unit',
      };
    case 'farmland':
      return {
        title: 'Farmland class',
        items: [
          ...FARMLAND_GROUPS.map((g) => ({
            label: FARMLAND_LABELS[g],
            swatch: 'fill' as const,
            color: FARMLAND_COLORS[g],
          })),
          { label: 'Not rated', swatch: 'fill', color: SOIL_UNKNOWN_COLOR },
        ],
        note: 'As the soil survey rates each map unit (USDA farmland classification)',
      };
    case 'nccpi':
      return {
        title: 'Productivity (NCCPI)',
        items: [
          ...NCCPI_LABELS.map((label, i) => ({
            label,
            swatch: 'fill' as const,
            color: NCCPI_COLORS[i] as string,
          })),
          { label: 'Not rated (water, pits)', swatch: 'fill', color: SOIL_UNKNOWN_COLOR },
        ],
        note: 'NCCPI v3 from 0 to 1, higher is more productive; weighted by component percent; fixed breaks',
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Paint per mode
// ---------------------------------------------------------------------------------------------

interface PaintContext {
  flavor: Flavor;
  variant: 'wall' | 'phone';
}

/** [layer id, paint property, value] for everything a mode sets. */
export type PaintSetting = readonly [layerId: string, property: string, value: unknown];

function outlineWidth(variant: 'wall' | 'phone', bold: boolean) {
  const far = bold ? 0.8 : 0.4;
  const near = bold ? (variant === 'wall' ? 3 : 2.2) : variant === 'wall' ? 2 : 1.5;
  return ['interpolate', ['linear'], ['zoom'], 10, far, 16, near];
}

/** The paint of `mode` (the spec starts with the default mode's; applySoilsMode sets the rest). */
export function soilsModePaint(mode: SoilMapMode, ctx: PaintContext): PaintSetting[] {
  const { flavor, variant } = ctx;
  const color =
    mode === 'drainage'
      ? drainageColorExpression()
      : mode === 'hydgrp'
        ? hydgrpColorExpression()
        : mode === 'farmland'
          ? farmlandColorExpression()
          : mode === 'nccpi'
            ? nccpiColorExpression()
            : 'rgba(0, 0, 0, 0)';
  const type = mode === 'type';
  return [
    [SOILS_IDS.fill, 'fill-color', color],
    // Soil type draws no fill; the fill layer stays (transparent) so a tap finds its map unit.
    [SOILS_IDS.fill, 'fill-opacity', type ? 0 : flavor === 'dark' ? 0.55 : 0.45],
    [
      SOILS_IDS.outline,
      'line-color',
      type
        ? typeOutlineColor(flavor)
        : flavor === 'dark'
          ? 'rgba(255,255,255,0.55)'
          : 'rgba(68,48,20,0.6)',
    ],
    [SOILS_IDS.outline, 'line-width', outlineWidth(variant, type)],
  ];
}

/** The part of maplibre-gl's Map the mode and placement need (a fake implements it in tests). */
export interface SoilsMapLike {
  getStyle(): { layers?: readonly { id: string }[] } | null | undefined;
  /** MapLibre's layer order without serializing the whole style (preferred when present). */
  getLayersOrder?(): string[];
  getLayer(id: string): unknown;
  getPaintProperty(id: string, name: string): unknown;
  setPaintProperty(id: string, name: string, value: unknown): unknown;
  moveLayer(id: string, beforeId?: string): unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Paint the soils layers for `mode` (idempotent: only what differs is set) and keep them in
 * place (placeSoilsLayers). Returns the settings it changed. Safe before the layers exist.
 */
export function applySoilsMode(
  map: SoilsMapLike,
  mode: SoilMapMode,
  ctx: PaintContext,
): PaintSetting[] {
  const changed: PaintSetting[] = [];
  for (const s of soilsModePaint(mode, ctx)) {
    const [id, name, value] = s;
    if (!map.getLayer(id) || same(map.getPaintProperty(id, name), value)) continue;
    map.setPaintProperty(id, name, value);
    changed.push(s);
  }
  placeSoilsLayers(map);
  return changed;
}

/**
 * Draw order: the polygons right under the field fill (so an aerial photo added after the soils,
 * also anchored under the fields, never covers them: Soil type is read over the aerial), and the
 * labels right under the field names (over the field fills and the basemap's own labels). Moves
 * only what is out of place, so calling it on every apply costs nothing.
 */
export function placeSoilsLayers(map: SoilsMapLike): void {
  const ids = map.getLayersOrder?.() ?? (map.getStyle()?.layers ?? []).map((l) => l.id);
  const fields = ids.indexOf(FIELD_LAYER_IDS.fill);
  if (fields >= 0) {
    const want = [SOILS_IDS.fill, SOILS_IDS.outline, SOILS_IDS.selected].filter((id) =>
      ids.includes(id),
    );
    const placed = want.every((id, i) => ids[fields - want.length + i] === id);
    if (!placed) for (const id of want) map.moveLayer(id, FIELD_LAYER_IDS.fill);
  }
  const names = ids.indexOf(FIELD_LAYER_IDS.label);
  if (ids.includes(SOILS_IDS.label) && names >= 0 && ids[names - 1] !== SOILS_IDS.label) {
    map.moveLayer(SOILS_IDS.label, FIELD_LAYER_IDS.label);
  }
}

/** The selected-outline filter: polygons of `mukey` (none for null). */
export function selectedFilter(mukey: string | null): FilterSpecification {
  return ['==', ['get', 'mukey'], mukey ?? ''] as unknown as FilterSpecification;
}

/** An empty FeatureCollection (the labels source before the first answer). */
export const EMPTY_LABELS: FeatureCollection = { type: 'FeatureCollection', features: [] };

// ---------------------------------------------------------------------------------------------
// The def
// ---------------------------------------------------------------------------------------------

export const soilsLayer: MapLibreLayerDef = {
  key: SOILS_LAYER_KEY,
  render: 'maplibre',
  group: 'soils',
  label: 'Soils (SSURGO)',
  // The rail shows the chosen mode's legend (../rail/modes.ts); this is the default mode's.
  legend: SOILS_LEGEND,
  kind: 'vector',
  offline: true,
  cachePolicy: 'public',
  defaultVisible: false,
  order: 10,
  requiresRow: true,
  buildHint: 'Run pnpm gis:soils to load Lenawee and Monroe soils',
  anchor: 'below-fields',
  minzoom: 10,
  maxzoom: 22,
  spec: ({ origin, row, flavor, variant }) => {
    if (!row) return { sources: {}, layers: [] };
    const paint = (id: string) =>
      Object.fromEntries(
        soilsModePaint(DEFAULT_SOIL_MAP_MODE, { flavor, variant })
          .filter(([layer]) => layer === id)
          .map(([, name, value]) => [name, value]),
      );
    const labels: GeoJSONSourceSpecification = { type: 'geojson', data: EMPTY_LABELS };
    return {
      sources: {
        [SOILS_IDS.source]: {
          type: 'vector',
          tiles: [absoluteUrl(origin, row.url)],
          minzoom: row.minzoom,
          maxzoom: row.maxzoom,
          ...(row.attribution ? { attribution: row.attribution } : {}),
        },
        [SOILS_IDS.labelsSource]: labels,
      },
      layers: [
        {
          id: SOILS_IDS.fill,
          type: 'fill',
          source: SOILS_IDS.source,
          'source-layer': SOILS_SOURCE_LAYER,
          minzoom: row.minzoom,
          paint: paint(SOILS_IDS.fill),
        },
        {
          id: SOILS_IDS.outline,
          type: 'line',
          source: SOILS_IDS.source,
          'source-layer': SOILS_SOURCE_LAYER,
          minzoom: row.minzoom,
          paint: paint(SOILS_IDS.outline),
        },
        {
          id: SOILS_IDS.selected,
          type: 'line',
          source: SOILS_IDS.source,
          'source-layer': SOILS_SOURCE_LAYER,
          minzoom: row.minzoom,
          filter: selectedFilter(null),
          paint: {
            'line-color': SELECTED_COLOR,
            'line-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              10,
              1.5,
              16,
              variant === 'wall' ? 5 : 4,
            ] as unknown as number,
          },
        },
        {
          id: SOILS_IDS.label,
          type: 'symbol',
          source: SOILS_IDS.labelsSource,
          minzoom: SOIL_LABEL_MINZOOM,
          layout: {
            'text-field': [
              'step',
              ['zoom'],
              ['coalesce', ['get', 'musym'], ''],
              SOIL_NAME_MINZOOM,
              [
                'format',
                ['coalesce', ['get', 'musym'], ''],
                {},
                '\n',
                {},
                ['coalesce', ['get', 'muname'], ''],
                { 'font-scale': 0.72 },
              ],
            ] as unknown as string,
            'text-font': ['Noto Sans Medium'],
            'text-size': (variant === 'wall'
              ? ['interpolate', ['linear'], ['zoom'], 13, 15, 16, 19]
              : ['interpolate', ['linear'], ['zoom'], 13, 12, 16, 15]) as unknown as number,
            'text-max-width': 10,
            'text-padding': 4,
            // Bigger polygons first when labels collide (the route ranks them by area).
            'symbol-sort-key': ['get', 'rank'] as unknown as number,
            'symbol-placement': 'point',
          },
          paint: {
            'text-color': flavor === 'dark' ? '#fef9c3' : '#422006',
            'text-halo-color': flavor === 'dark' ? '#1c1917' : '#ffffff',
            'text-halo-width': 1.6,
          },
        },
      ],
    };
  },
};
