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
 *  - `currentCropYear(now)`: the calendar year a date falls in, America/Detroit (a field's
 *    "this season" when it has no operations in the synced window).
 *  - `cropSeasonsToSync(now)` / `harvestCropYear(now)`: the two crop seasons deere.ops syncs
 *    (D23, the growing year) and the older of them, the one being harvested.
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
const YEAR_MONTH_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: FARM_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
});

/**
 * The calendar year `now` falls in, America/Detroit. An operation's crop year is the crop season
 * Deere gives it (D23), never this; this is only the fallback "this season" of a field with no
 * operations in the synced window (`cropSeasonsToSync`).
 */
export function currentCropYear(now: Date): number {
  return Number(YEAR_FORMAT.format(now));
}

/** The month (1-12) from whose first day, America/Detroit, the sync window moves a season on. */
export const SYNC_WINDOW_TURN_MONTH = 8;

/**
 * The crop seasons deere.ops lists per field at `now` (D23, Derrick Nov 3 2026: "the season
 * should follow the growing year"), oldest first, America/Detroit, Y = the calendar year:
 *
 *   Jan 1 - Jul 31   [Y - 1, Y]   last season's late edits (a yield recalibration, a harvest
 *                                 finished in January) and this season's spring work;
 *   Aug 1 - Dec 31   [Y, Y + 1]   this season's harvest and the fall-seeded crops (winter
 *                                 wheat, cover crops) Deere files under next year's cropSeason.
 *
 * Two seasons a field: about twice the operations listing calls per field of one season, which
 * the per-run field cap counts (`seasonsPerField`, src/jobs/deere-ops-budget.ts). An operation
 * keeps the season Deere gives it; there is no rollover date for operations, only for which
 * seasons are asked.
 */
export function cropSeasonsToSync(now: Date): [number, number] {
  let year = Number.NaN;
  let month = Number.NaN;
  for (const p of YEAR_MONTH_FORMAT.formatToParts(now)) {
    if (p.type === 'year') year = Number(p.value);
    if (p.type === 'month') month = Number(p.value);
  }
  return month >= SYNC_WINDOW_TURN_MONTH ? [year, year + 1] : [year - 1, year];
}

/**
 * The crop season being harvested at `now`: this year's from Aug 1, last year's before
 * (America/Detroit). The older season of `cropSeasonsToSync(now)`; the Deere stand-in labels
 * its scenario's work with it.
 */
export function harvestCropYear(now: Date): number {
  return cropSeasonsToSync(now)[0];
}
