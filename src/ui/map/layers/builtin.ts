/**
 * Layer defs for what the M0 map already draws, so the rail can toggle them (contract:
 * ./types.ts): the field boundaries (base-style layers), the live fleet (deck.gl, external) and
 * the custom-work customers outline (over the fields tiles, which carry client_id / client).
 */
import { MACHINE_KINDS } from '../../../domain/fleet';
import { DOWN_COLOR, KIND_COLORS, KIND_LABELS, STALE_RING_COLOR } from '../fleet/style';
import {
  FIELD_LAYER_IDS,
  FIELDS_LABEL_SOURCE_LAYER,
  FIELDS_SOURCE,
  FIELDS_SOURCE_LAYER,
  TENURE_COLORS,
  TENURE_LABELS,
} from '../style';
import type { ExternalLayerDef, MapLibreLayerDef, StyleLayerDef } from './types';
import { layerIdPrefix } from './types';

export const fieldsLayer: StyleLayerDef = {
  key: 'fields',
  render: 'style',
  group: 'fields',
  label: 'Field boundaries',
  // What the colours mean, under the toggle (the rail covers the map's own legend on the wall).
  legend: {
    items: (Object.keys(TENURE_COLORS) as (keyof typeof TENURE_COLORS)[]).map((t) => ({
      label: TENURE_LABELS[t],
      swatch: 'fill' as const,
      color: TENURE_COLORS[t],
    })),
  },
  kind: 'vector',
  offline: true,
  cachePolicy: 'private',
  defaultVisible: true,
  order: 10,
  styleLayerIds: [FIELD_LAYER_IDS.fill, FIELD_LAYER_IDS.outline, FIELD_LAYER_IDS.label],
  styleSourceId: FIELDS_SOURCE,
};

/** The deck.gl fleet: WarRoomMap's owner hides it when `useLayerVisible('fleet', true)` is false. */
export const fleetLayer: ExternalLayerDef = {
  key: 'fleet',
  render: 'external',
  group: 'fleet',
  label: 'Machines and trucks',
  legend: {
    items: [
      ...MACHINE_KINDS.map((k) => ({
        label: KIND_LABELS[k],
        swatch: 'point' as const,
        color: KIND_COLORS[k],
      })),
      { label: 'Stale (no recent position)', swatch: 'point', color: STALE_RING_COLOR },
      { label: 'Down for repair', swatch: 'point', color: DOWN_COLOR },
    ],
  },
  kind: 'vector',
  offline: true,
  cachePolicy: 'private',
  defaultVisible: true,
  order: 10,
};

export const CUSTOMER_OUTLINE_COLOR = '#f97316';

/**
 * Custom-work customers: a heavy outline and the customer's name on fields whose farm has a
 * client (reuses the fields source; no extra tiles, no registry row).
 */
export const customersLayer: MapLibreLayerDef = {
  key: 'customers',
  render: 'maplibre',
  group: 'customers',
  label: 'Custom-work customers',
  legend: {
    items: [{ label: 'Customer field', swatch: 'line', color: CUSTOMER_OUTLINE_COLOR }],
  },
  kind: 'vector',
  offline: true,
  cachePolicy: 'private',
  defaultVisible: false,
  order: 10,
  requiresRow: false,
  anchor: 'top',
  minzoom: 8,
  maxzoom: 22,
  spec: ({ variant, flavor }) => ({
    sources: {},
    layers: [
      {
        id: `${layerIdPrefix('customers')}outline`,
        type: 'line',
        source: FIELDS_SOURCE,
        'source-layer': FIELDS_SOURCE_LAYER,
        filter: ['has', 'client_id'],
        paint: {
          'line-color': CUSTOMER_OUTLINE_COLOR,
          'line-width': variant === 'wall' ? 4 : 3,
        },
      },
      {
        // One point per field (not per tile): one customer name per field.
        id: `${layerIdPrefix('customers')}label`,
        type: 'symbol',
        source: FIELDS_SOURCE,
        'source-layer': FIELDS_LABEL_SOURCE_LAYER,
        filter: ['has', 'client'],
        minzoom: 11,
        layout: {
          'text-field': ['get', 'client'],
          'text-font': ['Noto Sans Medium'],
          'text-size': variant === 'wall' ? 16 : 13,
          'text-offset': [0, 1.6],
        },
        paint: {
          'text-color': CUSTOMER_OUTLINE_COLOR,
          'text-halo-color': flavor === 'dark' ? '#0b1210' : '#ffffff',
          'text-halo-width': 1.5,
        },
      },
    ],
  }),
};
