/**
 * Synthetic crop history for the demo fields (plan §2 step 5: "5 seasons of synthetic history").
 *
 * Most fields rotate corn / soybeans; about one in six runs corn / soybeans / wheat. Yields are a
 * year effect (good and bad years for SE Michigan) times a per-field productivity factor times a
 * little noise; planting and harvest dates fall in the usual windows. The current year's crop
 * (CURRENT_CROP_YEAR, still in the field) follows the same rotation and drives the scenarios:
 * harvest-day harvests this year's corn, planting-day plants it.
 */
import type { DemoFarm } from './farm/build';
import { rngFor } from './rng';
import type { SimField } from './types';

export type Crop = 'corn' | 'soybeans' | 'wheat';

/** Completed seasons written by the seed. */
export const SEASON_YEARS = [2021, 2022, 2023, 2024, 2025] as const;
/** The season in progress in the scenarios (not seeded: it isn't history yet). */
export const CURRENT_CROP_YEAR = 2026;

const YEAR_EFFECT: Record<Crop, Record<number, number>> = {
  corn: { 2021: 186, 2022: 171, 2023: 180, 2024: 189, 2025: 183, 2026: 187 },
  soybeans: { 2021: 51, 2022: 53, 2023: 48, 2024: 54, 2025: 52, 2026: 52 },
  wheat: { 2021: 92, 2022: 86, 2023: 95, 2024: 89, 2025: 90, 2026: 91 },
};

export interface SimFieldSeason {
  key: string;
  fieldId: string;
  fieldKey: string;
  cropYear: number;
  crop: Crop;
  variety: string;
  /** YYYY-MM-DD (wheat: the previous fall). */
  plantedOn: string;
  harvestedOn: string;
  yieldBuAc: number;
}

/** Whether the field runs a 3-year corn / soybean / wheat rotation. */
function hasWheat(seed: number, field: SimField): boolean {
  return rngFor(seed, 'rotation', field.key).chance(1 / 6);
}

/** The crop on `field` in `year`. */
export function cropFor(seed: number, field: SimField, year: number): Crop {
  const phase = rngFor(seed, 'rotation-phase', field.key).int(0, 5);
  if (hasWheat(seed, field)) {
    return (['corn', 'soybeans', 'wheat'] as const)[(year + phase) % 3] as Crop;
  }
  return (year + phase) % 2 === 0 ? 'corn' : 'soybeans';
}

/** Per-field productivity factor (soils, drainage): 0.88 .. 1.12, stable for a field. */
export function productivity(seed: number, field: SimField): number {
  return rngFor(seed, 'productivity', field.key).range(0.88, 1.12);
}

/** Yield of `crop` on `field` in `year`, bu/ac (2 decimals). */
export function yieldFor(seed: number, field: SimField, year: number, crop: Crop): number {
  const base = YEAR_EFFECT[crop][year] ?? YEAR_EFFECT[crop][2026] ?? 0;
  const noise = rngFor(seed, 'yield-noise', field.key, year).range(0.94, 1.06);
  return Math.round(base * productivity(seed, field) * noise * 100) / 100;
}

const pad = (n: number) => String(n).padStart(2, '0');
function isoDate(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function variety(seed: number, field: SimField, year: number, crop: Crop): string {
  const r = rngFor(seed, 'variety', field.key, year);
  if (crop === 'corn') return `NF ${r.int(102, 112)}-${r.int(10, 89)}`;
  if (crop === 'soybeans') return `NF ${(r.int(20, 32) / 10).toFixed(1)}E${r.int(1, 9)}`;
  return `NF W${r.int(200, 299)} SRW`;
}

/** The five completed seasons of every field (what the seed writes into farm.field_seasons). */
export function simFieldSeasons(farm: DemoFarm): SimFieldSeason[] {
  const out: SimFieldSeason[] = [];
  for (const field of farm.fields) {
    for (const year of SEASON_YEARS) {
      const crop = cropFor(farm.seed, field, year);
      const r = rngFor(farm.seed, 'dates', field.key, year);
      let plantedOn: string;
      let harvestedOn: string;
      if (crop === 'corn') {
        plantedOn = isoDate(year, 4, 24 + r.int(0, 21));
        harvestedOn = isoDate(year, 10, 8 + r.int(0, 35));
      } else if (crop === 'soybeans') {
        plantedOn = isoDate(year, 5, 4 + r.int(0, 24));
        harvestedOn = isoDate(year, 9, 24 + r.int(0, 28));
      } else {
        plantedOn = isoDate(year - 1, 10, 2 + r.int(0, 16));
        harvestedOn = isoDate(year, 7, 8 + r.int(0, 14));
      }
      out.push({
        key: `season:${field.key}:${year}`,
        fieldId: field.id,
        fieldKey: field.key,
        cropYear: year,
        crop,
        variety: variety(farm.seed, field, year, crop),
        plantedOn,
        harvestedOn,
        yieldBuAc: yieldFor(farm.seed, field, year, crop),
      });
    }
  }
  return out;
}
