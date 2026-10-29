/** Crop history: the CSV import, the History tab's view through lineage, and its edits. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseBoundaryFiles } from '../../../tools/import/boundary-file';
import { parseSeasonsCsv } from '../../../tools/import/seasons-csv';
import { setupTestDb } from '../../test/db';
import { importBoundaries } from './boundaries';
import { fieldDetail } from './fields';
import {
  deleteSeason,
  fieldHistory,
  importSeasons,
  resolveSeasonField,
  saveSeason,
  seasonsOf,
  suggestNames,
} from './seasons';

const t = setupTestDb(import.meta.url);
const actor = { appUserId: null, displayName: 'Test' };

async function field(name: string, farm = 'Home', opts: { active?: boolean } = {}) {
  const { pool } = t();
  const fa = await pool.query<{ id: string }>(
    `insert into farm.farms (name) values ($1) returning id`,
    [farm],
  );
  const f = await pool.query<{ id: string }>(
    `insert into farm.fields (farm_id, name, tenure, active) values ($1, $2, 'owned', $3) returning id`,
    [fa.rows[0]?.id, name, opts.active ?? true],
  );
  return f.rows[0]?.id as string;
}

const csv = (...lines: string[]) =>
  parseSeasonsCsv(
    ['field,crop_year,crop,variety,planted_on,harvested_on,yield_bu_ac,farm', ...lines].join('\n'),
    2026,
  ).rows;

describe('importSeasons', () => {
  test('adds, then finds unchanged, then replaces; publishes fields/updated', async () => {
    const { pool } = t();
    const id = await field('Seasons North');
    const rows = csv(
      'Seasons North,2025,corn,P1197,4/28/2025,10/30/2025,212.5,',
      'seasons  north,2024,soybeans,,,,61,',
    );
    const first = await importSeasons(pool, rows);
    expect(first).toMatchObject({ written: true, counts: { insert: 2, error: 0 } });
    expect(first.rows.every((r) => r.fieldId === id)).toBe(true);
    const again = await importSeasons(pool, rows);
    expect(again.counts).toMatchObject({ insert: 0, update: 0, unchanged: 2 });
    const changed = await importSeasons(pool, csv('Seasons North,2025,corn,P1197,,,199,'));
    expect(changed.counts.update).toBe(1);
    const s = await seasonsOf(pool, 'Seasons North');
    expect(s.map((x) => [x.cropYear, x.crop, x.yieldBuAc, x.plantedOn, x.source])).toEqual([
      [2025, 'corn', 199, null, 'import'],
      [2024, 'soybeans', 61, null, 'import'],
    ]);
  });

  test('all or nothing: unknown and ambiguous fields block every row', async () => {
    const { pool } = t();
    await field('Twin Pines', 'East farm');
    await field('Twin Pines', 'West farm');
    await field('Lonely 40');
    const r = await importSeasons(
      pool,
      csv(
        'Lonely 40,2025,corn,,,,180,',
        'Twin Pines,2025,corn,,,,180,',
        'Lonly 40,2024,corn,,,,1,',
      ),
    );
    expect(r.written).toBe(false);
    expect(r.rows.map((x) => x.action)).toEqual(['blocked', 'error', 'error']);
    expect(r.rows[1]?.message).toMatch(/2 fields are named 'Twin Pines'.*add a farm column/);
    expect(r.rows[2]?.message).toMatch(/did you mean 'Lonely 40'/);
    expect(await seasonsOf(pool, 'Lonely 40')).toEqual([]);
    // The farm column settles it.
    const ok = await importSeasons(pool, csv('Twin Pines,2025,corn,,,,180,west farm'));
    expect(ok.rows[0]).toMatchObject({ action: 'insert', farmName: 'West farm' });
  });

  test('Operations Center seasons need --replace-deere; dry run writes nothing', async () => {
    const { pool } = t();
    const id = await field('Synced 160');
    await pool.query(
      `insert into farm.field_seasons (field_id, crop_year, crop, source) values ($1, 2025, 'corn', 'deere')`,
      [id],
    );
    const refused = await importSeasons(pool, csv('Synced 160,2025,soybeans,,,,50,'));
    expect(refused.rows[0]?.message).toMatch(/came from Operations Center/);
    const dry = await importSeasons(pool, csv('Synced 160,2025,soybeans,,,,50,'), {
      replaceDeere: true,
      dryRun: true,
    });
    expect(dry).toMatchObject({ written: false, dryRun: true, counts: { update: 1 } });
    expect((await seasonsOf(pool, 'Synced 160'))[0]?.source).toBe('deere');
    await importSeasons(pool, csv('Synced 160,2025,soybeans,,,,50,'), { replaceDeere: true });
    expect((await seasonsOf(pool, 'Synced 160'))[0]).toMatchObject({
      crop: 'soybeans',
      source: 'import',
    });
  });
});

describe('the README demo files (M1 demo, step 5)', () => {
  test('boundaries-example.geojson, then seasons-example.csv: each new field shows 5 seasons', async () => {
    const { pool } = t();
    const templates = path.join(import.meta.dirname, '..', '..', '..', 'tools', 'import', 'templates');
    const geojson = new Uint8Array(await readFile(path.join(templates, 'boundaries-example.geojson')));
    const parsed = await parseBoundaryFiles([{ name: 'boundaries-example.geojson', bytes: geojson }]);
    const b = await importBoundaries(pool, parsed.boundaries);
    expect(b.items.map((i) => [i.name, i.action])).toEqual([
      ['Prospect South 80', 'create'],
      ['Prospect North 80', 'create'],
    ]);
    const text = await readFile(path.join(templates, 'seasons-example.csv'), 'utf8');
    const s = await importSeasons(pool, parseSeasonsCsv(text, 2026).rows);
    expect(s).toMatchObject({ written: true, counts: { insert: 10, error: 0 } });
    for (const item of b.items) {
      const detail = await fieldDetail(pool, item.fieldId as string);
      expect(detail?.seasons.map((x) => x.cropYear), item.name).toEqual([2025, 2024, 2023, 2022, 2021]);
    }
  });
});

describe('History', () => {
  test('a split child shows its parent seasons up to the split year', async () => {
    const { pool } = t();
    const parent = await field('Old 160', 'Home', { active: false });
    const child = await field('Old 160 East');
    const grand = await field('Older 320', 'Home', { active: false });
    for (const [f, y, crop] of [
      [grand, 2019, 'corn'],
      [parent, 2023, 'corn'],
      [parent, 2024, 'soybeans'],
      [parent, 2026, 'corn'],
      [child, 2026, 'wheat'],
    ] as const) {
      await pool.query(
        `insert into farm.field_seasons (field_id, crop_year, crop) values ($1, $2, $3)`,
        [f, y, crop],
      );
    }
    await pool.query(
      `insert into farm.field_lineage (parent_field_id, child_field_id, kind, effective_on)
       values ($1, $2, 'split', '2025-03-01'), ($3, $1, 'merge', '2020-01-15')`,
      [parent, child, grand],
    );
    const h = await fieldHistory(pool, child);
    expect(h?.seasons.map((s) => s.cropYear)).toEqual([2026]);
    expect(h?.ancestors.map((a) => [a.name, a.kind, a.effectiveOn, a.depth])).toEqual([
      ['Old 160', 'split', '2025-03-01', 1],
      ['Older 320', 'merge', '2020-01-15', 2],
    ]);
    expect(h?.ancestors[0]?.seasons.map((s) => s.cropYear)).toEqual([2024, 2023]);
    expect(h?.ancestors[1]?.seasons.map((s) => s.cropYear)).toEqual([2019]);
    const p = await fieldHistory(pool, parent);
    expect(p?.children).toEqual([
      { fieldId: child, name: 'Old 160 East', kind: 'split', effectiveOn: '2025-03-01' },
    ]);
    expect(await fieldHistory(pool, '4b7f1c52-8e0a-5d3b-9a61-2f0c8d4e7a19')).toBeNull();
  });

  test('add, edit, move and delete a season', async () => {
    const { pool } = t();
    const id = await field('Edit 80');
    const season = {
      cropYear: 2024,
      crop: 'corn',
      variety: null,
      plantedOn: '2024-05-01',
      harvestedOn: null,
      yieldBuAc: 180,
    };
    expect(await saveSeason(pool, { fieldId: id, season, originalCropYear: null, actor })).toEqual({
      action: 'insert',
    });
    await expect(
      saveSeason(pool, { fieldId: id, season, originalCropYear: null, actor }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await saveSeason(pool, {
        fieldId: id,
        season: { ...season, yieldBuAc: 181 },
        originalCropYear: 2024,
        actor,
      }),
    ).toEqual({ action: 'update' });
    await saveSeason(pool, {
      fieldId: id,
      season: { ...season, cropYear: 2023 },
      originalCropYear: 2024,
      actor,
    });
    const s = await seasonsOf(pool, 'Edit 80');
    expect(s.map((x) => [x.cropYear, x.yieldBuAc, x.source])).toEqual([[2023, 180, 'app']]);
    await expect(
      saveSeason(pool, { fieldId: id, season, originalCropYear: 2010, actor }),
    ).rejects.toMatchObject({ code: 'stale' });
    await deleteSeason(pool, { fieldId: id, cropYear: 2023, actor });
    expect(await seasonsOf(pool, 'Edit 80')).toEqual([]);
    await expect(deleteSeason(pool, { fieldId: id, cropYear: 2023, actor })).rejects.toMatchObject({
      code: 'stale',
    });
  });
});

describe('resolveSeasonField / suggestNames', () => {
  const fields = [
    { id: 'a', name: 'North 80', farmName: 'Home', active: true },
    { id: 'b', name: 'North 80', farmName: 'Old', active: false },
    { id: 'c', name: 'South 80', farmName: 'Home', active: true },
  ];
  test('an active field wins over an inactive one of the same name', () => {
    expect(
      resolveSeasonField({ field: 'north 80', farm: null, fieldId: null }, fields),
    ).toMatchObject({
      ok: true,
      field: { id: 'a' },
    });
    expect(resolveSeasonField({ field: '', farm: null, fieldId: 'c' }, fields)).toMatchObject({
      ok: true,
      field: { id: 'c' },
    });
  });
  test('suggestions are close names only', () => {
    expect(suggestNames('Nroth 80', ['North 80', 'South 80', 'Pond'])).toEqual(['North 80']);
    expect(suggestNames('Nort 80', ['North 80', 'Nort 81'])).toEqual(['Nort 81', 'North 80']);
    expect(suggestNames('Zzz', ['North 80'])).toEqual([]);
  });
});
