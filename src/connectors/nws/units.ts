/**
 * NWS unit codes -> the US customary units the app stores (src/domain/weather.ts).
 *
 * api.weather.gov tags every quantity with a `uom` / `unitCode` (OpenAPI `UnitOfMeasure`:
 * "{unit}" or "{namespace}:{unit}", namespaces wmo, wmoUnit, nwsUnit, uc; units with the wmo
 * namespace are the WMO Codes Registry's, https://codes.wmo.int/common/unit). Gridpoint layers
 * and observations seen in practice use wmoUnit:degC, wmoUnit:km_h-1, wmoUnit:m_s-1,
 * wmoUnit:mm, wmoUnit:m, wmoUnit:percent and wmoUnit:degree_(angle) (doc-derived, confirm
 * against a recorded response: src/connectors/nws/doc-derived.ts).
 *
 * An unknown unit is an error, never a guess: a silently wrong wind speed would turn a no-go
 * into a go. The sync step dead-letters the raw event and /admin/connectors shows why.
 */

export class NwsUnitError extends Error {
  constructor(quantity: string, unit: string) {
    super(`NWS ${quantity}: unknown unit '${unit}'`);
    this.name = 'NwsUnitError';
  }
}

/** 'wmoUnit:km_h-1' -> 'km_h-1' (namespaces are optional in the spec). */
export function bareUnit(unit: string | null | undefined): string {
  const u = (unit ?? '').trim();
  const m = /^(?:wmo|wmoUnit|nwsUnit|uc):(.*)$/.exec(u);
  return m ? (m[1] as string) : u;
}

export type Quantity = 'temperature' | 'speed' | 'precipitation' | 'height' | 'percent' | 'angle';

const CONVERT: Record<Quantity, Record<string, (v: number) => number>> = {
  /** -> degrees Fahrenheit */
  temperature: {
    degC: (c) => (c * 9) / 5 + 32,
    Cel: (c) => (c * 9) / 5 + 32,
    degF: (f) => f,
    '[degF]': (f) => f,
    K: (k) => ((k - 273.15) * 9) / 5 + 32,
  },
  /** -> miles per hour */
  speed: {
    'km_h-1': (v) => v / 1.609344,
    'km/h': (v) => v / 1.609344,
    'm_s-1': (v) => v * 2.2369362920544,
    'm/s': (v) => v * 2.2369362920544,
    'mi_h-1': (v) => v,
    '[mi_i]/h': (v) => v,
    kt: (v) => v * 1.150779448,
    '[kn_i]': (v) => v * 1.150779448,
  },
  /** -> inches */
  precipitation: {
    mm: (v) => v / 25.4,
    cm: (v) => v / 2.54,
    m: (v) => v / 0.0254,
    in: (v) => v,
    '[in_i]': (v) => v,
  },
  /** -> feet */
  height: {
    m: (v) => v / 0.3048,
    km: (v) => v / 0.0003048,
    ft: (v) => v,
    '[ft_i]': (v) => v,
  },
  percent: { percent: (v) => v, '%': (v) => v },
  angle: { 'degree_(angle)': (v) => v, deg: (v) => v },
};

/**
 * A converter for `unit` (throws NwsUnitError for an unknown one). A missing unit is accepted
 * only for percentages and angles, whose unit is implied.
 */
export function converter(
  quantity: Quantity,
  unit: string | null | undefined,
): (v: number) => number {
  const u = bareUnit(unit);
  if (!u && (quantity === 'percent' || quantity === 'angle')) return (v) => v;
  const f = CONVERT[quantity][u];
  if (!f) throw new NwsUnitError(quantity, unit ?? '(none)');
  return f;
}

/** Round to `digits` decimals (null stays null). */
export function round(v: number | null, digits = 1): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

/** Clamp a percentage into [0, 100] (the database CHECKs it). */
export function clampPct(v: number | null): number | null {
  return v === null ? null : Math.min(100, Math.max(0, v));
}

/** Normalize a direction into [0, 360] (the database CHECKs it). */
export function normalizeDir(v: number | null): number | null {
  if (v === null) return null;
  const d = ((v % 360) + 360) % 360;
  return d === 0 && v >= 360 ? 360 : d;
}
