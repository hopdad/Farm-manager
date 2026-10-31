/**
 * Slice 1f deere-ops done-when, in sim mode (CONNECTOR_DEERE=sim, the Deere stand-in's `ops`
 * module): deere.ops (run now, as the clock does every 20 s in the demo) lands this season's
 * operations, and a field's History tab on /board and /m shows them: kind, crop, acres, the
 * seed and its rate, the machine and operator, coverage; a field whose coverage call Deere
 * answers 400 (an active boundary) shows its operation with the measured area and no coverage
 * map. A change to a field's operations (`fields`/`updated` with part 'operations') reaches the
 * open tab without a reload.
 *
 * Demo fields only (seed 1): the realtime test edits one operation row and puts it back, so it
 * runs in the `wall` project only.
 */
import { randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { getConfig } from '../src/config';
import { buildDemoFarm } from '../src/sim/farm/build';
import { SIM_OPS_REFUSED_EVERY } from '../src/sim/vendors/deere/ops-world';
import { e2ePool, signInAs } from './support/auth';
import { mapIdle, mapPathFor, WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });
test.describe.configure({ mode: 'default' });

const JOB_WAIT_MS = 90_000;
const farm = buildDemoFarm(1);
/** A field whose coverage the stand-in serves, and one it refuses (400). */
const MAPPED = farm.fields[0];
const REFUSED = farm.fields[SIM_OPS_REFUSED_EVERY - 1];

async function runDeereOps(): Promise<void> {
  const res = await fetch(`${getConfig().PUBLIC_URL}/api/jobs/deere.ops`, {
    method: 'POST',
    headers: { authorization: `Bearer ${getConfig().JOBS_SECRET}` },
  });
  expect([202]).toContain(res.status);
}

async function operationCount(fieldId: string): Promise<number> {
  const r = await e2ePool().query<{ n: number }>(
    `select count(*)::int as n from farm.operations where field_id = $1`,
    [fieldId],
  );
  return r.rows[0]?.n ?? 0;
}

/** A point inside a field's current boundary. */
async function pointIn(fieldId: string): Promise<{ lng: number; lat: number }> {
  const r = await e2ePool().query<{ lng: number; lat: number }>(
    `select extensions.ST_X(extensions.ST_PointOnSurface(geom)) as lng,
            extensions.ST_Y(extensions.ST_PointOnSurface(geom)) as lat
       from farm.current_boundaries where field_id = $1`,
    [fieldId],
  );
  const p = r.rows[0];
  if (!p) throw new Error(`field ${fieldId} has no boundary`);
  return p;
}

/** Open a field's panel by tapping it on the map, then its History tab. */
async function openHistory(page: Page, fieldId: string, name: string): Promise<void> {
  const at = await pointIn(fieldId);
  await page.evaluate(
    (c) => window.__map?.jumpTo({ center: [c.lng, c.lat], zoom: 15, bearing: 0 }),
    at,
  );
  await mapIdle(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__map
              ?.queryRenderedFeatures({ layers: ['fields-fill'] })
              .map((f) => String(f.properties.id)) ?? [],
        ),
      { timeout: 20_000 },
    )
    .toContain(fieldId);
  const p = await page.evaluate((c) => window.__map?.project(c.lng, c.lat), at);
  if (!p) throw new Error('map not ready');
  await page.touchscreen.tap(p.x, p.y);
  await expect(page.getByTestId('field-panel-title')).toHaveText(name, { timeout: 10_000 });
  await page.getByTestId('field-tab-history').click();
  await expect(page.getByTestId('field-operations')).toBeVisible();
}

test.beforeAll(async () => {
  test.setTimeout(JOB_WAIT_MS + 30_000);
  if (!MAPPED || !REFUSED) throw new Error('demo farm changed');
  const deadline = Date.now() + JOB_WAIT_MS;
  for (;;) {
    if ((await operationCount(MAPPED.id)) > 0 && (await operationCount(REFUSED.id)) > 0) return;
    if (Date.now() > deadline)
      throw new Error('deere.ops landed no operations (is the stand-in up?)');
    await runDeereOps();
    await new Promise((r) => setTimeout(r, 5_000));
  }
});

test("a field's History tab shows this season's operations from Operations Center", async ({
  page,
  context,
}, info) => {
  test.setTimeout(150_000);
  await signInAs(context, 'viewer');
  await page.goto(mapPathFor(info));
  await waitForMap(page, 90_000);

  await openHistory(page, MAPPED?.id as string, MAPPED?.name as string);
  const planting = page.locator('[data-testid="field-operation"][data-kind="seeding"]');
  await expect(planting).toHaveCount(1);
  await expect(planting).toHaveAttribute('data-coverage', 'yes');
  await expect(planting).toHaveAttribute('data-status', 'final');
  await expect(planting).toContainText(/Planting · (corn|soybeans|wheat)/);
  await expect(planting.getByTestId('field-operation-acres')).toContainText(/\d+(\.\d)? ac/);
  await expect(planting.getByTestId('field-operation-products')).toContainText('seeds/ac');
  await expect(planting).toContainText('P1 · Dale Mercer');
  await expect(planting).toContainText('coverage mapped');

  // Deere answered 400 for this field's coverage: the measured area, no coverage map.
  await page.getByTestId('field-panel-close').click();
  await openHistory(page, REFUSED?.id as string, REFUSED?.name as string);
  const refused = page.locator('[data-testid="field-operation"][data-kind="seeding"]');
  await expect(refused).toHaveAttribute('data-coverage', 'no');
  await expect(refused).toContainText('no coverage map');
  await expect(refused.getByTestId('field-operation-acres')).toContainText(/\d+(\.\d)? ac/);
});

test("a change to the field's operations reaches the open tab without a reload", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== 'wall', 'edits a shared demo row: wall only');
  test.setTimeout(150_000);
  const fieldId = MAPPED?.id as string;
  await signInAs(context, 'viewer');
  await page.goto('/board');
  await waitForMap(page, 90_000);
  await openHistory(page, fieldId, MAPPED?.name as string);
  const planting = page.locator('[data-testid="field-operation"][data-kind="seeding"]');
  await expect(planting).toContainText('Dale Mercer');

  const pool = e2ePool();
  const name = `E2E operator ${randomBytes(3).toString('hex')}`;
  const tell = () =>
    pool.query(`select app.publish('fields', 'updated', $1::jsonb)`, [
      JSON.stringify({ fieldId, parts: ['operations'] }),
    ]);
  try {
    await pool.query(
      `update farm.operations set operator_name = $2 where field_id = $1 and kind = 'seeding'`,
      [fieldId, name],
    );
    await tell();
    await expect(planting).toContainText(name, { timeout: 5_000 });
  } finally {
    await pool.query(
      `update farm.operations set operator_name = 'Dale Mercer' where field_id = $1 and kind = 'seeding'`,
      [fieldId],
    );
    await tell();
  }
  await expect(planting).toContainText('Dale Mercer', { timeout: 5_000 });
});
