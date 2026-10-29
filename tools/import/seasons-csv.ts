/**
 * Crop history CSV (plan 1c `import:seasons <csv>`): one row per field and crop year, from
 * Derrick's records or crop-insurance APH, so real fields show 5 seasons before Deere is
 * connected. Template: tools/import/templates/seasons.csv.
 *
 *   field, crop_year, crop, variety, planted_on, harvested_on, yield_bu_ac
 *   (+ optional `farm` when two farms have a field of the same name, or `field_id`)
 *
 * This module only checks each row on its own (types, ranges, date order) and reports problems
 * by CSV line; matching the field names to fields happens in the database
 * (src/db/queries/seasons.ts). Pure.
 */
import type { SeasonInput } from '../../src/db/queries/seasons';
import { isUuid } from '../../src/domain/ids';
import { readCsv } from './csv';
import { parseDate } from './dates';

export const SEASON_COLUMNS = [
  'field',
  'crop_year',
  'crop',
  'variety',
  'planted_on',
  'harvested_on',
  'yield_bu_ac',
] as const;
export const SEASON_OPTIONAL_COLUMNS = ['farm', 'field_id'] as const;

/** A row that passed the checks, waiting for its field to be found. */
export interface SeasonCsvRow extends SeasonInput {
  line: number;
  field: string;
  farm: string | null;
  fieldId: string | null;
}

export interface RowProblem {
  line: number;
  message: string;
}

export interface SeasonCsvResult {
  rows: SeasonCsvRow[];
  errors: RowProblem[];
  warnings: RowProblem[];
}

/** Common spellings -> the names the app (and the demo seed) uses. */
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

export function normalizeCrop(raw: string): string {
  const k = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return CROP_NAMES[k] ?? raw.trim();
}

const MAX_TEXT = 80;

/**
 * Check one season (used by the CSV and by the History tab's form): returns the cleaned input
 * or the problems. `currentYear` bounds crop_year (next year's crop may be planned).
 */
export function validateSeason(
  raw: {
    crop_year?: string;
    crop?: string;
    variety?: string;
    planted_on?: string;
    harvested_on?: string;
    yield_bu_ac?: string;
  },
  currentYear: number,
): { ok: true; value: SeasonInput; warnings: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const yearText = (raw.crop_year ?? '').trim();
  const cropYear = /^\d{4}$/.test(yearText) ? Number(yearText) : Number.NaN;
  if (!yearText) errors.push('crop_year is empty');
  else if (!Number.isInteger(cropYear) || cropYear < 1950 || cropYear > currentYear + 1) {
    errors.push(`crop_year '${yearText}' is not a year between 1950 and ${currentYear + 1}`);
  }
  const date = (name: 'planted_on' | 'harvested_on'): string | null => {
    const v = (raw[name] ?? '').trim();
    if (!v) return null;
    const d = parseDate(v);
    if (!d.ok) {
      errors.push(`${name}: ${d.error}`);
      return null;
    }
    return d.value;
  };
  const plantedOn = date('planted_on');
  const harvestedOn = date('harvested_on');
  if (plantedOn && harvestedOn && harvestedOn < plantedOn) {
    errors.push(`harvested_on ${harvestedOn} is before planted_on ${plantedOn}`);
  }
  if (Number.isInteger(cropYear)) {
    // Winter wheat is planted the fall before its crop year; nothing is harvested 2 years on.
    if (plantedOn && Number(plantedOn.slice(0, 4)) < cropYear - 1) {
      warnings.push(`planted_on ${plantedOn} is long before crop year ${cropYear}`);
    }
    if (harvestedOn && Number(harvestedOn.slice(0, 4)) > cropYear + 1) {
      warnings.push(`harvested_on ${harvestedOn} is long after crop year ${cropYear}`);
    }
  }
  const yieldText = (raw.yield_bu_ac ?? '').trim().replace(/,/g, '');
  let yieldBuAc: number | null = null;
  if (yieldText) {
    const y = Number(yieldText);
    if (!Number.isFinite(y) || y < 0 || y >= 1000) {
      errors.push(`yield_bu_ac '${raw.yield_bu_ac}' is not a number of bushels per acre (0-999)`);
    } else {
      yieldBuAc = Math.round(y * 100) / 100;
    }
  }
  const crop = (raw.crop ?? '').trim();
  const variety = (raw.variety ?? '').trim();
  if (crop.length > MAX_TEXT) errors.push(`crop is longer than ${MAX_TEXT} characters`);
  if (variety.length > MAX_TEXT) errors.push(`variety is longer than ${MAX_TEXT} characters`);
  if (yieldBuAc !== null && !crop) warnings.push('a yield without a crop');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      cropYear,
      crop: crop ? normalizeCrop(crop) : null,
      variety: variety || null,
      plantedOn,
      harvestedOn,
      yieldBuAc,
    },
    warnings,
  };
}

/** Read and check a seasons CSV. Throws CsvError for a file that isn't one. */
export function parseSeasonsCsv(text: string, currentYear: number): SeasonCsvResult {
  const table = readCsv(text, { required: [['field', 'field_id'], ['crop_year']] });
  const rows: SeasonCsvRow[] = [];
  const errors: RowProblem[] = [];
  const warnings: RowProblem[] = [];
  const known = new Set<string>([...SEASON_COLUMNS, ...SEASON_OPTIONAL_COLUMNS]);
  const unknown = table.headers.filter((h) => h && !known.has(h));
  if (unknown.length) {
    warnings.push({ line: 1, message: `ignored column(s): ${unknown.join(', ')}` });
  }
  const seen = new Map<string, number>();
  for (const { line, cells } of table.rows) {
    const field = cells.field ?? '';
    const fieldIdText = cells.field_id ?? '';
    const problems: string[] = [];
    if (!field && !fieldIdText) problems.push('field is empty');
    if (fieldIdText && !isUuid(fieldIdText))
      problems.push(`field_id '${fieldIdText}' is not an id`);
    const v = validateSeason(cells, currentYear);
    if (!v.ok) problems.push(...v.errors);
    if (problems.length || !v.ok) {
      for (const message of problems) errors.push({ line, message });
      continue;
    }
    for (const message of v.warnings) warnings.push({ line, message });
    const key = `${(fieldIdText || field).toLowerCase().replace(/\s+/g, ' ')}|${(cells.farm ?? '').toLowerCase()}|${v.value.cropYear}`;
    const earlier = seen.get(key);
    if (earlier) {
      errors.push({ line, message: `the same field and crop year as line ${earlier}` });
      continue;
    }
    seen.set(key, line);
    rows.push({
      ...v.value,
      line,
      field,
      farm: cells.farm ? cells.farm : null,
      fieldId: fieldIdText || null,
    });
  }
  return { rows, errors, warnings };
}
