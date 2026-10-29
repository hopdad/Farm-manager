/**
 * import:tile against a real database (as farm_app): lines land with their field (by overlap or
 * --field), a re-import changes nothing, a corrected file updates in place, --replace removes
 * lines the file dropped, and the tile layer is published only when something changed.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { setupTestDb } from '../../src/test/db';
import { insertField, squareMultiPolygon } from '../../src/test/fixtures';
import { readVectorInput } from '../gis/parcels-io';
import { resolveField } from './tile';
import { loadTileLines } from './tile-load';
import { mapTileFeatures } from './tile-map';

const t = setupTestDb(import.meta.url);
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'farm-tile-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fc = (features: object[]) => JSON.stringify({ type: 'FeatureCollection', features });
const line = (coords: number[][], props: Record<string, unknown>) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: coords },
  properties: props,
});

async function load(
  file: string,
  text: string,
  opts: { replace?: boolean; fieldId?: string | null } = {},
) {
  const p = path.join(dir, file);
  await writeFile(p, text);
  const src = await readVectorInput(p);
  const mapped = mapTileFeatures(src.features, { fileKey: file });
  return loadTileLines(
    t().pool,
    mapped.records,
    { origin: 'installer_drawing', sourceRef: file, fieldId: opts.fieldId ?? null },
    { replace: opts.replace },
  );
}

async function layersSeq(): Promise<number> {
  const r = await t().pool.query<{ seq: string }>(
    `select seq from app.topic_seq where topic = 'layers'`,
  );
  return Number(r.rows[0]?.seq ?? 0);
}

describe('import:tile', () => {
  test('lines land on their fields; a re-import changes nothing and publishes nothing', async () => {
    const { fieldId } = await insertField(t().db, {
      name: 'Tile Test 40',
      geom: squareMultiPolygon(-84.06, 41.89, 400),
    });
    const text = fc([
      line(
        [
          [-84.0595, 41.8905],
          [-84.0595, 41.8925],
        ],
        { TYPE: 'Main', SIZE: '6', DEPTH: '4' },
      ),
      line(
        [
          [-84.2, 41.5],
          [-84.2, 41.51],
        ],
        { TYPE: 'Lateral' },
      ),
    ]);
    const before = await layersSeq();
    const r = await load('drawing.geojson', text);
    expect(r).toMatchObject({ inserted: 2, updated: 0, deleted: 0, noField: 1 });
    expect(r.version).toMatch(/^[0-9a-f]{12}$/);
    expect(await layersSeq()).toBe(before + 1);
    const rows = await t().pool.query<{
      field_id: string | null;
      kind: string;
      source: string;
      source_ref: string;
      origin: string;
    }>(
      'select field_id::text, kind, source, source_ref, origin from farm.tile_lines order by kind',
    );
    expect(rows.rows).toEqual([
      {
        field_id: null,
        kind: 'lateral',
        source: 'import',
        source_ref: 'drawing.geojson',
        origin: 'installer_drawing',
      },
      {
        field_id: fieldId,
        kind: 'main',
        source: 'import',
        source_ref: 'drawing.geojson',
        origin: 'installer_drawing',
      },
    ]);

    const again = await load('drawing.geojson', text);
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 2, version: null });
    expect(await layersSeq()).toBe(before + 1);
  });

  test('a corrected file updates its lines in place; --replace removes what it dropped (same file name only)', async () => {
    const v2 = fc([
      line(
        [
          [-84.059, 41.8905],
          [-84.059, 41.8925],
        ],
        { TYPE: 'Submain', SIZE: '8' },
      ),
    ]);
    const corrected = await load('drawing.geojson', v2);
    expect(corrected).toMatchObject({ inserted: 0, updated: 1, deleted: 0 });
    const first = await t().pool.query<{ kind: string; size_in: string }>(
      `select kind, size_in::text from farm.tile_lines where source_id = 'drawing.geojson#1'`,
    );
    expect(first.rows).toEqual([{ kind: 'submain', size_in: '8.00' }]);
    await load(
      'other.geojson',
      fc([
        line(
          [
            [-84.0585, 41.8905],
            [-84.0585, 41.8925],
          ],
          {},
        ),
      ]),
    );
    const replaced = await load('drawing.geojson', v2, { replace: true });
    expect(replaced).toMatchObject({ inserted: 0, unchanged: 1, deleted: 1 });
    const refs = await t().pool.query<{ source_ref: string; n: number }>(
      'select source_ref, count(*)::int as n from farm.tile_lines group by 1 order by 1',
    );
    expect(refs.rows).toEqual([
      { source_ref: 'drawing.geojson', n: 1 },
      { source_ref: 'other.geojson', n: 1 },
    ]);
  });

  test('--field pins every line; names resolve case-insensitively; unknown names fail', async () => {
    const id = await resolveField(t().pool, 'tile test 40');
    const r = await load(
      'pinned.geojson',
      fc([
        line(
          [
            [-84.2, 41.5],
            [-84.2, 41.51],
          ],
          {},
        ),
      ]),
      { fieldId: id },
    );
    expect(r).toMatchObject({ inserted: 1, noField: 0 });
    await expect(resolveField(t().pool, 'No Such Field')).rejects.toThrow(/no active field/);
    await expect(
      load(
        'bad.geojson',
        fc([
          line(
            [
              [-84.2, 41.5],
              [-84.2, 41.51],
            ],
            {},
          ),
        ]),
        { fieldId: '00000000-0000-4000-8000-000000000000' },
      ),
    ).rejects.toThrow(/no field/);
  });
});
