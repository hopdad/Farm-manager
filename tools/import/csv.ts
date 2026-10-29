/**
 * Spreadsheet CSVs as people save them on Windows (Excel's BOM, CRLF, quoted commas, blank
 * lines, "Crop Year" headers): one parser for the seasons and parties imports, with the CSV
 * line number of every row so errors point at the right line. Pure; csv-parse/sync.
 *
 * Bytes become text with `decodeCsvBytes`: Excel on Windows saves "CSV (Comma delimited)" in the
 * ANSI code page (Windows-1252), also when it opened our ASCII-only template, so a file that is
 * not valid UTF-8 is read as Windows-1252 (é, ’, ®, ½ intact) instead of turning into U+FFFD.
 */
import { parse } from 'csv-parse/sync';

export interface CsvRow {
  /** 1-based line in the file (the header is line 1). */
  line: number;
  /** Normalized header -> trimmed cell text ('' when empty). */
  cells: Record<string, string>;
}

export interface CsvTable {
  headers: string[];
  rows: CsvRow[];
}

export class CsvError extends Error {
  override name = 'CsvError';
}

/** 'Crop Year' / 'crop-year' / ' CROP_YEAR ' -> 'crop_year'. */
export const normHeader = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * A CSV file's bytes as text: UTF-8 when they are valid UTF-8 (a BOM is dropped), else
 * Windows-1252 (Excel's "CSV (Comma delimited)" on Windows).
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Bigger files are refused (a crop-history or contact list is a few hundred rows). */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;

export function readCsv(text: string, opts: { required?: string[][] } = {}): CsvTable {
  if (text.length > MAX_CSV_BYTES) throw new CsvError('the file is larger than 2 MB');
  let records: { record: string[]; line: number }[];
  try {
    const raw = parse(text, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      info: true,
    }) as unknown as { record: string[]; info: { lines: number } }[];
    records = raw.map((r) => ({ record: r.record, line: r.info.lines }));
  } catch (e) {
    throw new CsvError(`not a readable CSV file (${(e as Error).message})`);
  }
  const head = records.shift();
  if (!head) throw new CsvError('the file is empty');
  const headers = head.record.map(normHeader);
  const dup = headers.find((h, i) => h && headers.indexOf(h) !== i);
  if (dup) throw new CsvError(`the column '${dup}' appears twice`);
  for (const alternatives of opts.required ?? []) {
    if (!alternatives.some((a) => headers.includes(a))) {
      throw new CsvError(
        `the header row has no '${alternatives.join("' or '")}' column (columns: ${headers.filter(Boolean).join(', ')})`,
      );
    }
  }
  const rows: CsvRow[] = [];
  for (const r of records) {
    if (r.record.every((c) => c.trim() === '')) continue;
    const cells: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) cells[h] = (r.record[i] ?? '').trim();
    });
    rows.push({ line: r.line, cells });
  }
  return { headers, rows };
}

/** A tiny CSV writer (templates, error reports): quotes cells with commas, quotes or newlines. */
export function writeCsv(rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
