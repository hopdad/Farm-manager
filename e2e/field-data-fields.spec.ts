/**
 * /admin/fields (plan 1c), as a manager on the wall:
 *  1. import an Operations-Center-style shapefile zip (built at test time): preview, apply;
 *  2. split one new field with a line drawn on the map, then merge the pieces back: lineage
 *     shows in the History tab;
 *  3. import crop history from a CSV and correct a season in the History tab;
 *  4. a Deere field is read-only, with the "change this in Ops Center" note (D6);
 *  5. draw a brand-new field on the map.
 * Writes to the app's database under a farm of its own and removes it afterwards.
 */
import { randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import type { Pool } from 'pg';
import { getConfig } from '../src/config';
import { createPool } from '../src/db/client';
import { rectangle, shapefileFiles, zip } from '../tools/import/testing/shapefile';
import { signInAs } from './support/auth';
import { WEBGL_ARGS } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });
test.describe.configure({ mode: 'serial' });

const run = randomBytes(3).toString('hex');
const FARM = `Farm e2e ${run}`;
const NORTH = `North e2e ${run}`;
const CREEK = `Creek e2e ${run}`;
// West of the demo farm, where no demo field lies; a random spot per run.
const LNG = -84.42 + Math.random() * 0.08;
const LAT = 41.7 + Math.random() * 0.04;
const dLng = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));

let pool: Pool;

test.beforeAll(() => {
  pool = createPool({ connectionString: getConfig().DATABASE_URL, max: 2 });
});

test.afterAll(async () => {
  await pool.query(
    `delete from farm.fields where farm_id in (select id from farm.farms where name = any ($1::text[]))`,
    [[FARM, `Drawn e2e ${run}`]],
  );
  await pool.query(`delete from farm.farms where name = any ($1::text[])`, [
    [FARM, `Drawn e2e ${run}`],
  ]);
  await pool.end();
});

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'wall', 'the editor flows run on the wall');
  await signInAs(page.context(), 'manager');
});

async function fieldId(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    'select id from farm.fields where name = $1 and active order by created_at desc limit 1',
    [name],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`no active field ${name}`);
  return id;
}

async function openEditor(page: Page, id: string): Promise<void> {
  await page.goto(`/admin/fields/${id}`);
  await page.waitForFunction(() => window.__fieldEditor?.map.loaded() === true);
}

/** Screen position of a [lng, lat] on the editor's map. */
async function screen(page: Page, lngLat: [number, number]): Promise<{ x: number; y: number }> {
  return page.evaluate((ll) => {
    const e = window.__fieldEditor;
    if (!e) throw new Error('no editor');
    const p = e.map.project(ll);
    const r = e.map.getCanvas().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, lngLat);
}

async function tapMap(page: Page, lngLat: [number, number]): Promise<void> {
  const p = await screen(page, lngLat);
  await page.mouse.click(p.x, p.y);
}

test('import an Operations Center shapefile export: preview, then apply', async ({ page }) => {
  const files = shapefileFiles('Boundaries/Hopson', [
    {
      geometry: rectangle(LNG, LAT, 402, 805),
      attributes: { CLIENT_NAME: 'Hopson', FARM_NAME: 'Home', FIELD_NAME: NORTH },
    },
    {
      geometry: rectangle(LNG + dLng(402), LAT, 402, 805),
      attributes: { CLIENT_NAME: 'Hopson', FARM_NAME: 'Home', FIELD_NAME: CREEK },
    },
  ]);
  await page.goto('/admin/fields');
  const panel = page.getByTestId('boundary-import');
  await panel.getByTestId('boundary-import-file').setInputFiles({
    name: 'ops-center-export.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zip(files)),
  });
  await panel.getByTestId('boundary-import-farm').fill(FARM);
  await panel.getByTestId('boundary-import-preview').click();
  const result = panel.getByTestId('boundary-import-result');
  await expect(result).toContainText('Preview: 2 new, 0 changed');
  await expect(panel.locator('tr[data-tone="create"]')).toHaveCount(2);
  expect(await pool.query('select 1 from farm.fields where name = $1', [NORTH])).toMatchObject({
    rowCount: 0,
  });
  await panel.getByTestId('boundary-import-apply').click();
  await expect(result).toContainText('Done:');
  await expect(result).toContainText('2 new');
  await expect(page.getByTestId('fields-table').locator(`tr[data-field="${NORTH}"]`)).toContainText(
    FARM,
  );

  // The same file again changes nothing.
  await panel.getByTestId('boundary-import-file').setInputFiles({
    name: 'ops-center-export.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zip(files)),
  });
  await panel.getByTestId('boundary-import-preview').click();
  await expect(result).toContainText('0 new, 0 changed, 2 unchanged');
  await expect(panel.getByTestId('boundary-import-apply')).toHaveCount(0);
});

test('split a field with a drawn line, then merge the pieces back', async ({ page }) => {
  await openEditor(page, await fieldId(NORTH));
  await page.getByTestId('tool-split').click();
  const mid = LNG + dLng(201);
  // From just south of the field to just north of it (30 m outside each edge).
  await tapMap(page, [mid, LAT - 0.0003]);
  await tapMap(page, [mid, LAT + 805 / 111_132 + 0.0003]);
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-name-0')).toHaveValue(`${NORTH} A`);
  await page.getByTestId('split-name-1').fill(`${NORTH} East`);
  await page.getByTestId('split-apply').click();
  await expect(page.getByTestId('field-title')).toContainText(`${NORTH} A`);
  const history = page.getByTestId('history-card');
  await expect(history.getByTestId('history-ancestor')).toContainText(`Split from ${NORTH}`);

  // Merge A with its neighbour East.
  await page.waitForFunction(() => window.__fieldEditor?.map.loaded() === true);
  await page.getByTestId('tool-merge').click();
  const other = page.getByTestId('merge-other');
  await other.selectOption({ label: `${NORTH} East` });
  await expect(page.getByTestId('merge-name')).toHaveValue(`${NORTH} A + ${NORTH} East`);
  await page.getByTestId('merge-name').fill(`${NORTH} Whole`);
  await page.getByTestId('merge-apply').click();
  await expect(page.getByTestId('field-title')).toContainText(`${NORTH} Whole`);
  await expect(
    page.getByTestId('history-card').getByTestId('history-ancestor').first(),
  ).toContainText('Merged from');
  const r = await pool.query<{ n: number }>(
    `select count(*)::int as n from farm.field_lineage l join farm.fields f on f.id = l.child_field_id
      where f.name like $1`,
    [`${NORTH}%`],
  );
  expect(r.rows[0]?.n).toBe(4);
});

test('crop history from a CSV, corrected in the History tab', async ({ page }) => {
  await page.goto('/admin/fields');
  const panel = page.getByTestId('season-import');
  const csv = [
    'field,crop_year,crop,variety,planted_on,harvested_on,yield_bu_ac',
    `${CREEK},2024,corn,P1197,4/28/2024,10/30/2024,201.5`,
    `${CREEK},2023,Soybean,,5/12/2023,10/2/2023,58`,
  ].join('\r\n');
  await panel.getByTestId('season-import-file').setInputFiles({
    name: 'aph.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await panel.getByTestId('season-import-preview').click();
  await expect(panel.getByTestId('season-import-result')).toContainText('Preview: 2 new');
  await panel.getByTestId('season-import-apply').click();
  await expect(panel.getByTestId('season-import-result')).toContainText('Done:');

  await page.goto(`/admin/fields/${await fieldId(CREEK)}`);
  const history = page.getByTestId('history-card');
  await expect(history.getByTestId('history-season-2023')).toContainText('soybeans');
  await history.getByTestId('history-edit-2024').click();
  await history.getByTestId('history-yield').fill('205');
  await history.getByTestId('history-save').click();
  await expect(history.getByTestId('history-message')).toHaveText('2024 saved');
  await expect(history.getByTestId('history-season-2024')).toContainText('205.0');
  // A bad value is refused with the reason.
  await history.getByTestId('history-add').click();
  await history.getByTestId('history-year').fill('2025');
  await history.getByTestId('history-yield').fill('lots');
  await history.getByTestId('history-save').click();
  await expect(history.getByTestId('history-message')).toContainText('not a number of bushels');
});

test('a Deere field is read-only: change it in Ops Center (D6)', async ({ page }) => {
  const r = await pool.query<{ id: string }>(
    `select id from farm.fields where deere_field_id is not null and active order by name limit 1`,
  );
  await openEditor(page, r.rows[0]?.id as string);
  await expect(page.getByTestId('ops-center-note')).toContainText('Change this in Ops Center');
  await expect(page.getByTestId('tool-edit')).toHaveCount(0);
  await expect(page.getByTestId('tool-split')).toHaveCount(0);
  await expect(page.getByTestId('tool-propose')).toBeVisible();
  await expect(page.getByTestId('identity-name')).toHaveAttribute('readonly', '');
});

test('draw a new field on the map', async ({ page }) => {
  await page.goto('/admin/fields/new');
  await page.waitForFunction(() => window.__fieldEditor?.map.loaded() === true);
  const x = LNG + dLng(1500);
  // Zoom the editor to the spot first (a new field starts at the farm's extent).
  await page.evaluate((c) => window.__fieldEditor?.map.jumpTo({ center: c, zoom: 15 }), [
    x + dLng(200),
    LAT + 0.0018,
  ] as [number, number]);
  await page.waitForTimeout(300);
  for (const p of [
    [x, LAT],
    [x + dLng(400), LAT],
    [x + dLng(400), LAT + 0.0036],
    [x, LAT + 0.0036],
  ] as [number, number][]) {
    await tapMap(page, p);
  }
  await page.getByTestId('draw-finish').click();
  await page.getByTestId('new-field-name').fill(`Drawn e2e ${run}`);
  await page.getByTestId('new-field-form').locator('select').first().selectOption('new');
  await page.getByTestId('new-field-form').getByLabel('New farm name').fill(`Drawn e2e ${run}`);
  await page.getByTestId('new-field-create').click();
  await expect(page.getByTestId('field-title')).toContainText(`Drawn e2e ${run}`);
  await expect(page.getByTestId('versions-card')).toContainText('drawn');
});
