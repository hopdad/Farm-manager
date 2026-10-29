/**
 * The parcels layer (plan 1d "Parcels import (D7) and private MVT with owner names"; contract
 * ./types.ts, docs/contracts-m1.md §7.3). Owner: imagery. Parcel lines from the PRIVATE `parcels`
 * MVT (app.mvt_parcels, z12+), drawn over the field fills so a parcel line crossing a field shows,
 * with a faint fill (so a tap can pick a parcel) and a label at close zoom: the owner where the
 * tiles carry one (managers and owners only: the tiles route leaves owner names out for other
 * roles), else the parcel number.
 *
 * Needs its gis.map_layers row (migration 0003 inserts it, private); the data comes from
 * `pnpm gis:parcels <file>` or, until a county file arrives (D7), `pnpm gis:parcels --fixture`.
 */
import type { ExpressionSpecification } from 'maplibre-gl';
import type { LayerLegend } from '../../../domain/map-layers';
import { absoluteUrl, layerIdPrefix, layerSourceId, type MapLibreLayerDef } from './types';

export const PARCELS_LAYER_KEY = 'parcels';
/** The MVT layer name inside the tiles (app.mvt_parcels). */
export const PARCELS_SOURCE_LAYER = 'parcels';

export const PARCEL_LINE_COLOR = '#e879f9';
export const PARCEL_LINE_COLOR_LIGHT = '#a21caf';

export const PARCELS_LEGEND: LayerLegend = {
  items: [{ label: 'Tax parcel', swatch: 'line', color: PARCEL_LINE_COLOR }],
  note: 'Owner names for managers only. D7: synthetic demo parcels until a county file arrives.',
};

/** Label: the owner when the tile has one, else the parcel number. */
export const PARCEL_LABEL: ExpressionSpecification = [
  'coalesce',
  ['get', 'owner_name'],
  ['get', 'parcel_no'],
];

export const parcelsLayer: MapLibreLayerDef = {
  key: PARCELS_LAYER_KEY,
  render: 'maplibre',
  group: 'parcels',
  label: 'Tax parcels',
  legend: PARCELS_LEGEND,
  kind: 'vector',
  offline: true,
  cachePolicy: 'private',
  defaultVisible: false,
  order: 10,
  requiresRow: true,
  buildHint: 'Run pnpm gis:parcels <county file> (or --fixture for the demo parcels)',
  anchor: 'below-labels',
  minzoom: 12,
  maxzoom: 22,
  spec: ({ origin, row, flavor, variant }) => {
    if (!row) return { sources: {}, layers: [] };
    const source = layerSourceId(PARCELS_LAYER_KEY);
    const prefix = layerIdPrefix(PARCELS_LAYER_KEY);
    const line = flavor === 'dark' ? PARCEL_LINE_COLOR : PARCEL_LINE_COLOR_LIGHT;
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
          id: `${prefix}fill`,
          type: 'fill',
          source,
          'source-layer': PARCELS_SOURCE_LAYER,
          minzoom: row.minzoom,
          paint: { 'fill-color': line, 'fill-opacity': 0.04 },
        },
        {
          id: `${prefix}line`,
          type: 'line',
          source,
          'source-layer': PARCELS_SOURCE_LAYER,
          minzoom: row.minzoom,
          paint: {
            'line-color': line,
            'line-dasharray': [3, 2],
            'line-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              12,
              1,
              16,
              variant === 'wall' ? 3 : 2,
            ] as unknown as number,
          },
        },
        {
          id: `${prefix}label`,
          type: 'symbol',
          source,
          'source-layer': PARCELS_SOURCE_LAYER,
          minzoom: 14,
          layout: {
            'text-field': PARCEL_LABEL,
            'text-font': ['Noto Sans Regular'],
            'text-size': variant === 'wall' ? 15 : 12,
            'text-max-width': 10,
            'symbol-placement': 'point',
          },
          paint: {
            'text-color': line,
            'text-halo-color': flavor === 'dark' ? '#0b1210' : '#ffffff',
            'text-halo-width': 1.5,
          },
        },
      ],
    };
  },
};
