import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { CsvError, decodeCsvBytes, readCsv, writeCsv } from './csv';
import { normalizeCrop, parseSeasonsCsv, SEASON_COLUMNS, validateSeason } from './seasons-csv';

const here = import.meta.dirname;

describe('parseSeasonsCsv', () => {
  test('the committed template is exactly the documented header', () => {
    const text = readFileSync(path.join(here, 'templates', 'seasons.csv'), 'utf8');
    expect(readCsv(text).headers).toEqual([...SEASON_COLUMNS]);
    expect(parseSeasonsCsv(text, 2026)).toEqual({ rows: [], errors: [], warnings: [] });
  });

  test('the example file parses clean (Excel dates included)', () => {
    const text = readFileSync(path.join(here, 'templates', 'seasons-example.csv'), 'utf8');
    const r = parseSeasonsCsv(text, 2026);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.rows[0]).toMatchObject({
      line: 2,
      field: 'Prospect South 80',
      cropYear: 2025,
      crop: 'soybeans',
      plantedOn: '2025-05-14',
      harvestedOn: '2025-10-02',
      yieldBuAc: 61.5,
    });
    // README "M1 demo" step 5: the last 5 crop years of the two fields in
    // boundaries-example.geojson, so the panel of each imported field lists 5 seasons.
    const years = (field: string) => r.rows.filter((x) => x.field === field).map((x) => x.cropYear);
    expect(years('Prospect South 80')).toEqual([2025, 2024, 2023, 2022, 2021]);
    expect(years('Prospect North 80')).toEqual([2025, 2024, 2023, 2022, 2021]);
    expect(r.rows).toHaveLength(10);
  });

  test('an Excel CSV: BOM, CRLF, "Crop Year" headers, quoted commas, blank lines', () => {
    const text =
      '﻿Field,Crop Year,Crop,Variety,Planted On,Harvested On,Yield (bu/ac),Farm,Notes\r\n' +
      '"Kowalski North, west",2025,Corn,"P1197, AM",4/28/2025,10/30/2025,"1,212.5",Home,x\r\n' +
      '\r\n' +
      'Home 80,2024,Beans,,,,61,,\r\n';
    const r = parseSeasonsCsv(text.replace('Yield (bu/ac)', 'yield_bu_ac'), 2026);
    expect(r.errors).toEqual([
      { line: 2, message: "yield_bu_ac '1,212.5' is not a number of bushels per acre (0-999)" },
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ line: 4, field: 'Home 80', crop: 'soybeans', yieldBuAc: 61 });
    expect(r.warnings).toEqual([{ line: 1, message: 'ignored column(s): notes' }]);
  });

  test('a Windows-1252 file (Excel on Windows) keeps ® and accented names', () => {
    const bytes = Buffer.from(
      'field,crop_year,crop,variety\r\nHome 80,2024,corn,Pioneer\xae P1185\r\nS\xe9bastien 40,2024,soybeans,\r\n',
      'latin1',
    );
    const r = parseSeasonsCsv(decodeCsvBytes(bytes), 2026);
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.field, x.variety])).toEqual([
      ['Home 80', 'Pioneer® P1185'],
      ['Sébastien 40', null],
    ]);
  });

  test('every problem is reported with its line', () => {
    const text = [
      'field,crop_year,crop,variety,planted_on,harvested_on,yield_bu_ac',
      ',2025,corn,,,,',
      'A,25,corn,,,,',
      'B,2025,corn,,2025-10-01,2025-05-01,',
      'C,2025,corn,,5/3/25,,',
      'D,2025,,,,,abc',
      'E,2031,corn,,,,',
      'F,2024,wheat,,2023-10-05,2024-07-10,88',
      'F,2024,wheat,,,,',
    ].join('\n');
    const r = parseSeasonsCsv(text, 2026);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6, 7, 9]);
    expect(r.errors.find((e) => e.line === 4)?.message).toMatch(/before planted_on/);
    expect(r.errors.find((e) => e.line === 5)?.message).toMatch(/year in full/);
    expect(r.errors.find((e) => e.line === 9)?.message).toBe(
      'the same field and crop year as line 8',
    );
    // Winter wheat planted the fall before its crop year is fine.
    expect(r.rows.map((x) => x.field)).toEqual(['F']);
    expect(r.warnings).toEqual([]);
  });

  test('a file without the needed columns is refused', () => {
    expect(() => parseSeasonsCsv('name,year\nA,2025\n', 2026)).toThrow(CsvError);
    expect(() => parseSeasonsCsv('', 2026)).toThrow(/empty/);
    expect(() => parseSeasonsCsv('field,crop_year,field\n', 2026)).toThrow(/twice/);
    // field_id instead of field works.
    const r = parseSeasonsCsv(
      'field_id,crop_year\n4b7f1c52-8e0a-5d3b-9a61-2f0c8d4e7a19,2025\nnot-an-id,2025\n',
      2026,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 3, message: expect.stringMatching(/not an id/) });
  });
});

describe('validateSeason / normalizeCrop', () => {
  test('cleans values', () => {
    expect(
      validateSeason({ crop_year: '2025', crop: ' Soybean ', yield_bu_ac: '55.555' }, 2026),
    ).toEqual({
      ok: true,
      value: {
        cropYear: 2025,
        crop: 'soybeans',
        variety: null,
        plantedOn: null,
        harvestedOn: null,
        yieldBuAc: 55.56,
      },
      warnings: [],
    });
    expect(normalizeCrop('Sugar beets')).toBe('Sugar beets');
    expect(validateSeason({ crop_year: '2025', yield_bu_ac: '180' }, 2026)).toMatchObject({
      ok: true,
      warnings: ['a yield without a crop'],
    });
  });
});

describe('writeCsv', () => {
  test('quotes what needs quoting and round-trips through readCsv', () => {
    const text = writeCsv([
      ['field', 'note'],
      ['A, west', 'say "hi"'],
      ['B', null],
    ]);
    expect(text).toBe('field,note\r\n"A, west","say ""hi"""\r\nB,\r\n');
    expect(readCsv(text).rows.map((r) => r.cells)).toEqual([
      { field: 'A, west', note: 'say "hi"' },
      { field: 'B', note: '' },
    ]);
  });
});
