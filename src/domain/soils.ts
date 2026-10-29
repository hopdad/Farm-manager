/**
 * Soils contract (plan 1c; docs/contracts-m1.md §5). gis.soil_mapunits / gis.soil_polygons are
 * loaded by `pnpm gis:soils` (soils builder); gis.field_soils is rebuilt in SQL for every
 * boundary version. The field panel's soils tab renders `FieldSoilRow[]` (from FieldDetail)
 * plus `summarizeFieldSoils()`. Pure TS.
 */

/** One component of a map unit (gis.soil_mapunits.components). */
export interface SoilComponent {
  /** SSURGO compname (usually the series), e.g. 'Blount'. */
  name: string;
  /** comppct_r. */
  pct: number;
  /** majcompflag = 'Yes'. */
  major: boolean;
  drainageClass: string | null;
  hydgrp: string | null;
  /** Component NCCPI (0-1) when SDA had one. */
  nccpi: number | null;
}

/** One map unit inside a field's current boundary (gis.field_soils ⋈ gis.soil_mapunits). */
export interface FieldSoilRow {
  mukey: string;
  musym: string | null;
  muname: string;
  /** Series of the dominant component, e.g. 'Blount'. */
  dominantComponent: string | null;
  drainageClass: string | null;
  hydgrp: string | null;
  farmlandClass: string | null;
  /** 0-1. */
  nccpi: number | null;
  acres: number;
  /** Percent of the boundary, 0-100. */
  pct: number;
}

export interface FieldSoilsSummary {
  /** Acre-weighted NCCPI over the rows that have one; null when none do. */
  weightedNccpi: number | null;
  /** Percent of the boundary the rows cover (100 when soils cover the whole field). */
  coveredPct: number;
  /** The largest map unit by acres. */
  dominant: FieldSoilRow | null;
  /** Acres per drainage class, largest first (unknown class as 'Unknown'). */
  drainage: { drainageClass: string; acres: number; pct: number }[];
}

/** Weighted NCCPI, coverage and drainage mix of a field's soils. Rows in any order. */
export function summarizeFieldSoils(rows: readonly FieldSoilRow[]): FieldSoilsSummary {
  let weighted = 0;
  let weightAcres = 0;
  let covered = 0;
  let dominant: FieldSoilRow | null = null;
  const drainage = new Map<string, { acres: number; pct: number }>();
  for (const r of rows) {
    covered += r.pct;
    if (r.nccpi !== null && Number.isFinite(r.nccpi) && r.acres > 0) {
      weighted += r.nccpi * r.acres;
      weightAcres += r.acres;
    }
    if (!dominant || r.acres > dominant.acres) dominant = r;
    const key = r.drainageClass ?? 'Unknown';
    const d = drainage.get(key) ?? { acres: 0, pct: 0 };
    d.acres += r.acres;
    d.pct += r.pct;
    drainage.set(key, d);
  }
  return {
    weightedNccpi: weightAcres > 0 ? round(weighted / weightAcres, 3) : null,
    coveredPct: round(Math.min(100, covered), 1),
    dominant,
    drainage: [...drainage.entries()]
      .map(([drainageClass, d]) => ({
        drainageClass,
        acres: round(d.acres, 1),
        pct: round(d.pct, 1),
      }))
      .sort((a, b) => b.acres - a.acres || a.drainageClass.localeCompare(b.drainageClass)),
  };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** SSURGO drainage classes (component `drainagecl`), driest first: legend and sort order. */
export const DRAINAGE_CLASSES = [
  'Excessively drained',
  'Somewhat excessively drained',
  'Well drained',
  'Moderately well drained',
  'Somewhat poorly drained',
  'Poorly drained',
  'Very poorly drained',
  'Subaqueous',
] as const;
export type DrainageClass = (typeof DRAINAGE_CLASSES)[number];

/** SSURGO survey areas the soils load covers (plan §5): Lenawee and Monroe. */
export const SOIL_SURVEY_AREAS = ['MI091', 'MI115'] as const;

/** Properties of a feature in the `soils` vector tile layer (app.mvt_soils). */
export interface SoilTileProperties {
  mukey: string;
  musym?: string;
  muname: string;
  drainage_class?: string;
  hydgrp?: string;
  farmland_class?: string;
  nccpi?: number;
}
