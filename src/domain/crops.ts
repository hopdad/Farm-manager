/**
 * Crop names and crop years (slice 1f, deere-ops; docs/contracts-1f.md §1): one normalization
 * for every writer of a crop, so a season typed into a CSV (`import:seasons`), a Deere field
 * operation (`deere.ops`) and, later, the deferred Deere season backfill all store the same
 * names the demo seed uses ('corn', 'soybeans', 'wheat').
 *
 *  - `normalizeCrop(raw)`: common spellings → the app's names; anything else is kept as typed
 *    (trimmed). `tools/import/seasons-csv.ts` re-exports it, so the CSV rules are these.
 *  - `normalizeDeereCrop(token)`: a Deere crop token (`cropName` of a field operation:
 *    `CORN_WET`, `SOYBEANS`, `WHEAT_SOFT_RED_WINTER`, the ISG crop list behind
 *    https://developer.deere.com/dev-docs/crop-types) → the app's name; an unknown token is
 *    written out in words ('SUGAR_BEETS' → 'sugar beets') instead of kept in capitals.
 *  - `currentCropYear(now)`: the crop year a date falls in, America/Detroit (the calendar year:
 *    the field panel's default listing and deere.ops' `cropSeason`).
 *
 * Pure, no runtime imports beyond the farm's time zone.
 */
import { FARM_TIME_ZONE } from './farm';

/** Common spellings → the names the app (and the demo seed) uses. Keys: lower case, single spaces. */
const CROP_NAMES: Record<string, string> = {
  corn: 'corn',
  'field corn': 'corn',
  'yellow corn': 'corn',
  soybeans: 'soybeans',
  soybean: 'soybeans',
  soy: 'soybeans',
  beans: 'soybeans',
  wheat: 'wheat',
  'winter wheat': 'wheat',
  'soft red winter wheat': 'wheat',
  srw: 'wheat',
};

/**
 * Deere crop tokens (ISG crop list) that are one of the app's crops. `CORN_WET` / `CORN_DRY`
 * are the same corn harvested at two moistures; wheat comes in classes. // doc-derived, confirm
 * (the full token list needs GET /cropTypes on a real account; unknown tokens fall back to words)
 */
const DEERE_CROP_TOKENS: Record<string, string> = {
  CORN: 'corn',
  CORN_WET: 'corn',
  CORN_DRY: 'corn',
  CORN_GRAIN: 'corn',
  SOYBEANS: 'soybeans',
  SOYBEAN: 'soybeans',
  WHEAT: 'wheat',
  WHEAT_WINTER: 'wheat',
  WHEAT_SPRING: 'wheat',
  WHEAT_SOFT_RED_WINTER: 'wheat',
  WHEAT_HARD_RED_WINTER: 'wheat',
  WHEAT_SOFT_WHITE: 'wheat',
  WHEAT_DURUM: 'wheat',
};

/** The app's name for a crop as someone typed it; unknown crops are kept as typed (trimmed). */
export function normalizeCrop(raw: string): string {
  const k = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return CROP_NAMES[k] ?? raw.trim();
}

/** The app's name for a Deere crop token (`cropName`), or null when there is none. */
export function normalizeDeereCrop(token: string | null | undefined): string | null {
  const t = token?.trim();
  if (!t) return null;
  const key = t.toUpperCase().replace(/[\s-]+/g, '_');
  const known = DEERE_CROP_TOKENS[key];
  if (known) return known;
  const typed = normalizeCrop(t);
  if (typed !== t) return typed;
  // A token we don't know: 'SUGAR_BEETS' → 'sugar beets' (a name, not a constant).
  return /^[A-Z0-9_]+$/.test(t) ? t.toLowerCase().replace(/_+/g, ' ').trim() : t;
}

const YEAR_FORMAT = new Intl.DateTimeFormat('en-US', { timeZone: FARM_TIME_ZONE, year: 'numeric' });

/** The crop year `now` falls in (its calendar year in America/Detroit). */
export function currentCropYear(now: Date): number {
  return Number(YEAR_FORMAT.format(now));
}
