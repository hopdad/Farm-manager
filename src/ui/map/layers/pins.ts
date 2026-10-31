/**
 * The `pins` layer (slice 1f, docs/contracts-1f.md §5.2; owner: deere-data): "Deere flags" in
 * the rail's Fields group, read-only pins from Operations Center (rocks, wet holes, tile
 * blowouts …) as points, lines and polygons coloured by kind. `spec()` is pure: one GeoJSON
 * source `layer:pins` with an EMPTY FeatureCollection; the mounted pins component
 * (src/ui/pins/DeerePins.tsx) fills it from GET /api/pins with setData (on mount, on
 * `pins`/`updated`, on resync, and again when applyLayers re-adds the source). Every feature
 * carries `properties.id` (the pin's uuid): WarRoomMap's tap seam hands taps on `layer:pins:*`
 * to the pin popup.
 */
import type { ExpressionSpecification } from 'maplibre-gl';
import { PIN_KINDS } from '../../../domain/pins';
import { PIN_KIND_COLORS, PIN_KIND_LABELS } from '../../pins/model';
import { layerIdPrefix, layerSourceId, type MapLibreLayerDef } from './types';

export const PINS_LAYER_KEY = 'pins';
export const PINS_SOURCE_ID = layerSourceId(PINS_LAYER_KEY);
const P = layerIdPrefix(PINS_LAYER_KEY);
export const PINS_LAYER_IDS = {
  polygons: `${P}polygons`,
  polygonOutline: `${P}polygon-outline`,
  lines: `${P}lines`,
  points: `${P}points`,
} as const;

/** The pin's colour (the feature carries it; the kind table is the fallback). */
const BY_KIND = [
  'match',
  ['get', 'kind'],
  ...PIN_KINDS.flatMap((k) => [k, PIN_KIND_COLORS[k]]),
  PIN_KIND_COLORS.note,
] as unknown as ExpressionSpecification;
const COLOR: ExpressionSpecification = ['coalesce', ['get', 'color'], BY_KIND];

export const pinsLayer: MapLibreLayerDef = {
  key: PINS_LAYER_KEY,
  render: 'maplibre',
  group: 'fields',
  label: 'Deere flags',
  legend: {
    title: 'Deere flags (read-only)',
    items: PIN_KINDS.map((k) => ({
      label: PIN_KIND_LABELS[k],
      swatch: 'point' as const,
      color: PIN_KIND_COLORS[k],
    })),
    note: 'Flags dropped in Operations Center; edit them there',
  },
  kind: 'vector',
  offline: true,
  cachePolicy: 'private',
  defaultVisible: true,
  order: 30,
  requiresRow: false,
  anchor: 'top',
  minzoom: 10,
  maxzoom: 24,
  spec: ({ flavor, variant }) => {
    const stroke = flavor === 'dark' ? '#0b1210' : '#ffffff';
    const radius = variant === 'wall' ? 9 : 7;
    return {
      sources: {
        [PINS_SOURCE_ID]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        {
          id: PINS_LAYER_IDS.polygons,
          type: 'fill',
          source: PINS_SOURCE_ID,
          minzoom: 10,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': COLOR, 'fill-opacity': 0.35 },
        },
        {
          id: PINS_LAYER_IDS.polygonOutline,
          type: 'line',
          source: PINS_SOURCE_ID,
          minzoom: 10,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'line-color': COLOR, 'line-width': 2 },
        },
        {
          id: PINS_LAYER_IDS.lines,
          type: 'line',
          source: PINS_SOURCE_ID,
          minzoom: 10,
          filter: ['==', ['geometry-type'], 'LineString'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': COLOR, 'line-width': variant === 'wall' ? 5 : 4 },
        },
        {
          id: PINS_LAYER_IDS.points,
          type: 'circle',
          source: PINS_SOURCE_ID,
          minzoom: 10,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-color': COLOR,
            'circle-radius': radius,
            'circle-stroke-color': stroke,
            'circle-stroke-width': 2.5,
          },
        },
      ],
    };
  },
};
