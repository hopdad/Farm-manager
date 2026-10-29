import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultExportPath, UsageError as ExportUsageError, parseExportArgs } from './data-export';
import { formatImportReport, parseImportArgs, UsageError } from './data-import';
import { formatSeasonReport, parseImportSeasonsArgs } from './import-seasons';

describe('data:export / data:import arguments', () => {
  test('export path defaults under .data/exports with a local timestamp', () => {
    expect(parseExportArgs([])).toEqual({ out: null });
    expect(parseExportArgs(['--out', 'x.json'])).toEqual({ out: 'x.json' });
    const p = defaultExportPath('/proj', new Date('2026-10-29T11:07:05Z'));
    expect(p).toBe(path.join('/proj', '.data', 'exports', 'farm-data-20261029-070705.json'));
    expect(() => parseExportArgs(['--bogus'])).toThrow(ExportUsageError);
  });

  test('import takes one file; prod waits for MD', () => {
    expect(parseImportArgs(['f.json', '--dry-run'])).toEqual({
      file: 'f.json',
      dryRun: true,
      partial: false,
    });
    expect(() => parseImportArgs([])).toThrow(UsageError);
    expect(() => parseImportArgs(['f.json', '--target', 'prod'])).toThrow(/milestone MD/);
  });

  test('reports', () => {
    const text = formatImportReport({
      dryRun: false,
      written: false,
      tables: {
        'farm.parties': { inserted: 1, updated: 0, unchanged: 2, failed: 1 },
        'farm.farms': { inserted: 0, updated: 0, unchanged: 0, failed: 0 },
      },
      overlays: { 'farm.fields': { inserted: 0, updated: 1, unchanged: 0, failed: 0 } },
      errors: [{ table: 'farm.parties', id: 'x', message: 'bad' }],
      warnings: [],
    });
    expect(text).toContain('farm.parties');
    expect(text).not.toContain('farm.farms ');
    expect(text).toContain('farm.fields (synced rows)');
    expect(text).toContain('error  farm.parties x: bad');
    expect(text).toMatch(/NOTHING WRITTEN/);
    expect(parseImportSeasonsArgs(['s.csv', '--replace-deere'])).toEqual({
      file: 's.csv',
      dryRun: false,
      replaceDeere: true,
    });
    expect(
      formatSeasonReport({
        dryRun: false,
        written: false,
        rows: [
          {
            line: 2,
            field: 'A',
            cropYear: 2025,
            fieldId: null,
            fieldName: null,
            farmName: null,
            action: 'error',
            message: "no field named 'A'",
          },
        ],
        counts: { insert: 0, update: 0, unchanged: 0, error: 1, blocked: 0 },
      }),
    ).toMatch(/no field named 'A'[\s\S]*NOTHING WRITTEN/);
  });
});
