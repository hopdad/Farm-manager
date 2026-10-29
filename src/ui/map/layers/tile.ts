/**
 * The tile-lines layer (plan 1d "tile maps"; contract ./types.ts, docs/contracts-m1.md §7.3).
 * Owner: imagery. Drainage tile as-builts from the PRIVATE `tile_lines` MVT
 * (app.mvt_tile_lines, z12+): coloured by kind (main, submain, lateral), wider for bigger pipe,
 * with the size and depth written along the line at close zoom. Drawn over the field fills.
 *
 * Its gis.map_layers row comes with migration 0003; the data comes from `pnpm import:tile <file>`
 * and the draw tool on /board (src/ui/map/draw/), which publish `layers`/`updated` so every board
 * reloads the layer.
 */
import type { ExpressionSpecification } from 'maplibre-gl';
import { TILE_KIND_LABELS, TILE_KINDS, type TileKind } from '../../../db/queries/tile-lines-schema';
import type { LayerLegend } from '../../../domain/map-layers';
import { absoluteUrl, layerIdPrefix, layerSourceId, type MapLibreLayerDef } from './types';

export const TILE_LAYER_KEY = 'tile_lines';
/** The MVT layer name inside the tiles (app.mvt_tile_lines). */
export const TILE_SOURCE_LAYER = 'tile_lines';

export const TILE_KIND_COLORS: Record<TileKind, string> = {
  main: '#06b6d4',
  submain: '#3b82f6',
  lateral: '#60a5fa',
  unknown: '#a5b4fc',
};

export const TILE_LEGEND: LayerLegend = {
  title: 'Drainage tile',
  items: TILE_KINDS.map((k) => ({
    label: TILE_KIND_LABELS[k],
    swatch: 'line' as const,
    color: TILE_KIND_COLORS[k],
  })),
  note: 'As-builts imported or drawn on the board',
};

export function tileColorExpression(): ExpressionSpecification {
  return [
    'match',
    ['coalesce', ['get', 'kind'], 'unknown'],
    ...TILE_KINDS.flatMap((k) => [k, TILE_KIND_COLORS[k]]),
    TILE_KIND_COLORS.unknown,
  ] as unknown as ExpressionSpecification;
}

/**
 * Line width: 1 px at z12 growing to 2-6 px at z16 (mains and big pipe wider); `extra` px more for
 * the casing. Zoom must be the input of the top-level interpolate (MapLibre's rule), so `extra`
 * goes into each stop.
 */
export function tileWidthExpression(variant: 'wall' | 'phone', extra = 0): ExpressionSpecification {
  const scale = variant === 'wall' ? 1.5 : 1;
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    12,
    1 + extra,
    16,
    [
      '+',
      extra,
      [
        '*',
        scale,
        [
          'max',
          ['match', ['get', 'kind'], 'main', 4, 'submain', 3, 2],
          ['min', 6, ['/', ['coalesce', ['get', 'size_in'], 0], 2]],
        ],
      ],
    ],
  ] as unknown as ExpressionSpecification;
}

/** '6" · 3.5 ft', '6"', '3.5 ft' or ''. */
export const TILE_LABEL: ExpressionSpecification = [
  'concat',
  ['case', ['has', 'size_in'], ['concat', ['to-string', ['get', 'size_in']], '"'], ''],
  ['case', ['all', ['has', 'size_in'], ['has', 'depth_ft']], ' · ', ''],
  ['case', ['has', 'depth_ft'], ['concat', ['to-string', ['get', 'depth_ft']], ' ft'], ''],
] as unknown as ExpressionSpecification;

export const tileLayer: MapLibreLayerDef = {
  key: TILE_LAYER_KEY,
  render: 'maplibre',
  group: 'tile',
  label: 'Drainage tile',
  legend: TILE_LEGEND,
  kind: 'vector',
  offline: true,
  cachePolicy: 'private',
  defaultVisible: false,
  order: 10,
  requiresRow: true,
  buildHint: 'Run pnpm import:tile <file>, or draw lines with the Tile tool',
  anchor: 'below-labels',
  minzoom: 12,
  maxzoom: 22,
  spec: ({ origin, row, flavor, variant }) => {
    if (!row) return { sources: {}, layers: [] };
    const source = layerSourceId(TILE_LAYER_KEY);
    const prefix = layerIdPrefix(TILE_LAYER_KEY);
    return {
      sources: {
        [source]: {
          type: 'vector',
          tiles: [absoluteUrl(origin, row.url)],
          minzoom: row.minzoom,
          maxzoom: row.maxzoom,
          promoteId: 'id',
          ...(row.attribution ? { attribution: row.attribution } : {}),
        },
      },
      layers: [
        {
          id: `${prefix}casing`,
          type: 'line',
          source,
          'source-layer': TILE_SOURCE_LAYER,
          minzoom: row.minzoom,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': flavor === 'dark' ? 'rgba(4,10,8,0.85)' : 'rgba(255,255,255,0.9)',
            'line-width': tileWidthExpression(variant, 2) as unknown as number,
          },
        },
        {
          id: `${prefix}line`,
          type: 'line',
          source,
          'source-layer': TILE_SOURCE_LAYER,
          minzoom: row.minzoom,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': tileColorExpression(),
            'line-width': tileWidthExpression(variant) as unknown as number,
          },
        },
        {
          id: `${prefix}label`,
          type: 'symbol',
          source,
          'source-layer': TILE_SOURCE_LAYER,
          minzoom: 16,
          layout: {
            'symbol-placement': 'line',
            'text-field': TILE_LABEL,
            'text-font': ['Noto Sans Regular'],
            'text-size': variant === 'wall' ? 14 : 11,
          },
          paint: {
            'text-color': flavor === 'dark' ? '#cffafe' : '#0e7490',
            'text-halo-color': flavor === 'dark' ? '#0b1210' : '#ffffff',
            'text-halo-width': 1.5,
          },
        },
      ],
    };
  },
};
