/**
 * The 1-mile section grid the M0 world is generated on (plan §5: "quarter- and half-quarter-
 * section rectangles on the 1-mile grid, with no download").
 *
 * Grid lines are true meridians and parallels spaced one statute mile apart at the farm's
 * latitude (41.9 N), counted from (approximately) the Michigan Meridian and the Michigan survey
 * base line, so the cells read like PLSS sections. Real section lines carry survey corrections;
 * this grid doesn't (1e swaps in real field shapes).
 *
 * Grid coordinates (gi, gj): gi = miles east of the meridian, gj = miles north of the base line
 * (negative down here). Section (i, j) spans [i, i+1] x [j, j+1]; its north line is j + 1.
 */
import { MILE_M, metresPerDegree } from '../geo/lnglat';
import type { LngLat } from '../types';

/** Approximate Michigan Meridian (84 deg 21' 53" W) and base line (42 deg 25' 28" N). */
export const MICHIGAN_MERIDIAN_LNG = -84.36472;
export const MICHIGAN_BASE_LINE_LAT = 42.42444;
/** Latitude the mile spacing is computed at (the middle of the demo area). */
export const GRID_REF_LAT = 41.9;

const M_PER_DEG = metresPerDegree(GRID_REF_LAT);
/** Degrees of latitude per mile. */
export const SECTION_DLAT = MILE_M / M_PER_DEG.lat;
/** Degrees of longitude per mile at GRID_REF_LAT. */
export const SECTION_DLNG = MILE_M / M_PER_DEG.lng;

/** Grid coordinates -> [lng, lat]. */
export function gridToLngLat(gi: number, gj: number): LngLat {
  return [MICHIGAN_MERIDIAN_LNG + gi * SECTION_DLNG, MICHIGAN_BASE_LINE_LAT + gj * SECTION_DLAT];
}

/** [lng, lat] -> fractional grid coordinates. */
export function lngLatToGrid(p: LngLat): { gi: number; gj: number } {
  return {
    gi: (p[0] - MICHIGAN_MERIDIAN_LNG) / SECTION_DLNG,
    gj: (p[1] - MICHIGAN_BASE_LINE_LAT) / SECTION_DLAT,
  };
}

/** Section the point is in. */
export function sectionOf(p: LngLat): { i: number; j: number } {
  const g = lngLatToGrid(p);
  return { i: Math.floor(g.gi), j: Math.floor(g.gj) };
}

/** Grid-units rectangle [gi0, gi1] x [gj0, gj1]. */
export interface GridRect {
  gi0: number;
  gi1: number;
  gj0: number;
  gj1: number;
}

export type QuarterName = 'NE' | 'NW' | 'SE' | 'SW';
export type HalfName = 'N' | 'S' | 'E' | 'W';

/** A quarter (160 ac) or half-quarter (80 ac) of section (i, j). */
export interface Aliquot {
  i: number;
  j: number;
  quarter: QuarterName;
  /** Half of the quarter, or undefined for the whole quarter. */
  half?: HalfName;
}

export function aliquotRect(a: Aliquot): GridRect {
  const east = a.quarter.endsWith('E');
  const north = a.quarter.startsWith('N');
  let r: GridRect = {
    gi0: a.i + (east ? 0.5 : 0),
    gi1: a.i + (east ? 1 : 0.5),
    gj0: a.j + (north ? 0.5 : 0),
    gj1: a.j + (north ? 1 : 0.5),
  };
  if (a.half === 'N') r = { ...r, gj0: r.gj0 + 0.25 };
  if (a.half === 'S') r = { ...r, gj1: r.gj1 - 0.25 };
  if (a.half === 'E') r = { ...r, gi0: r.gi0 + 0.25 };
  if (a.half === 'W') r = { ...r, gi1: r.gi1 - 0.25 };
  return r;
}

/** Nominal acres: 160 for a quarter, 80 for a half-quarter. */
export function aliquotNominalAcres(a: Aliquot): number {
  return a.half ? 80 : 160;
}

/** The 40-acre cells (quarter-quarters) an aliquot covers, as 'i:j:ci:cj' keys (ci, cj in 0..3). */
export function aliquotCells(a: Aliquot): string[] {
  const r = aliquotRect(a);
  const out: string[] = [];
  for (let ci = Math.round((r.gi0 - a.i) * 4); ci < Math.round((r.gi1 - a.i) * 4); ci++) {
    for (let cj = Math.round((r.gj0 - a.j) * 4); cj < Math.round((r.gj1 - a.j) * 4); cj++) {
      out.push(`${a.i}:${a.j}:${ci}:${cj}`);
    }
  }
  return out;
}

/** e.g. "N 1/2 NE 1/4 Sec 14, T7S R4E" (legal description on the demo grid). */
export function legalDescription(a: Aliquot): string {
  const rowsSouth = -(a.j + 1); // 0 = first row of sections south of the base line
  const township = Math.floor(rowsSouth / 6) + 1;
  const range = Math.floor(a.i / 6) + 1;
  const r = ((rowsSouth % 6) + 6) % 6;
  const c = ((a.i % 6) + 6) % 6;
  const section = r % 2 === 0 ? 6 * r + 6 - c : 6 * r + 1 + c;
  const part = a.half ? `${a.half} 1/2 ${a.quarter} 1/4` : `${a.quarter} 1/4`;
  return `${part} Sec ${section}, T${township}S R${range}E`;
}
