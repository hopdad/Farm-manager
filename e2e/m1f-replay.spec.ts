/**
 * Slice 1f done-when in replay mode (docs/contracts-1f.md §11.5), against the real app and
 * database with no stand-in and no OAuth for Deere and Samsara (the doc-derived fixtures):
 *  - the demo fields matched to Deere's (no duplicate, each with its Deere boundary current),
 *    plus the Deere-only field with tenure "not set";
 *  - Deere flags as read-only pins: the "Deere flags" toggle in the rail and a popup;
 *  - Deere machines from the Equipment API fixture with engine hours;
 *  - a field's History tab with this season's operations;
 *  - the Samsara fault badge on the fleet panel (S3 critical, S2 warning);
 *  - /admin/connectors with call counts in replay, the org status and the doc-derived list.
 *
 * Runs only against an app started in replay mode (CI's replay step); under the default sim
 * stack it skips, like e2e/fleet-panel-replay.spec.ts. To run by hand:
 *   PowerShell:  $env:CONNECTOR_DEERE='replay'; $env:CONNECTOR_SAMSARA='replay'; pnpm pilot
 *   then:        pnpm test:e2e e2e/m1f-replay.spec.ts --project=wall
 */
import { expect, type Page, test } from '@playwright/test';
import { fleetPanelDataSchema } from '../src/ui/fleet/contract';
import { e2ePool, signInAs } from './support/auth';
import { mapIdle, WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });
// One worker runs the file in order: the first test waits for the replayed Deere sync.
test.describe.configure({ mode: 'default' });

/** deere.fields runs every 45 s and deere.ops every 20 s in the demo cadence. */
const SYNC_WAIT_MS = 150_000;

async function modes(page: Page) {
  const res = await page.request.get('/api/machines');
  expect(res.status()).toBe(200);
  return fleetPanelDataSchema.parse(await res.json());
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'wall', 'run once');
  await signInAs(page.context(), 'viewer');
  const data = await modes(page);
  test.skip(
    data.modes.deere !== 'replay' || data.modes.samsara !== 'replay',
    'start the app with CONNECTOR_DEERE=replay and CONNECTOR_SAMSARA=replay',
  );
});

const one = async <T>(sql: string, params: unknown[] = []): Promise<T | undefined> =>
  (await e2ePool().query(sql, params)).rows[0] as T | undefined;

/** Turn a rail layer on or off (the rail opens if it is closed). */
async function setLayer(page: Page, key: string, on: boolean): Promise<void> {
  const rail = page.getByTestId('layer-rail');
  if (!(await rail.isVisible())) await page.getByTestId('layer-rail-toggle').click();
  const toggle = page.getByTestId(`layer-toggle-${key}`);
  if ((await toggle.getAttribute('aria-pressed')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', String(on));
}

async function tapAt(page: Page, at: { lng: number; lat: number }): Promise<void> {
  await page.evaluate((c) => window.__map?.jumpTo({ center: [c.lng, c.lat], zoom: 16 }), at);
  await mapIdle(page);
  const p = await page.evaluate((c) => window.__map?.project(c.lng, c.lat), at);
  if (!p) throw new Error('map not ready');
  await page.touchscreen.tap(p.x, p.y);
}

test('Deere fields: the demo fields matched (no duplicate), Deere boundaries current, the Deere-only field', async () => {
  test.setTimeout(SYNC_WAIT_MS + 30_000);
  await expect
    .poll(
      async () =>
        (
          await one<{ n: number }>(
            `select count(*)::int as n from farm.current_boundaries b
               join farm.fields f on f.id = b.field_id
              where f.source = 'demo' and b.source = 'deere'`,
          )
        )?.n ?? 0,
      { timeout: SYNC_WAIT_MS, message: 'deere.fields landed the replayed boundaries' },
    )
    .toBeGreaterThanOrEqual(40);
  const fields = await one<{ demo: number; dup: number }>(
    `select (select count(*)::int from farm.fields where source = 'demo') as demo,
            (select count(*)::int from (
               select deere_field_id from farm.fields
                where deere_field_id is not null and active
                group by deere_field_id having count(*) > 1) d) as dup`,
  );
  expect(fields).toEqual({ demo: 40, dup: 0 });
  // Every demo field's seeded version is history now; the ref points at the Deere one.
  const history = await one<{ n: number }>(
    `select count(*)::int as n from farm.field_boundaries b join farm.fields f on f.id = b.field_id
      where f.source = 'demo' and b.source = 'demo' and upper_inf(b.valid)`,
  );
  expect(history?.n).toBe(0);
  await expect
    .poll(
      async () =>
        (
          await one<{ n: number }>(
            `select count(*)::int as n from farm.fields
              where name = 'New Ground 80' and tenure = 'unknown' and source = 'deere'`,
          )
        )?.n,
      { timeout: SYNC_WAIT_MS },
    )
    .toBe(1);
});

test('Deere flags: read-only pins behind the "Deere flags" toggle, a tap opens the popup', async ({
  page,
}) => {
  test.setTimeout(SYNC_WAIT_MS);
  await expect
    .poll(
      async () =>
        (
          await one<{ n: number }>(
            `select count(*)::int as n from farm.pins
              where source = 'deere_flag' and read_only and resolved_at is null`,
          )
        )?.n ?? 0,
      { timeout: SYNC_WAIT_MS },
    )
    .toBeGreaterThan(0);
  const pin = await one<{ id: string; lng: number; lat: number; category: string }>(
    `select p.id::text as id, extensions.ST_X(p.geom) as lng, extensions.ST_Y(p.geom) as lat,
            p.category
       from farm.pins p
      where p.source = 'deere_flag' and p.read_only and p.resolved_at is null
        and extensions.GeometryType(p.geom) = 'POINT'
      order by p.id limit 1`,
  );
  if (!pin) throw new Error('no point flag replayed');

  await page.goto('/board');
  await waitForMap(page, 90_000);
  await expect.poll(() => page.evaluate(() => window.__pins?.ids() ?? [])).toContain(pin.id);
  await expect(page.getByTestId('layer-toggle-pins')).toContainText('Deere flags');
  // No machine under the finger: machines win taps (machine > pin > field).
  await setLayer(page, 'fleet', false);
  await tapAt(page, pin);
  const popup = page.getByTestId('pin-popup');
  await expect(popup).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => window.__pins?.open())).toBe(pin.id);
  await expect(page.getByTestId('pin-popup-origin')).toHaveText(
    'From Operations Center (read-only)',
  );
  await expect(page.getByTestId('field-panel')).toHaveCount(0);
  await setLayer(page, 'fleet', true);
});

test('Deere machines from the Equipment API fixture carry their engine hours', async ({ page }) => {
  test.setTimeout(SYNC_WAIT_MS);
  // The machines the replayed Deere org maps (by principalId) report hours through deere.fields.
  await expect
    .poll(
      async () => {
        const data = await modes(page);
        return data.machines.filter(
          (m) =>
            m.position?.vendor === 'deere' &&
            typeof m.engineHours === 'number' &&
            m.engineHours > 0,
        ).length;
      },
      { timeout: SYNC_WAIT_MS, message: 'Deere machines with engine hours on /api/machines' },
    )
    .toBeGreaterThanOrEqual(2);
  const hours = await one<{ n: number }>(
    `select count(distinct machine_id)::int as n from farm.machine_hours where source = 'deere'`,
  );
  expect(hours?.n).toBeGreaterThanOrEqual(2);
  await page.goto('/board');
  await waitForMap(page, 90_000);
  const deere = (await modes(page)).machines.find(
    (m) => m.position?.vendor === 'deere' && (m.engineHours ?? 0) > 0,
  );
  const row = page.locator(`[data-testid="fleet-panel-row"][data-machine-id="${deere?.id}"]`);
  await expect(row.getByTestId('fleet-stats')).toContainText(/[\d,]+ h/, { timeout: 30_000 });
  await expect(row.getByTestId('fleet-vendor-badge')).toHaveText('John Deere · replay');
});

test("a field's History tab shows this season's operations", async ({ page }) => {
  test.setTimeout(SYNC_WAIT_MS + 30_000);
  await expect
    .poll(
      async () =>
        (
          await one<{ n: number }>(
            `select count(*)::int as n from farm.operations
              where source = 'deere' and field_id is not null
                and crop_year = extract(year from now() at time zone 'America/Detroit')::int`,
          )
        )?.n ?? 0,
      { timeout: SYNC_WAIT_MS, message: "deere.ops landed this season's replayed operations" },
    )
    .toBeGreaterThan(0);
  const field = await one<{ id: string; name: string; lng: number; lat: number }>(
    `select f.id::text as id, f.name,
            extensions.ST_X(extensions.ST_PointOnSurface(b.geom)) as lng,
            extensions.ST_Y(extensions.ST_PointOnSurface(b.geom)) as lat
       from farm.operations o
       join farm.fields f on f.id = o.field_id
       join farm.current_boundaries b on b.field_id = f.id
      where o.source = 'deere'
        and o.crop_year = extract(year from now() at time zone 'America/Detroit')::int
      order by f.name limit 1`,
  );
  if (!field) throw new Error('no field with operations');

  await page.goto('/board');
  await waitForMap(page, 90_000);
  // Nothing above the field under the finger: no machine, no pin.
  await setLayer(page, 'fleet', false);
  await setLayer(page, 'pins', false);
  await tapAt(page, field);
  await expect(page.getByTestId('field-panel-title')).toHaveText(field.name, { timeout: 10_000 });
  await page.getByTestId('field-tab-history').click();
  const section = page.getByTestId('field-operations');
  await expect(section).toBeVisible();
  await expect(section).toContainText(/This season \(\d{4}\)/);
  await expect(page.getByTestId('field-operation').first()).toBeVisible({ timeout: 15_000 });
  await setLayer(page, 'pins', true);
  await setLayer(page, 'fleet', true);
});

test('the Samsara fault badge on the fleet panel: S3 critical, S2 warning', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/board');
  await waitForMap(page, 90_000);
  const id = async (unit: string) =>
    (await modes(page)).machines.find((m) => m.unitNo === unit)?.id as string;
  const s3 = page.locator(`[data-testid="fleet-panel-row"][data-machine-id="${await id('S3')}"]`);
  await expect(s3.getByTestId('fleet-fault-badge')).toHaveText('Critical: J1939 SPN 110 FMI 0', {
    timeout: 60_000,
  });
  await expect(s3.getByTestId('fleet-vendor-badge')).toHaveText('Samsara · replay');
  const s2 = page.locator(`[data-testid="fleet-panel-row"][data-machine-id="${await id('S2')}"]`);
  await expect(s2.getByTestId('fleet-fault-badge')).toHaveAttribute('data-severity', 'warning');
});

test('/admin/connectors: calls in replay, the replayed orgs connected, the doc-derived list', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signInAs(page.context(), 'manager');
  await expect
    .poll(
      async () => {
        await page.goto('/admin/connectors');
        return page.getByTestId('calls-deere-replay').count();
      },
      { timeout: 60_000, intervals: [2_000, 5_000] },
    )
    .toBeGreaterThan(0);
  await expect(page.getByTestId('calls-deere-replay').getByTestId('calls-today')).toHaveText(
    /^[1-9][\d,]*/,
  );
  await expect(page.getByTestId('calls-samsara-replay')).toBeVisible();
  const orgs = page.getByTestId('deere-orgs');
  await expect(orgs.locator('[data-status="connected"]').first()).toBeVisible();
  await expect(page.getByTestId('connector-mode-deere')).toContainText('replay');
  const doc = page.getByTestId('doc-derived');
  await expect(doc.getByTestId('doc-basis').first()).toBeVisible();
});
