/**
 * The hired haulers on the board (slice 1f.2, the trucks builder; docs/contracts-1f.md §B.8.1):
 * H1 through Motive and H2 through MyGeotab, both on the wall's map, fresh and reported every
 * 15 s or less (the stand-ins' grids, no jitter), with their vendor ids (`motive`, `geotab`)
 * and their engine hours and odometer from the vendors' readings in the database; a Motive
 * fault opened with the stand-in's knob lands through fleet.motive as a delta report, and one
 * raised in the MyGeotab stand-in lands decoded through fleet.geotab. Real app, real database,
 * real job clock (pnpm pilot or E2E_BASE_URL); nothing mocked. The panel's "Motive · sim" /
 * "Geotab · sim" badges come with fleet-faults' panel text (checked by the integrator).
 *
 * Runs under the sim stack (it skips when CONNECTOR_MOTIVE / CONNECTOR_GEOTAB aren't sim), once,
 * in the `wall` project. Replay mode: ./trucks-replay.spec.ts.
 */
import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { getConfig } from '../src/config';
import { type MachineView, machineViewSchema } from '../src/domain/fleet';
import { buildSimFarm } from '../src/sim/index';
import { simTelematicsMachines } from '../src/sim/types';
import { GEOTAB_SIM_FAULTS_PATH } from '../src/sim/vendors/geotab/control-types';
import { MOTIVE_SIM_FAULT_CODES_PATH } from '../src/sim/vendors/motive/control-types';
import { fleetPanelDataSchema } from '../src/ui/fleet/contract';
import { signInAs } from './support/auth';
import { WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });
test.describe.configure({ mode: 'serial' });

const cfg = getConfig();
const farm = buildSimFarm(cfg.SIM_SEED);
const H1 = simTelematicsMachines(farm, 'motive')[0];
const H2 = simTelematicsMachines(farm, 'geotab')[0];
/** The stand-ins report every 5 s; the jobs poll every 5 s (Motive) / 10 s (Geotab) in demo. */
const MAX_FIX_AGE_MS = 30_000;

let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await db?.end();
});

async function skipUnlessSim(page: Page, project: string) {
  test.skip(project !== 'wall', 'run once');
  await signInAs(page.context(), 'viewer');
  const res = await page.request.get('/api/machines');
  expect(res.status()).toBe(200);
  const { modes } = fleetPanelDataSchema.parse(await res.json());
  test.skip(
    modes.motive !== 'sim' || modes.geotab !== 'sim',
    'the sim stack (CONNECTOR_MOTIVE=sim, CONNECTOR_GEOTAB=sim; replay: trucks-replay.spec.ts)',
  );
}

async function fleetApi(page: Page): Promise<MachineView[]> {
  const res = await page.request.get('/api/fleet');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { machines: unknown[] };
  return body.machines.map((m) => machineViewSchema.parse(m));
}

async function control(path: string, body: unknown): Promise<{ faults: { id: string }[] }> {
  const res = await fetch(`${cfg.VENDOR_SIM_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status, path).toBe(200);
  return (await res.json()) as { faults: { id: string }[] };
}

test('H1 (Motive) and H2 (Geotab) on the board: fresh, every 15 s or less, with their vendor ids', async ({
  page,
}, info) => {
  await skipUnlessSim(page, info.project.name);
  test.setTimeout(150_000);
  await page.goto('/board');
  await waitForMap(page);
  const ids = [H1?.id, H2?.id] as string[];
  const frames = () =>
    page.evaluate((want) => (window.__map?.fleet() ?? []).filter((m) => want.includes(m.id)), ids);
  await expect
    .poll(
      async () =>
        (await frames())
          .filter((m) => !m.stale && m.positionSource === 'eld' && m.kind === 'semi')
          .map((m) => m.unitNo)
          .sort(),
      {
        timeout: 90_000,
        intervals: [2_000],
        message: 'H1 and H2 on the map (is the clock running?)',
      },
    )
    .toEqual(['H1', 'H2']);

  // Fresh, and still reporting: each one's fix moves on, on the stand-ins' 5 s grid.
  const first = await fleetApi(page);
  await page.waitForTimeout(20_000);
  const later = await fleetApi(page);
  for (const id of ids) {
    const a = first.find((m) => m.id === id) as MachineView;
    const b = later.find((m) => m.id === id) as MachineView;
    expect(b.stale, b.unitNo).toBe(false);
    expect(Date.parse(b.ts), `${b.unitNo} reported again`).toBeGreaterThan(Date.parse(a.ts));
    expect(Date.parse(b.ts) % 5_000, `${b.unitNo} on the 5 s grid`).toBe(0);
    expect(Date.now() - Date.parse(b.ts), `${b.unitNo} fix age (ms)`).toBeLessThan(MAX_FIX_AGE_MS);
  }

  const rows = await db.query(
    `select m.unit_no, s.position_vendor, s.position_kind,
            m.engine_hours::float8 as engine_hours, m.odometer_mi::float8 as odometer_mi
       from farm.machines m join farm.machine_state s on s.machine_id = m.id
      where m.id = any($1::uuid[]) order by m.unit_no`,
    [ids],
  );
  expect(rows.rows.map((r) => [r.unit_no, r.position_vendor, r.position_kind])).toEqual([
    ['H1', 'motive', 'live'],
    ['H2', 'geotab', 'live'],
  ]);
  for (const r of rows.rows) {
    expect(r.engine_hours, `${r.unit_no} engine hours`).toBeGreaterThan(10_000);
    expect(r.odometer_mi, `${r.unit_no} odometer`).toBeGreaterThan(100_000);
  }
});

test('a fault from each stand-in knob lands through its job (Motive delta, Geotab decoded)', async ({
  page,
}, info) => {
  await skipUnlessSim(page, info.project.name);
  test.setTimeout(120_000);
  const since = new Date();
  const motive = await control(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'open', kind: 'obd2' });
  const geotab = await control(GEOTAB_SIM_FAULTS_PATH, { action: 'raise', kind: 'j1939' });
  try {
    const motiveId = motive.faults.at(-1)?.id as string;
    const geotabId = geotab.faults.at(-1)?.id as string;
    await expect
      .poll(
        async () => {
          const r = await db.query(
            `select source, status, payload from ingest.raw_events
              where stream = 'faults' and fetched_at >= $1
                and ((source = 'motive' and payload->'fault'->>'id' = $2)
                  or (source = 'geotab' and payload->'record'->>'id' = $3))`,
            [since, motiveId, geotabId],
          );
          return r.rows
            .filter((x) => x.status === 'processed')
            .map((x) =>
              x.source === 'motive'
                ? `motive ${x.payload.fault.code} ${x.payload.fault.status}`
                : `geotab SPN ${x.payload.diagnostic?.code} FMI ${x.payload.failureMode?.code}`,
            )
            .sort();
        },
        { timeout: 90_000, intervals: [2_000], message: 'both faults landed and processed' },
      )
      .toEqual(['geotab SPN 110 FMI 0', 'motive P0217 open']);
  } finally {
    await control(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'clear' });
    await control(GEOTAB_SIM_FAULTS_PATH, { action: 'reset' });
  }
});
