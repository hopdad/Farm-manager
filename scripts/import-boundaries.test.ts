import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { rectangle, shapefileFiles } from '../tools/import/testing/shapefile';
import { parseImportBoundariesArgs, readInputFiles, UsageError } from './import-boundaries';

describe('parseImportBoundariesArgs', () => {
  test('defaults and options', () => {
    expect(parseImportBoundariesArgs(['fields.zip'])).toMatchObject({
      file: 'fields.zip',
      options: { dryRun: false, create: true, hideDemo: false, effectiveAt: null, tenure: null },
    });
    const a = parseImportBoundariesArgs([
      'x.shp',
      '--dry-run',
      '--farm',
      'Home',
      '--tenure',
      'cash_rent',
      '--county',
      '26115',
      '--effective',
      '3/1/2026',
      '--no-create',
      '--hide-demo',
      '--name-attr',
      'TRACT',
      '--min-overlap',
      '0.3',
    ]);
    expect(a.options).toMatchObject({
      dryRun: true,
      farm: 'Home',
      tenure: 'cash_rent',
      countyFips: '26115',
      create: false,
      hideDemo: true,
      minNameOverlap: 0.3,
    });
    // Midnight in Detroit (EST) is 05:00 UTC.
    expect(a.options.effectiveAt?.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(a.attributes.nameAttr).toBe('TRACT');
  });

  test('bad input is a usage error', () => {
    for (const argv of [
      [],
      ['a', 'b'],
      ['a', '--tenure', 'rented'],
      ['a', '--county', '91'],
      ['a', '--effective', '2/3/25'],
      ['a', '--effective', '2999-01-01'],
      ['a', '--min-overlap', '2'],
      ['a', '--bogus'],
    ]) {
      expect(() => parseImportBoundariesArgs(argv), argv.join(' ')).toThrow(UsageError);
    }
  });
});

describe('readInputFiles', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test('a .shp brings its .dbf/.prj siblings, whatever their extension case', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'farm-import-'));
    dirs.push(dir);
    const files = shapefileFiles('Fields', [
      { geometry: rectangle(-84, 41.9, 300, 300), attributes: { NAME: 'A' } },
    ]);
    for (const [name, bytes] of Object.entries(files)) {
      const upper = name.endsWith('.dbf') ? name.replace('.dbf', '.DBF') : name;
      await writeFile(path.join(dir, upper), bytes);
    }
    await writeFile(path.join(dir, 'Other.dbf'), new Uint8Array([1]));
    const read = await readInputFiles(path.join(dir, 'Fields.shp'));
    expect(read.map((f) => f.name).sort()).toEqual(['Fields.DBF', 'Fields.prj', 'Fields.shp']);
  });
});
