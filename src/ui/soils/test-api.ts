/**
 * `window.__soils`: a test-only view of the soils layer's styling for Playwright (soil map
 * Phase A), next to `window.__map` (../map/test-api.ts), which has no paint getter. The layer
 * rail installs it outside production. Everything returned is plain JSON.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MapUnitPreview } from './map-unit';
import { mapUnitAt } from './sheet-store';

export interface SoilsTestApi {
  /** A layer's paint property as the map holds it now (null when the layer is absent). */
  paint(layerId: string, name: string): unknown;
  /** A layer's filter (null when absent or unfiltered). */
  filter(layerId: string): unknown;
  /** Ids of the style's layers, in draw order (bottom first). */
  order(): string[];
  /** The map unit a tap at this point would open (what the board's empty tap uses), or null. */
  unitAt(lng: number, lat: number): MapUnitPreview | null;
}

declare global {
  interface Window {
    __soils?: SoilsTestApi;
  }
}

const json = (x: unknown) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

export function installSoilsTestApi(map: MapLibreMap): () => void {
  const api: SoilsTestApi = {
    paint: (id, name) =>
      map.getLayer(id) ? json(map.getPaintProperty(id, name as 'fill-color')) : null,
    filter: (id) => (map.getLayer(id) ? json(map.getFilter(id)) : null),
    order: () => (map.getStyle()?.layers ?? []).map((l) => l.id),
    unitAt: (lng, lat) => json(mapUnitAt(map, { lng, lat })),
  };
  window.__soils = api;
  return () => {
    if (window.__soils === api) delete window.__soils;
  };
}
