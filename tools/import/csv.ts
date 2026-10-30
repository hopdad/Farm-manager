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
 * Windows-1252 bytes 0x80-0x9F (WHATWG Encoding table; the five unassigned bytes map to the C1
 * control of the same number). Every other byte is its own code point. Decoded by hand because
 * Node 24.13's TextDecoder('windows-1252') reads this range as ISO-8859-1 (0x92 -> U+0092, not ’),
 * found on Derrick's PC.
 */
const CP1252_80_9F = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152,
  0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122,
  0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

function decodeWindows1252(bytes: Uint8Array): string {
  const codes = new Array<number>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    codes[i] = b >= 0x80 && b <= 0x9f ? (CP1252_80_9F[b - 0x80] as number) : b;
  }
  let text = '';
  // Chunked so a 2 MB file doesn't overflow fromCharCode's argument limit.
  for (let i = 0; i < codes.length; i += 8192) {
    text += String.fromCharCode(...codes.slice(i, i + 8192));
  }
  return text;
}

/**
 * A CSV file's bytes as text: UTF-8 when they are valid UTF-8 (a BOM is dropped), else
 * Windows-1252 (Excel's "CSV (Comma delimited)" on Windows).
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeWindows1252(bytes);
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
