/**
 * `window.__map`: a test-only view of the map for Playwright (plan §7 "Touch specifics": assert
 * through center, zoom, queryRenderedFeatures and deck layer data, not pixels). Installed only
 * when APP_ENV is not production. Everything returned is plain JSON.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FleetFrame } from './fleet/model';

export interface RenderedFeature {
  layer: string;
  source: string;
  sourceLayer: string | undefined;
  geometryType: string;
  properties: Record<string, unknown>;
}

export interface MapTestApi {
  /** Style and first tiles loaded. */
  loaded(): boolean;
  /** Resolves on the next 'idle' (everything requested has rendered). */
  idle(timeoutMs?: number): Promise<boolean>;
  center(): { lng: number; lat: number };
  zoom(): number;
  bearing(): number;
  pitch(): number;
  jumpTo(opts: { center?: [number, number]; zoom?: number; bearing?: number }): void;
  /** Screen position (CSS pixels, relative to the viewport) of a WGS84 point. */
  project(lng: number, lat: number): { x: number; y: number };
  layerIds(): string[];
  queryRenderedFeatures(opts?: { layers?: string[] }): RenderedFeature[];
  /** deck.gl layers and their data as last drawn. */
  deckLayers(): { id: string; data: unknown[] }[];
  /** The fleet as drawn in the latest frame (interpolated positions, stale flags). */
  fleet(): FleetFrame[];
  /** Map errors seen so far (tile, style and glyph failures). */
  errors(): string[];
}

declare global {
  interface Window {
    __map?: MapTestApi;
  }
}

export function installMapTestApi(
  map: MapLibreMap,
  sources: {
    deckLayers(): { id: string; data: unknown[] }[];
    fleet(): FleetFrame[];
    errors(): string[];
  },
): () => void {
  const api: MapTestApi = {
    loaded: () => map.loaded() && map.isStyleLoaded() !== false,
    idle: (timeoutMs = 10_000) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        map.once('idle', () => {
          clearTimeout(timer);
          resolve(true);
        });
        map.triggerRepaint();
      }),
    center: () => {
      const c = map.getCenter();
      return { lng: c.lng, lat: c.lat };
    },
    zoom: () => map.getZoom(),
    bearing: () => map.getBearing(),
    pitch: () => map.getPitch(),
    jumpTo: (opts) => map.jumpTo(opts),
    project: (lng, lat) => {
      const p = map.project([lng, lat]);
      const r = map.getContainer().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    },
    layerIds: () => map.getStyle().layers.map((l) => l.id),
    queryRenderedFeatures: (opts) =>
      map.queryRenderedFeatures(opts?.layers ? { layers: opts.layers } : undefined).map((f) => ({
        layer: f.layer.id,
        source: f.source,
        sourceLayer: f.sourceLayer,
        geometryType: f.geometry.type,
        properties: { ...f.properties },
      })),
    deckLayers: sources.deckLayers,
    fleet: sources.fleet,
    errors: sources.errors,
  };
  window.__map = api;
  return () => {
    if (window.__map === api) delete window.__map;
  };
}
