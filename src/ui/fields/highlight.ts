/**
 * The open field on the map (pure helpers over a minimal map interface; unit-tested with a fake):
 *
 *  - `applyHighlight(map, fieldId, variant)`: a dark casing and a bright outline plus a light
 *    fill over the fields source, filtered to the one field, just under the field names. Plain
 *    style layers (not `layer:` ids), so the rail's applyLayers leaves them alone. Idempotent:
 *    call it on every change and on `styledata` (a style reload drops imperatively added layers).
 *  - `tilePreview(map, fieldId)`: name, acres and tenure from the fields tiles already loaded,
 *    so the panel's header is filled the instant it opens (the full detail follows).
 *  - `revealBounds(...)`: whether the boundary is hidden behind the panel or off screen, and the
 *    padding to fit it into what the panel leaves free.
 */
import type { FilterSpecification, LayerSpecification } from 'maplibre-gl';
import { TENURES, type Tenure } from '../../domain/farm';
import { FIELD_LAYER_IDS, FIELDS_SOURCE, FIELDS_SOURCE_LAYER } from '../map/style';

export const HIGHLIGHT_LAYER_IDS = {
  fill: 'field-panel-selected-fill',
  casing: 'field-panel-selected-casing',
  line: 'field-panel-selected-line',
} as const;

export const HIGHLIGHT_COLOR = '#facc15';
const CASING_COLOR = '#0b1210';

export type PanelVariant = 'wall' | 'phone';

/** The part of maplibre-gl's Map these helpers use. */
export interface HighlightMap {
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: LayerSpecification, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  setFilter(layerId: string, filter: FilterSpecification | null): unknown;
}

export function highlightFilter(fieldId: string): FilterSpecification {
  return ['==', ['get', 'id'], fieldId];
}

/** The three layers, bottom to top. */
export function highlightLayers(fieldId: string, variant: PanelVariant): LayerSpecification[] {
  const filter = highlightFilter(fieldId);
  const wide = variant === 'wall' ? 9 : 7;
  const thin = variant === 'wall' ? 5 : 4;
  return [
    {
      id: HIGHLIGHT_LAYER_IDS.fill,
      type: 'fill',
      source: FIELDS_SOURCE,
      'source-layer': FIELDS_SOURCE_LAYER,
      filter,
      paint: { 'fill-color': HIGHLIGHT_COLOR, 'fill-opacity': 0.18 },
    },
    {
      id: HIGHLIGHT_LAYER_IDS.casing,
      type: 'line',
      source: FIELDS_SOURCE,
      'source-layer': FIELDS_SOURCE_LAYER,
      filter,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': CASING_COLOR, 'line-width': wide, 'line-opacity': 0.85 },
    },
    {
      id: HIGHLIGHT_LAYER_IDS.line,
      type: 'line',
      source: FIELDS_SOURCE,
      'source-layer': FIELDS_SOURCE_LAYER,
      filter,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': HIGHLIGHT_COLOR, 'line-width': thin },
    },
  ];
}

/** Show `fieldId` highlighted (or nothing when null). Safe before the fields source exists. */
export function applyHighlight(
  map: HighlightMap,
  fieldId: string | null,
  variant: PanelVariant,
): void {
  if (fieldId === null || !map.getSource(FIELDS_SOURCE)) {
    removeHighlight(map);
    return;
  }
  // Just under the field names (the top layer of the base style), so they stay readable.
  const before = map.getLayer(FIELD_LAYER_IDS.label) ? FIELD_LAYER_IDS.label : undefined;
  for (const layer of highlightLayers(fieldId, variant)) {
    if (map.getLayer(layer.id)) {
      map.setFilter(layer.id, highlightFilter(fieldId));
    } else {
      map.addLayer(layer, before);
    }
  }
}

export function removeHighlight(map: HighlightMap): void {
  for (const id of Object.values(HIGHLIGHT_LAYER_IDS)) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
}

export interface TilePreview {
  name: string;
  acres: number | null;
  tenure: Tenure | null;
}

/** The part of maplibre-gl's Map tilePreview uses. */
export interface PreviewMap {
  getSource(id: string): unknown;
  querySourceFeatures(
    sourceId: string,
    params: { sourceLayer: string; filter: FilterSpecification },
  ): { properties: Record<string, unknown> | null }[];
}

/** What the loaded fields tiles say about the field (null when none of its tiles are loaded). */
export function tilePreview(map: PreviewMap, fieldId: string): TilePreview | null {
  if (!map.getSource(FIELDS_SOURCE)) return null;
  let features: { properties: Record<string, unknown> | null }[];
  try {
    features = map.querySourceFeatures(FIELDS_SOURCE, {
      sourceLayer: FIELDS_SOURCE_LAYER,
      filter: highlightFilter(fieldId),
    });
  } catch {
    return null;
  }
  const p = features[0]?.properties;
  if (!p || typeof p.name !== 'string') return null;
  const acres = typeof p.acres === 'number' && Number.isFinite(p.acres) ? p.acres : null;
  const tenure = (TENURES as readonly string[]).includes(String(p.tenure))
    ? (p.tenure as Tenure)
    : null;
  return { name: p.name, acres, tenure };
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Breathing room around the boundary when it is fitted into view. */
export const REVEAL_MARGIN = 32;

/**
 * The map padding that keeps clear of the panel: on the wall the panel covers the map's right
 * side, on phones the sheet covers its bottom. Rects are in viewport px.
 */
export function panelPadding(map: Rect, panel: Rect | null, variant: PanelVariant): Padding {
  const p = {
    top: REVEAL_MARGIN,
    right: REVEAL_MARGIN,
    bottom: REVEAL_MARGIN,
    left: REVEAL_MARGIN,
  };
  if (!panel) return p;
  if (variant === 'wall') p.right += Math.max(0, map.right - panel.left);
  else p.bottom += Math.max(0, map.bottom - panel.top);
  return p;
}

/**
 * Should the map move to show the boundary? `corners` are the boundary's bbox corners in the
 * map container's px; true when any lies outside the area the padding leaves free. Never when
 * that area is too small to be useful (a tiny window).
 */
export function needsReveal(
  size: { width: number; height: number },
  padding: Padding,
  corners: { x: number; y: number }[],
): boolean {
  const free = {
    left: padding.left,
    top: padding.top,
    right: size.width - padding.right,
    bottom: size.height - padding.bottom,
  };
  if (free.right - free.left < 80 || free.bottom - free.top < 80) return false;
  return corners.some(
    (c) => c.x < free.left || c.x > free.right || c.y < free.top || c.y > free.bottom,
  );
}
