/**
 * "In this view": the soil map units drawn on screen, like Web Soil Survey's Map Unit Legend
 * (soil map Phase A; pure, unit-tested). Owner: soils. The rail lists them under the soils
 * legend, with the swatch of the chosen mode; ./useSoilsInView.ts feeds it from the map.
 */
import { SOILS_IDS } from '../map/layers/soils';
import { type MapUnitPreview, MUKEY_RE, previewOf } from './map-unit';

/** Rows shown before "and N more" (zoom in for the rest). */
export const IN_VIEW_MAX_ROWS = 30;

/**
 * The list starts at this zoom. Further out the screen holds most of a county: tens of
 * thousands of real soil polygons, and reading them all off the map (about 20-30 µs each)
 * would stall the wall for half a second after every pan, for a list cut at 30 rows anyway.
 */
export const IN_VIEW_MIN_ZOOM = 12;

/** Natural order of map unit symbols: 'BnB' < 'BnC2' < 'Pe' < 'W'; '2B' < '10B'. */
export function compareSymbols(a: string | null | undefined, b: string | null | undefined): number {
  return (a ?? '').localeCompare(b ?? '', 'en', { numeric: true, sensitivity: 'base' });
}

/**
 * Distinct map units among rendered features (a polygon cut by tile edges is several features;
 * a map unit is many polygons), by symbol then name.
 */
export function unitsInView(
  features: readonly { properties: Record<string, unknown> | null }[],
): MapUnitPreview[] {
  const byKey = new Map<string, MapUnitPreview>();
  for (const f of features) {
    const u = previewOf(f.properties);
    if (u && MUKEY_RE.test(u.mukey) && !byKey.has(u.mukey)) byKey.set(u.mukey, u);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      compareSymbols(a.musym, b.musym) ||
      (a.muname ?? '').localeCompare(b.muname ?? '') ||
      a.mukey.localeCompare(b.mukey),
  );
}

/** Same units in the same order (avoids a re-render when the view didn't change them). */
export function sameUnits(
  a: readonly MapUnitPreview[] | null,
  b: readonly MapUnitPreview[],
): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((u, i) => u.mukey === b[i]?.mukey);
}

/** What readUnitsInView needs of a MapLibre map. */
export interface InViewMap {
  getZoom(): number;
  getLayer(id: string): unknown;
  queryRenderedFeatures(options: {
    layers: string[];
  }): { properties: Record<string, unknown> | null }[];
}

/** The rail's "In this view": the map units on screen, or "zoom in" (nothing read then). */
export type InView = { status: 'zoom-in' } | { status: 'ready'; units: MapUnitPreview[] };

/** Read the map units drawn on screen; below IN_VIEW_MIN_ZOOM, don't (see there). */
export function readUnitsInView(map: InViewMap): InView {
  if (map.getZoom() < IN_VIEW_MIN_ZOOM - 1e-9) return { status: 'zoom-in' };
  if (!map.getLayer(SOILS_IDS.fill)) return { status: 'ready', units: [] };
  return {
    status: 'ready',
    units: unitsInView(map.queryRenderedFeatures({ layers: [SOILS_IDS.fill] })),
  };
}

/** The same answer (avoids a re-render when a settle changed nothing). */
export function sameInView(a: InView | null, b: InView): boolean {
  if (!a || a.status !== b.status) return false;
  return a.status === 'zoom-in' || b.status === 'zoom-in' || sameUnits(a.units, b.units);
}
