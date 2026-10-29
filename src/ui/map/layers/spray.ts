/**
 * The `spray` layer (docs/contracts-m1.md §7.3; plan 1b done-when "moving the sim's wind slider
 * flips field colors with reasons"): field fills coloured by the current hour's spray verdict.
 * It draws on the fields tiles (FIELDS_SOURCE, `promoteId: 'id'`; no source or registry row of
 * its own) and reads the verdict from FEATURE STATE, which SprayFieldState
 * (src/ui/weather/SprayFieldState.tsx) sets from GET /api/weather/spray. A field without a
 * verdict stays clear. Advisory: the legend says so. Off by default; on from the layer rail or
 * the weather strip's spray button (both write the visibility store).
 */
import type { ExpressionSpecification } from 'maplibre-gl';
import { SPRAY_COLORS } from '../../weather/format';
import { FIELDS_SOURCE, FIELDS_SOURCE_LAYER } from '../style';
import { layerIdPrefix, type MapLibreLayerDef } from './types';

export const SPRAY_LAYER_KEY = 'spray';
export const SPRAY_FILL_LAYER_ID = `${layerIdPrefix(SPRAY_LAYER_KEY)}fill`;

/** fill-color by feature state `verdict` (go / caution / no_go), transparent otherwise. */
export const SPRAY_FILL_COLOR: ExpressionSpecification = [
  'match',
  ['feature-state', 'verdict'],
  'go',
  SPRAY_COLORS.go,
  'caution',
  SPRAY_COLORS.caution,
  'no_go',
  SPRAY_COLORS.no_go,
  'rgba(0,0,0,0)',
];

export const sprayLayer: MapLibreLayerDef = {
  key: SPRAY_LAYER_KEY,
  render: 'maplibre',
  group: 'fields',
  label: 'Spray go/no-go (advisory)',
  legend: {
    title: 'Spray now (advisory)',
    items: [
      { label: 'Go', swatch: 'fill', color: SPRAY_COLORS.go },
      { label: 'Caution', swatch: 'fill', color: SPRAY_COLORS.caution },
      { label: 'No-go', swatch: 'fill', color: SPRAY_COLORS.no_go },
    ],
    note: 'Advisory: wind, gusts, rain-free hours and an inversion heuristic against the thresholds on /admin/spray',
  },
  kind: 'vector',
  offline: true,
  cachePolicy: 'private',
  defaultVisible: false,
  order: 20,
  requiresRow: false,
  anchor: 'below-labels',
  minzoom: 0,
  maxzoom: 24,
  spec: ({ flavor }) => ({
    sources: {},
    layers: [
      {
        id: SPRAY_FILL_LAYER_ID,
        type: 'fill',
        source: FIELDS_SOURCE,
        'source-layer': FIELDS_SOURCE_LAYER,
        paint: {
          'fill-color': SPRAY_FILL_COLOR,
          'fill-opacity': flavor === 'dark' ? 0.55 : 0.45,
        },
      },
    ],
  }),
};
