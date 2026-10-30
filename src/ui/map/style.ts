/**
 * The MapLibre style (pure; unit-tested): the local Protomaps basemap (pmtiles:// through
 * /api/storage, glyphs and sprites from the local assets), with the app's field layers inserted
 * below the basemap's labels and field names on top. Every URL is on the page's own origin: the
 * style references no external host at all (contracts §10). Without a basemap it is a plain
 * background plus fields (and field names if the fonts are installed).
 */
import { namedFlavor, layers as protomapsLayers } from '@protomaps/basemaps';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import type { BasemapFlavor, BasemapInfo, FieldsLayerInfo } from './types';

export const BASEMAP_SOURCE = 'protomaps';
export const FIELDS_SOURCE = 'fields';
export const FIELDS_SOURCE_LAYER = 'fields';
/** One point per field (app.mvt_fields, migration 0005): one label per field, not per tile. */
export const FIELDS_LABEL_SOURCE_LAYER = 'fields_label';
/** Field names show from this zoom (the wall's morning view is about z10-11.5). */
export const FIELD_LABEL_MINZOOM = 9.5;
export const FIELD_LAYER_IDS = {
  fill: 'fields-fill',
  outline: 'fields-outline',
  label: 'fields-label',
} as const;

/** Field colours by tenure (fill at low opacity, outline solid). */
export const TENURE_COLORS = {
  owned: '#22c55e',
  cash_rent: '#eab308',
  share: '#38bdf8',
  custom: '#f97316',
  /** A field the Deere sync created, tenure not set by hand yet (1f). */
  unknown: '#9ca3af',
} as const;
export const TENURE_LABELS = {
  owned: 'Owned',
  cash_rent: 'Cash rent',
  share: 'Share',
  custom: 'Custom work',
  unknown: 'Tenure not set',
} as const;
/** Tenures the map legends list (a field whose tenure isn't set yet draws grey, unlisted). */
export const LEGEND_TENURES = ['owned', 'cash_rent', 'share', 'custom'] as const;

const PLAIN_BACKGROUND = { dark: '#18211d', light: '#e9ece4' } as const;
const PROTOMAPS_ATTRIBUTION =
  '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>';

export interface MapStyleInput {
  /** window.location.origin. */
  origin: string;
  basemap: BasemapInfo | null;
  glyphsPath: string | null;
  fields: FieldsLayerInfo;
  flavor: BasemapFlavor;
  /** Field name sizes: read across the room on the wall (default), held in the hand on phones. */
  variant?: 'wall' | 'phone';
}

const tenureMatch = (fallback: string) =>
  [
    'match',
    ['get', 'tenure'],
    'owned',
    TENURE_COLORS.owned,
    'cash_rent',
    TENURE_COLORS.cash_rent,
    'share',
    TENURE_COLORS.share,
    'custom',
    TENURE_COLORS.custom,
    'unknown',
    TENURE_COLORS.unknown,
    fallback,
  ] as unknown as string;

/**
 * The field layers: [fill, outline] go under the basemap labels, [label] on top. Labels come
 * from the one-point-per-field layer and collide with each other (MapLibre thins them when
 * zoomed out instead of hiding them all below a zoom).
 */
export function fieldLayers(
  withLabels: boolean,
  flavor: BasemapFlavor,
  variant: 'wall' | 'phone' = 'wall',
): {
  below: LayerSpecification[];
  top: LayerSpecification[];
} {
  const below: LayerSpecification[] = [
    {
      id: FIELD_LAYER_IDS.fill,
      type: 'fill',
      source: FIELDS_SOURCE,
      'source-layer': FIELDS_SOURCE_LAYER,
      paint: {
        'fill-color': tenureMatch('#a3a3a3'),
        'fill-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          8,
          0.45,
          14,
          0.25,
        ] as unknown as number,
      },
    },
    {
      id: FIELD_LAYER_IDS.outline,
      type: 'line',
      source: FIELDS_SOURCE,
      'source-layer': FIELDS_SOURCE_LAYER,
      paint: {
        'line-color': tenureMatch('#a3a3a3'),
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          8,
          0.8,
          12,
          1.6,
          16,
          3,
        ] as unknown as number,
      },
    },
  ];
  const top: LayerSpecification[] = withLabels
    ? [
        {
          id: FIELD_LAYER_IDS.label,
          type: 'symbol',
          source: FIELDS_SOURCE,
          'source-layer': FIELDS_LABEL_SOURCE_LAYER,
          minzoom: FIELD_LABEL_MINZOOM,
          layout: {
            'text-field': [
              'format',
              ['get', 'name'],
              {},
              '\n',
              {},
              ['concat', ['number-format', ['get', 'acres'], { 'max-fraction-digits': 0 }], ' ac'],
              { 'font-scale': 0.8 },
            ] as unknown as string,
            'text-font': ['Noto Sans Medium'],
            'text-size': (variant === 'wall'
              ? ['interpolate', ['linear'], ['zoom'], 10, 14, 13, 18, 16, 22]
              : ['interpolate', ['linear'], ['zoom'], 10, 11, 13, 13, 16, 17]) as unknown as number,
            'text-max-width': 8,
            'symbol-placement': 'point',
          },
          paint: {
            'text-color': flavor === 'dark' ? '#f4f7f2' : '#1c2b22',
            'text-halo-color': flavor === 'dark' ? '#0b1210' : '#ffffff',
            'text-halo-width': 1.5,
          },
        },
      ]
    : [];
  return { below, top };
}

/** Insert `below` before the first symbol layer of `base`, `top` after everything. */
export function insertAppLayers(
  base: LayerSpecification[],
  below: LayerSpecification[],
  top: LayerSpecification[],
): LayerSpecification[] {
  const i = base.findIndex((l) => l.type === 'symbol');
  const at = i === -1 ? base.length : i;
  return [...base.slice(0, at), ...below, ...base.slice(at), ...top];
}

export function buildMapStyle(input: MapStyleInput): StyleSpecification {
  const { origin, basemap, glyphsPath, fields, flavor, variant = 'wall' } = input;
  const abs = (p: string) =>
    new URL(p, origin).toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  const fieldsSource = {
    type: 'vector' as const,
    tiles: [abs(fields.tilesPath)],
    minzoom: fields.minzoom,
    maxzoom: fields.maxzoom,
    promoteId: 'id',
  };
  const withLabels = glyphsPath !== null;
  const { below, top } = fieldLayers(withLabels, flavor, variant);

  if (!basemap) {
    return {
      version: 8,
      name: 'farm-ops (no basemap)',
      ...(glyphsPath ? { glyphs: abs(glyphsPath) } : {}),
      sources: { [FIELDS_SOURCE]: fieldsSource },
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: { 'background-color': PLAIN_BACKGROUND[flavor] },
        },
        ...below,
        ...top,
      ],
    };
  }

  const base = protomapsLayers(BASEMAP_SOURCE, namedFlavor(flavor), {
    lang: 'en',
  }) as unknown as LayerSpecification[];
  return {
    version: 8,
    name: `farm-ops (${basemap.build})`,
    glyphs: abs(glyphsPath ?? '/api/storage/tiles/assets/fonts/{fontstack}/{range}.pbf'),
    sprite: abs(`${basemap.spritePathPrefix}/${flavor}`),
    sources: {
      [BASEMAP_SOURCE]: {
        type: 'vector',
        url: `pmtiles://${abs(basemap.pmtilesPath)}`,
        attribution: basemap.synthetic
          ? 'Synthetic test basemap (not OpenStreetMap data)'
          : PROTOMAPS_ATTRIBUTION,
      },
      [FIELDS_SOURCE]: fieldsSource,
    },
    layers: insertAppLayers(base, below, top),
  };
}

/** Every http(s) URL a style references (tests: nothing may point off-origin). */
export function styleUrls(style: StyleSpecification): string[] {
  const out: string[] = [];
  if (typeof style.glyphs === 'string') out.push(style.glyphs);
  if (typeof style.sprite === 'string') out.push(style.sprite);
  for (const s of Object.values(style.sources)) {
    const src = s as { url?: string; tiles?: string[] };
    if (src.url) out.push(src.url.replace(/^pmtiles:\/\//, ''));
    for (const t of src.tiles ?? []) out.push(t);
  }
  return out;
}
