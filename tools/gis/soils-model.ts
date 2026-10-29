/**
 * Pure transforms for `pnpm gis:soils` (unit-tested): SDA records → typed rows → one
 * gis.soil_mapunits record per map unit. Owner: soils.
 *
 * Map unit attributes (plan §4 `gis.soil_mapunits`):
 *  - dominant component = the component with the highest comppct_r (ties: lowest cokey), the
 *    SSURGO "dominant component" method; its series name, drainage class and hydrologic group
 *    describe the map unit (the field panel shows them, the map colours by drainage class);
 *  - NCCPI = the component-percent-weighted average of the components' NCCPI v3 ratings
 *    (Σ nccpi·pct / Σ pct over the components that HAVE a rating), NRCS soilDB's "Weighted
 *    Average" method for interpretations (rating / sum_com). Unrated components (water, pits,
 *    other miscellaneous areas) don't pull the index down; a map unit with no rated component
 *    has none (null);
 *  - every component is kept in `components` (SoilComponent[]) for the record.
 */
import type { SoilComponent } from '../../src/domain/soils';
import type { SdaCell } from './soils-sda';

export interface SurveyAreaRow {
  areasymbol: string;
  areaname: string | null;
  /** Survey version date as SDA wrote it (e.g. '9/5/2025 12:00:00 AM' or an ISO date). */
  saverest: string | null;
}

export interface MapunitStatsRow {
  mukey: string;
  musym: string | null;
  muname: string;
  farmlndcl: string | null;
  polygons: number;
  vertices: number;
}

export interface ComponentRow {
  mukey: string;
  cokey: string;
  compname: string;
  comppct: number | null;
  major: boolean;
  compkind: string | null;
  drainagecl: string | null;
  hydgrp: string | null;
  nccpi: number | null;
}

export interface PolygonRow {
  mupolygonkey: string;
  mukey: string;
  wkt: string;
}

/** One gis.soil_mapunits row. */
export interface MapunitRecord {
  mukey: string;
  areasymbol: string;
  musym: string | null;
  muname: string;
  dominantComponent: string | null;
  drainageClass: string | null;
  hydgrp: string | null;
  farmlandClass: string | null;
  /** 0-1, 3 decimals; null when no component is rated. */
  nccpi: number | null;
  components: SoilComponent[];
  surveyVersion: string | null;
}

type Rec = Record<string, SdaCell>;

function str(r: Rec, k: string): string | null {
  const v = r[k];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function reqStr(r: Rec, k: string, what: string): string {
  const s = str(r, k);
  if (s === null) throw new Error(`${what}: '${k}' is missing`);
  return s;
}

function num(r: Rec, k: string): number | null {
  const s = str(r, k);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function key(r: Rec, k: string, what: string): string {
  const s = reqStr(r, k, what);
  // SDA may serialize integer keys as "123" or 123; never as "123.0", but be safe.
  const m = /^(\d+)(?:\.0+)?$/.exec(s);
  if (!m?.[1]) throw new Error(`${what}: '${k}' = '${s}' is not a key`);
  return m[1];
}

export function toSurveyAreaRows(records: Rec[]): SurveyAreaRow[] {
  return records.map((r) => ({
    areasymbol: reqStr(r, 'areasymbol', 'sacatalog').toUpperCase(),
    areaname: str(r, 'areaname'),
    saverest: str(r, 'saverest'),
  }));
}

export function toMapunitStatsRows(records: Rec[]): MapunitStatsRow[] {
  return records.map((r) => ({
    mukey: key(r, 'mukey', 'mapunit'),
    musym: str(r, 'musym'),
    muname: reqStr(r, 'muname', 'mapunit'),
    farmlndcl: str(r, 'farmlndcl'),
    polygons: num(r, 'polygons') ?? 0,
    vertices: num(r, 'vertices') ?? 0,
  }));
}

export function toComponentRows(records: Rec[]): ComponentRow[] {
  return records.map((r) => {
    const nccpi = num(r, 'nccpi');
    return {
      mukey: key(r, 'mukey', 'component'),
      cokey: key(r, 'cokey', 'component'),
      compname: str(r, 'compname') ?? 'Unnamed',
      comppct: num(r, 'comppct_r'),
      major: (str(r, 'majcompflag') ?? '').toLowerCase() === 'yes',
      compkind: str(r, 'compkind'),
      drainagecl: str(r, 'drainagecl'),
      hydgrp: str(r, 'hydgrp'),
      nccpi: nccpi === null ? null : Math.min(1, Math.max(0, nccpi)),
    };
  });
}

export function toPolygonRows(records: Rec[]): PolygonRow[] {
  return records.map((r) => ({
    mupolygonkey: key(r, 'mupolygonkey', 'mupolygon'),
    mukey: key(r, 'mukey', 'mupolygon'),
    wkt: reqStr(r, 'wkt', 'mupolygon'),
  }));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Σ nccpi·pct / Σ pct over rated components with a percentage; null when none. */
export function weightedNccpi(components: readonly ComponentRow[]): number | null {
  let sum = 0;
  let weight = 0;
  for (const c of components) {
    if (c.nccpi === null || c.comppct === null || c.comppct <= 0) continue;
    sum += c.nccpi * c.comppct;
    weight += c.comppct;
  }
  return weight > 0 ? round3(sum / weight) : null;
}

const cokeyOrder = (a: string, b: string) => a.length - b.length || a.localeCompare(b);

/** Highest comppct_r, ties by the lowest cokey; null for a map unit with no components. */
export function dominantComponent(components: readonly ComponentRow[]): ComponentRow | null {
  let best: ComponentRow | null = null;
  for (const c of components) {
    if (
      !best ||
      (c.comppct ?? -1) > (best.comppct ?? -1) ||
      ((c.comppct ?? -1) === (best.comppct ?? -1) && cokeyOrder(c.cokey, best.cokey) < 0)
    ) {
      best = c;
    }
  }
  return best;
}

/** sacatalog's saverest as a date (YYYY-MM-DD) when it parses, else as given. */
export function surveyVersion(area: SurveyAreaRow | undefined): string | null {
  if (!area?.saverest) return null;
  const s = area.saverest;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso?.[1]) return `${area.areasymbol} ${iso[1]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us?.[1] && us[2] && us[3]) {
    return `${area.areasymbol} ${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  return `${area.areasymbol} ${s}`;
}

/** One record per map unit of `stats` (components grouped by mukey). */
export function buildMapunitRecords(
  areasymbol: string,
  area: SurveyAreaRow | undefined,
  stats: readonly MapunitStatsRow[],
  components: readonly ComponentRow[],
): MapunitRecord[] {
  const byMukey = new Map<string, ComponentRow[]>();
  for (const c of components) {
    const list = byMukey.get(c.mukey) ?? [];
    list.push(c);
    byMukey.set(c.mukey, list);
  }
  const version = surveyVersion(area);
  return stats.map((s) => {
    const comps = [...(byMukey.get(s.mukey) ?? [])].sort(
      (a, b) => (b.comppct ?? -1) - (a.comppct ?? -1) || cokeyOrder(a.cokey, b.cokey),
    );
    const dom = dominantComponent(comps);
    return {
      mukey: s.mukey,
      areasymbol,
      musym: s.musym,
      muname: s.muname,
      dominantComponent: dom?.compname ?? null,
      drainageClass: dom?.drainagecl ?? null,
      hydgrp: dom?.hydgrp ?? null,
      farmlandClass: s.farmlndcl,
      nccpi: weightedNccpi(comps),
      components: comps.map((c) => ({
        name: c.compname,
        pct: c.comppct ?? 0,
        major: c.major,
        drainageClass: c.drainagecl,
        hydgrp: c.hydgrp,
        nccpi: c.nccpi === null ? null : round3(c.nccpi),
      })),
      surveyVersion: version,
    };
  });
}
