/**
 * What GET /api/soils/mapunits/<mukey> answers and what the map unit sheet opens with (soil map
 * Phase A; pure, no map or React imports, so the route can use it). Owner: soils. The sheet's
 * view model: ./map-unit.ts.
 */
import type { SoilComponent } from '../../domain/soils';
import type { SoilUnitProps } from '../map/layers/soils';

export const MAP_UNIT_PATH = '/api/soils/mapunits';

/** SSURGO map unit keys are integers. */
export const MUKEY_RE = /^\d{1,12}$/;

/** One map unit, everything the sheet shows. */
export interface MapUnitDetail {
  mukey: string;
  areasymbol: string;
  musym: string | null;
  muname: string;
  /** Series of the dominant component. */
  dominantComponent: string | null;
  drainageClass: string | null;
  hydgrp: string | null;
  farmlandClass: string | null;
  /** 0-1, weighted by component percent. */
  nccpi: number | null;
  /** Largest first. */
  components: SoilComponent[];
  /** 'MI091 2025-09-05'. */
  surveyVersion: string | null;
  /** The loaded soils are the synthetic test fixture, not survey data. */
  synthetic: boolean;
}

/** What the sheet opens with: a tapped feature's properties (app.mvt_soils), or a full detail. */
export interface MapUnitPreview extends SoilUnitProps {
  mukey: string;
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);

/** A tile feature's properties as a preview (null without a valid mukey). */
export function previewOf(
  props: Record<string, unknown> | null | undefined,
): MapUnitPreview | null {
  const mukey = str(props?.mukey);
  if (!props || !mukey || !MUKEY_RE.test(mukey)) return null;
  const unit: SoilUnitProps = {
    musym: str(props.musym),
    muname: str(props.muname),
    drainage_class: str(props.drainage_class),
    hydgrp: str(props.hydgrp),
    farmland_class: str(props.farmland_class),
    nccpi: typeof props.nccpi === 'number' ? props.nccpi : null,
  };
  return { mukey, ...unit };
}

/** A components jsonb value as SoilComponent[] (defensive: the column is written by gis:soils). */
export function parseComponents(raw: unknown): SoilComponent[] {
  if (!Array.isArray(raw)) return [];
  const out: SoilComponent[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    if (typeof r.name !== 'string') continue;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
    out.push({
      name: r.name,
      pct: num(r.pct) ?? 0,
      major: r.major === true,
      drainageClass: str(r.drainageClass),
      hydgrp: str(r.hydgrp),
      nccpi: num(r.nccpi),
    });
  }
  return out;
}
