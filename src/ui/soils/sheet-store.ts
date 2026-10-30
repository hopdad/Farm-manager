/**
 * Which soil map unit the sheet shows (soil map Phase A). One store per tab, so a tap on the map
 * (BoardScreen, WarRoomMap's onEmptyTap), a row of the field Soils tab, or the rail's in-view
 * list can open the same sheet without threading props. Owner: soils.
 */
import { create } from 'zustand';
import { SOILS_IDS } from '../map/layers/soils';
import { type MapUnitPreview, previewOf } from './map-unit';

export interface MapUnitSheetState {
  /** The open map unit (what the sheet shows until its detail loads), or null. */
  current: MapUnitPreview | null;
  show(unit: MapUnitPreview): void;
  close(): void;
}

export const useMapUnitSheet = create<MapUnitSheetState>()((set) => ({
  current: null,
  show: (unit) => set({ current: unit }),
  close: () => set((s) => (s.current ? { current: null } : s)),
}));

/** What mapUnitAt needs of a MapLibre map. */
export interface QueryableMap {
  getLayer(id: string): unknown;
  project(lngLat: [number, number]): { x: number; y: number };
  queryRenderedFeatures(
    point: [number, number],
    options: { layers: string[] },
  ): { properties: Record<string, unknown> | null }[];
}

/**
 * The soil map unit drawn at a point of the map (the soils fill, also there, transparent, in
 * the Soil type mode), or null: soils not drawn here, or not on the map.
 */
export function mapUnitAt(
  map: QueryableMap,
  lngLat: { lng: number; lat: number },
): MapUnitPreview | null {
  if (!map.getLayer(SOILS_IDS.fill)) return null;
  const p = map.project([lngLat.lng, lngLat.lat]);
  const hit = map.queryRenderedFeatures([p.x, p.y], { layers: [SOILS_IDS.fill] });
  return previewOf(hit[0]?.properties);
}
