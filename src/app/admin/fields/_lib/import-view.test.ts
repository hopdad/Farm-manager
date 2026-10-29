import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { boundaryView, partyView, problemView, seasonView } from './import-view';
import { PARTIES_TEMPLATE_CSV, SEASONS_TEMPLATE_CSV } from './templates';

const root = path.resolve(import.meta.dirname, '../../../../..');

describe('templates', () => {
  test('the download links offer the committed templates', () => {
    const read = (f: string) =>
      readFileSync(path.join(root, 'tools/import/templates', f), 'utf8').replace(/\r?\n/g, '\r\n');
    expect(SEASONS_TEMPLATE_CSV).toBe(read('seasons.csv'));
    expect(PARTIES_TEMPLATE_CSV).toBe(read('parties.csv'));
  });
});

describe('import views', () => {
  test('boundaries: a preview with changes can be applied', () => {
    const v = boundaryView({
      dryRun: true,
      effectiveAt: '2026-10-29T12:00:00.000Z',
      items: [
        {
          name: 'North 160',
          sourceRef: 'x.zip: a#1',
          action: 'update',
          fieldId: 'f',
          fieldName: 'North 160',
          farmName: 'Home',
          matchedBy: 'deere_id',
          acresBefore: 158.2,
          acresAfter: 160,
          boundaryId: null,
          reason: null,
          warnings: ['overlaps x'],
        },
        {
          name: 'Synced',
          sourceRef: 'x.zip: a#2',
          action: 'skip',
          fieldId: 'g',
          fieldName: 'Synced',
          farmName: 'Home',
          matchedBy: 'name',
          acresBefore: 80,
          acresAfter: 79,
          boundaryId: null,
          reason: 'read-only',
          warnings: [],
        },
      ],
      counts: { create: 0, update: 1, unchanged: 0, skip: 1 },
      farmsCreated: [],
      demoHidden: 0,
    });
    expect(v.canApply).toBe(true);
    expect(v.applied).toBe(false);
    expect(v.rows[0]?.cells).toEqual([
      'update',
      'North 160',
      '',
      'Home',
      'deere id',
      '158.2 → 160.0',
    ]);
    expect(v.problems).toEqual(['North 160: overlaps x', 'Synced: read-only']);
    expect(v.summary).toBe('Preview: 0 new, 1 changed, 0 unchanged, 1 skipped');
  });

  test('seasons and parties: errors block applying', () => {
    const counts = { insert: 1, update: 0, unchanged: 0, error: 1, blocked: 0 };
    const s = seasonView({ dryRun: true, written: false, rows: [], counts });
    expect(s.canApply).toBe(false);
    expect(s.summary).toMatch(/until the 1 row/);
    const p = partyView({
      dryRun: true,
      written: false,
      rows: [],
      counts: { ...counts, error: 0 },
    });
    expect(p.canApply).toBe(true);
    expect(problemView('bad file', ['line 2: x'])).toMatchObject({ canApply: false, rows: [] });
  });
});
