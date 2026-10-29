/**
 * The soils layer (plan 1c "Soils layer"; contract ./types.ts, docs/contracts-m1.md §7.3). Owner:
 * soils. SSURGO map unit polygons from the public `soils` MVT (app.mvt_soils, z10+), coloured by
 * the dominant component's drainage class (dry warm colours → wet blues: what a tile or drainage
 * decision reads first), with map unit outlines. Drawn under the field fills, so field boundaries
 * stay on top. Needs its gis.map_layers row (migration 0003 inserts it; `pnpm gis:soils` gives it
 * a version), else the rail says to run the loader.
 */
import type { ExpressionSpecification } from 'maplibre-gl';
import type { LayerLegend } from '../../../domain/map-layers';
import { DRAINAGE_CLASSES, type DrainageClass } from '../../../domain/soils';
import { absoluteUrl, layerIdPrefix, layerSourceId, type MapLibreLayerDef } from './types';

export const SOILS_LAYER_KEY = 'soils';
/** The MVT layer name inside the tiles (app.mvt_soils). */
export const SOILS_SOURCE_LAYER = 'soils';

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
export const DRAINAGE_UNKNOWN_COLOR = '#9ca3af';

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

export const soilsLayer: MapLibreLayerDef = {
  key: SOILS_LAYER_KEY,
  render: 'maplibre',
  group: 'soils',
  label: 'Soil drainage (SSURGO)',
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
    const source = layerSourceId(SOILS_LAYER_KEY);
    const prefix = layerIdPrefix(SOILS_LAYER_KEY);
    return {
      sources: {
        [source]: {
          type: 'vector',
          tiles: [absoluteUrl(origin, row.url)],
          minzoom: row.minzoom,
          maxzoom: row.maxzoom,
          ...(row.attribution ? { attribution: row.attribution } : {}),
        },
      },
      layers: [
        {
          id: `${prefix}fill`,
          type: 'fill',
          source,
          'source-layer': SOILS_SOURCE_LAYER,
          minzoom: row.minzoom,
          paint: {
            'fill-color': drainageColorExpression(),
            'fill-opacity': flavor === 'dark' ? 0.55 : 0.45,
          },
        },
        {
          id: `${prefix}outline`,
          type: 'line',
          source,
          'source-layer': SOILS_SOURCE_LAYER,
          minzoom: row.minzoom,
          paint: {
            'line-color': flavor === 'dark' ? 'rgba(255,255,255,0.55)' : 'rgba(68,48,20,0.6)',
            'line-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              10,
              0.4,
              16,
              variant === 'wall' ? 2 : 1.5,
            ] as unknown as number,
          },
        },
      ],
    };
  },
};
