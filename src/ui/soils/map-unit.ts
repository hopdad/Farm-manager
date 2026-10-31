/**
 * The map unit sheet's data and view model (soil map Phase A; pure, unit-tested). Owner: soils.
 *
 *   GET /api/soils/mapunits/<mukey> → MapUnitDetail (src/app/api/soils/handler.ts)
 *
 * The sheet opens at once from what the tapped tile feature carries (symbol, name, drainage,
 * hydrologic group, farmland class, NCCPI) and fills in the components when the detail arrives.
 * Values are the map unit's (gis.soil_mapunits): drainage class and hydrologic group are the
 * dominant component's, NCCPI is weighted by component percent (docs/decisions.md, "Soils").
 */
import type { SoilComponent } from '../../domain/soils';
import {
  HYDGRP_CLASSES,
  HYDGRP_LABELS,
  type HydrologicGroup,
  NCCPI_LABELS,
  nccpiClassOf,
  type SoilUnitProps,
  soilClassOf,
} from '../map/layers/soils';
import type { MapUnitDetail, MapUnitPreview } from './protocol';

export {
  MAP_UNIT_PATH,
  type MapUnitDetail,
  type MapUnitPreview,
  MUKEY_RE,
  parseComponents,
  previewOf,
} from './protocol';

export const SURVEY_AREA_NAMES: Readonly<Record<string, string>> = {
  MI091: 'Lenawee County, Michigan',
  MI115: 'Monroe County, Michigan',
};

// ---------------------------------------------------------------------------------------------
// Official series descriptions (online only)
// ---------------------------------------------------------------------------------------------

/**
 * Official Soil Series Descriptions, one page per series: the first letter's folder, the name in
 * capitals, spaces as underscores, e.g. https://soilseries.sc.egov.usda.gov/OSD_Docs/B/BLOUNT.html
 * and https://soilseries.sc.egov.usda.gov/OSD_Docs/D/DEL_REY.html (both checked Oct 30, 2026).
 */
export const OSD_BASE = 'https://soilseries.sc.egov.usda.gov/OSD_Docs';

/** Miscellaneous areas and higher taxa have no series page. */
const NOT_SERIES = new Set([
  'water',
  'pits',
  'dumps',
  'urban land',
  'made land',
  'borrow pits',
  'gravel pits',
  'rock outcrop',
  'riverwash',
  'marsh',
  'muck',
  'beaches',
  'landfill',
  'quarry',
  'histosols',
]);
/** Great groups and suborders (Udorthents, Aquents, Haplaquolls…) end in an order's element. */
const TAXON_RE = /(ents|epts|alfs|olls|ists|erts|ults)$/i;
/** Every word capitalised (Blount, Del Rey, McBride); 'Blount family', 'Urban land' are not. */
const SERIES_NAME_RE = /^[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*$/;

/** Is this component a named soil series (so it has an official description)? */
export function isSeriesComponent(c: Pick<SoilComponent, 'name'>): boolean {
  const name = c.name.trim();
  return SERIES_NAME_RE.test(name) && !NOT_SERIES.has(name.toLowerCase()) && !TAXON_RE.test(name);
}

/** The official series description's URL, or null for a component that isn't a series. */
export function osdUrl(name: string): string | null {
  const n = name.trim();
  if (!isSeriesComponent({ name: n })) return null;
  const file = n.toUpperCase().replace(/ /g, '_');
  return `${OSD_BASE}/${file[0]}/${file}.html`;
}

// ---------------------------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------------------------

export interface MapUnitFact {
  key: 'drainage' | 'hydgrp' | 'farmland' | 'nccpi';
  label: string;
  value: string;
  /** Plain words under the value (what a hydrologic group means). */
  detail: string | null;
  color: string;
}

export interface MapUnitComponentRow {
  /** Unique within the sheet (a map unit can list the same component name twice). */
  key: string;
  name: string;
  pct: string;
  major: boolean;
  drainage: string;
  hydgrp: string;
  nccpi: string;
}

export interface MapUnitView {
  /** 'BnB'. */
  symbol: string;
  name: string;
  /** 'Lenawee County, Michigan · survey 2025-09-05'. */
  area: string | null;
  facts: MapUnitFact[];
  /** null while the detail loads. */
  components: MapUnitComponentRow[] | null;
  /**
   * The dominant component the drainage class and hydrologic group come from, as the loader
   * chose it ('Pewamo, 45 %'), or null (no detail yet, or no components).
   */
  dominant: string | null;
  /** Major series components, largest first, with their description pages. */
  series: { name: string; url: string }[];
  synthetic: boolean;
}

const pctText = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} %`;

function hydgrpDetail(g: string | null | undefined): string | null {
  if (!g || !(HYDGRP_CLASSES as readonly string[]).includes(g)) return null;
  return HYDGRP_LABELS[g as HydrologicGroup].replace(/^[A-D](\/D)?: /, '');
}

function nccpiDetail(nccpi: number | null | undefined): string | null {
  const i = nccpiClassOf(nccpi);
  if (i === null) return null;
  return `Class ${NCCPI_LABELS[i]} (0 to 1, higher is more productive)`;
}

function areaText(areasymbol: string | null, surveyVersion: string | null): string | null {
  if (!areasymbol) return null;
  const name = SURVEY_AREA_NAMES[areasymbol] ?? areasymbol;
  const date = surveyVersion?.replace(new RegExp(`^${areasymbol}\\s*`), '') ?? '';
  return date ? `${name} · survey of ${date}` : name;
}

/** The sheet's content: from the tapped feature at once, from the detail once it loads. */
export function mapUnitView(preview: MapUnitPreview, detail: MapUnitDetail | null): MapUnitView {
  const u: SoilUnitProps = detail
    ? {
        musym: detail.musym,
        muname: detail.muname,
        drainage_class: detail.drainageClass,
        hydgrp: detail.hydgrp,
        farmland_class: detail.farmlandClass,
        nccpi: detail.nccpi,
      }
    : preview;
  const drainage = soilClassOf('drainage', u, 'dark');
  const hydgrp = soilClassOf('hydgrp', u, 'dark');
  const farmland = soilClassOf('farmland', u, 'dark');
  const nccpi = soilClassOf('nccpi', u, 'dark');
  const facts: MapUnitFact[] = [
    {
      key: 'drainage',
      label: 'Drainage class',
      value: u.drainage_class ?? 'Not rated',
      detail: null,
      color: drainage.color,
    },
    {
      key: 'hydgrp',
      label: 'Hydrologic group',
      value: u.hydgrp ?? 'Not rated',
      detail: hydgrpDetail(u.hydgrp),
      color: hydgrp.color,
    },
    {
      key: 'farmland',
      label: 'Farmland class',
      value: u.farmland_class ?? 'Not rated',
      detail: null,
      color: farmland.color,
    },
    {
      key: 'nccpi',
      label: 'Productivity (NCCPI)',
      value: typeof u.nccpi === 'number' ? u.nccpi.toFixed(2) : 'Not rated',
      detail: nccpiDetail(u.nccpi),
      color: nccpi.color,
    },
  ];
  // Largest first; ties keep the loader's order (lowest cokey first, the way it picks the
  // dominant component), so the table's first row is the component the facts describe.
  const byShare = detail ? [...detail.components].sort((a, b) => b.pct - a.pct) : [];
  const components = detail
    ? byShare.map((c, i) => ({
        key: `${i}:${c.name}`,
        name: c.name,
        pct: pctText(c.pct),
        major: c.major,
        drainage: c.drainageClass ?? '—',
        hydgrp: c.hydgrp ?? '—',
        nccpi: c.nccpi === null ? '—' : c.nccpi.toFixed(2),
      }))
    : null;
  // The component the facts describe: the one the loader named (not merely the first row).
  const domName = detail?.dominantComponent ?? null;
  const dom = domName === null ? undefined : byShare.find((c) => c.name === domName);
  const dominant = domName === null ? null : dom ? `${dom.name}, ${pctText(dom.pct)}` : domName;
  const series = detail
    ? byShare
        .filter((c) => c.major)
        .flatMap((c) => {
          const url = osdUrl(c.name);
          return url ? [{ name: c.name, url }] : [];
        })
        .filter((s, i, all) => all.findIndex((x) => x.name === s.name) === i)
    : [];
  return {
    symbol: u.musym ?? '—',
    name: u.muname ?? (detail ? detail.muname : 'Soil map unit'),
    area: detail ? areaText(detail.areasymbol, detail.surveyVersion) : null,
    facts,
    components,
    dominant,
    series,
    synthetic: detail?.synthetic ?? false,
  };
}

// ---------------------------------------------------------------------------------------------
// Details already loaded in this tab
// ---------------------------------------------------------------------------------------------

/**
 * The details the sheet has loaded, for one soils version (gis.map_layers 'soils'.version, which
 * `pnpm gis:soils` changes on every load). A reload can keep the mukeys and change their
 * components or ratings, so a new version empties the cache, like the tiles and labels refetch.
 */
export class MapUnitDetailCache {
  private version: string | null = null;
  private byMukey = new Map<string, MapUnitDetail>();

  get(version: string | null, mukey: string): MapUnitDetail | undefined {
    return version === this.version ? this.byMukey.get(mukey) : undefined;
  }

  set(version: string | null, mukey: string, detail: MapUnitDetail): void {
    if (version !== this.version) {
      this.version = version;
      this.byMukey = new Map();
    }
    this.byMukey.set(mukey, detail);
  }
}
