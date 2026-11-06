/**
 * The drag hover highlight: while a job card is dragged over the map, the field under the
 * pointer is outlined (docs/contracts-2a.md §7.1; the pattern of src/ui/fields/highlight.ts,
 * under the board's own layer ids DROP_HOVER_LAYER_IDS, never the field panel's). Pure helpers
 * over a minimal map interface (./hover.test.ts uses a fake). Plain style layers over the fields
 * source, filtered to one field; added when a drag starts, removed when it ends.
 */
import type { FilterSpecification, LayerSpecification } from 'maplibre-gl';
import { FIELD_LAYER_IDS, FIELDS_SOURCE, FIELDS_SOURCE_LAYER } from '../../map/style';
import { DROP_HOVER_LAYER_IDS } from '../style';

export const DROP_HOVER_COLOR = '#38bdf8';

/** The part of maplibre-gl's Map these helpers use. */
export interface HoverMap {
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: LayerSpecification, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  setFilter(layerId: string, filter: FilterSpecification | null): unknown;
}

/** Matches no feature (an empty-string id never exists). */
const NONE = '';

export function hoverFilter(fieldId: string | null): FilterSpecification {
  return ['==', ['get', 'id'], fieldId ?? NONE];
}

export function dropHoverLayers(fieldId: string | null, wide: boolean): LayerSpecification[] {
  const filter = hoverFilter(fieldId);
  return [
    {
      id: DROP_HOVER_LAYER_IDS.fill,
      type: 'fill',
      source: FIELDS_SOURCE,
      'source-layer': FIELDS_SOURCE_LAYER,
      filter,
      paint: { 'fill-color': DROP_HOVER_COLOR, 'fill-opacity': 0.3 },
    },
    {
      id: DROP_HOVER_LAYER_IDS.line,
      type: 'line',
      source: FIELDS_SOURCE,
      'source-layer': FIELDS_SOURCE_LAYER,
      filter,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': DROP_HOVER_COLOR, 'line-width': wide ? 6 : 4 },
    },
  ];
}

/**
 * Show the hover highlight on `fieldId` (null: the layers stay, matching nothing). Idempotent;
 * a no-op before the fields source exists. Returns whether the layers are on the map.
 */
export function showDropHover(map: HoverMap, fieldId: string | null, wide: boolean): boolean {
  if (!map.getSource(FIELDS_SOURCE)) return false;
  const filter = hoverFilter(fieldId);
  for (const layer of dropHoverLayers(fieldId, wide)) {
    if (map.getLayer(layer.id)) {
      map.setFilter(layer.id, filter);
    } else {
      const before = map.getLayer(FIELD_LAYER_IDS.label) ? FIELD_LAYER_IDS.label : undefined;
      map.addLayer(layer, before);
    }
  }
  return true;
}

export function removeDropHover(map: HoverMap): void {
  for (const id of [DROP_HOVER_LAYER_IDS.line, DROP_HOVER_LAYER_IDS.fill]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
}
