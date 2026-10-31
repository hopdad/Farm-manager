/**
 * The hired haulers in replay mode (slice 1f.2, the trucks builder; docs/contracts-1f.md
 * §B.8.1): with CONNECTOR_MOTIVE=replay and CONNECTOR_GEOTAB=replay, the doc-derived fixtures
 * put H1 (Motive) and H2 (MyGeotab, its JSON-RPC calls told apart by body) on the board, fresh
 * (time-shifted to now) and fix after fix, with their vendor ids.
 *
 * Runs only against an app started in replay mode for both; under the default sim stack it
 * skips. To run:
 *   PowerShell:  $env:CONNECTOR_MOTIVE='replay'; $env:CONNECTOR_GEOTAB='replay'; pnpm pilot
 *   then, in another window:  pnpm test:e2e e2e/trucks-replay.spec.ts
 * (or put both lines in .env.local / .env.production.local).
 */
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { getConfig } from '../src/config';
import { type MachineView, machineViewSchema } from '../src/domain/fleet';
import { buildSimFarm } from '../src/sim/index';
import { simTelematicsMachines } from '../src/sim/types';
import { fleetPanelDataSchema } from '../src/ui/fleet/contract';
import { signInAs } from './support/auth';
import { WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

const cfg = getConfig();
const farm = buildSimFarm(cfg.SIM_SEED);
const H1 = simTelematicsMachines(farm, 'motive')[0];
const H2 = simTelematicsMachines(farm, 'geotab')[0];

test('replay mode: H1 and H2 from the doc-derived fixtures, fresh fix after fix', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'wall', 'run once');
  await signInAs(page.context(), 'viewer');
  const res = await page.request.get('/api/machines');
  expect(res.status()).toBe(200);
  const { modes } = fleetPanelDataSchema.parse(await res.json());
  test.skip(
    modes.motive !== 'replay' || modes.geotab !== 'replay',
    'start the app with CONNECTOR_MOTIVE=replay and CONNECTOR_GEOTAB=replay',
  );
  test.setTimeout(150_000);

  await page.goto('/board');
  await waitForMap(page);
  const ids = [H1?.id, H2?.id] as string[];
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__map?.fleet() ?? []))
          .filter((m) => ids.includes(m.id) && !m.stale && m.positionSource === 'eld')
          .map((m) => m.unitNo)
          .sort(),
      { timeout: 90_000, intervals: [2_000], message: 'H1 and H2 replayed on the map' },
    )
    .toEqual(['H1', 'H2']);

  const fleet = async (): Promise<MachineView[]> => {
    const r = await page.request.get('/api/fleet');
    return ((await r.json()) as { machines: unknown[] }).machines.map((m) =>
      machineViewSchema.parse(m),
    );
  };
  const before = await fleet();
  await page.waitForTimeout(25_000);
  const after = await fleet();
  for (const id of ids) {
    const a = before.find((m) => m.id === id) as MachineView;
    const b = after.find((m) => m.id === id) as MachineView;
    expect(Date.parse(b.ts), `${b.unitNo}: a newer replayed fix`).toBeGreaterThan(Date.parse(a.ts));
    expect(Date.now() - Date.parse(b.ts)).toBeLessThan(30_000);
  }

  const db = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 1 });
  try {
    const r = await db.query(
      `select m.unit_no, s.position_vendor from farm.machines m
         join farm.machine_state s on s.machine_id = m.id
        where m.id = any($1::uuid[]) order by m.unit_no`,
      [ids],
    );
    expect(r.rows).toEqual([
      { unit_no: 'H1', position_vendor: 'motive' },
      { unit_no: 'H2', position_vendor: 'geotab' },
    ]);
  } finally {
    await db.end();
  }
});
