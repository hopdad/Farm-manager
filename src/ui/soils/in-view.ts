/**
 * "In this view": the soil map units drawn on screen, like Web Soil Survey's Map Unit Legend
 * (soil map Phase A; pure, unit-tested). Owner: soils. The rail lists them under the soils
 * legend, with the swatch of the chosen mode; ./useSoilsInView.ts feeds it from the map.
 */
import { type MapUnitPreview, MUKEY_RE, previewOf } from './map-unit';

/** Rows shown before "and N more" (zoom in for the rest). */
export const IN_VIEW_MAX_ROWS = 30;

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
