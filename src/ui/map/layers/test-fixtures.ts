/** Shared fixtures for the layer contract tests (a soils-like def and registry rows). */
import type { ResolvedMapLayer } from '../../../domain/map-layers';
import { absoluteUrl, type MapLibreLayerDef } from './types';

export function row(key: string, over: Partial<ResolvedMapLayer> = {}): ResolvedMapLayer {
  return {
    key,
    kind: 'mvt',
    urlOrKey: `/api/tiles/${key}`,
    version: 'v1',
    cachePolicy: 'public',
    minzoom: 10,
    maxzoom: 16,
    attribution: null,
    legend: null,
    sourceVintage: null,
    builtAt: null,
    defaultVisible: false,
    meta: {},
    url: `/api/tiles/${key}/{z}/{x}/{y}?v=v1`,
    ...over,
  };
}

export const soilsDef: MapLibreLayerDef = {
  key: 'soils',
  render: 'maplibre',
  group: 'soils',
  label: 'Soils',
  legend: { items: [{ label: 'Map unit', swatch: 'line', color: '#a16207' }] },
  kind: 'vector',
  offline: true,
  cachePolicy: 'public',
  defaultVisible: false,
  order: 10,
  requiresRow: true,
  buildHint: 'run pnpm gis:soils',
  anchor: 'below-fields',
  minzoom: 10,
  maxzoom: 22,
  spec: ({ origin, row: r }) => ({
    sources: {
      'layer:soils': { type: 'vector', tiles: [absoluteUrl(origin, r?.url ?? '')], maxzoom: 16 },
    },
    layers: [
      {
        id: 'layer:soils:line',
        type: 'line',
        source: 'layer:soils',
        'source-layer': 'soils',
        paint: { 'line-color': '#a16207' },
      },
    ],
  }),
};
