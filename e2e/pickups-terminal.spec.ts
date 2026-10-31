/**
 * The Terminal hauler on the board (slice 1f.2, terminal-pickups; docs/contracts-1f.md §B.8.3):
 * H3 (a hired Mack on an Omnitracs XRS ELD, linked through Terminal) on the wall's map, fresh and
 * reported every 10 s with no jitter (the stand-in's grid; Terminal's history lags 10 s), its
 * badge LIVE from Terminal's history while the latest location (a last-known snapshot) waits
 * behind it (the §5.0 precedence), vendor id `terminal_omnitracs_xrs`, engine hours and odometer
 * from the metric stat logs; the provider's capability row in sync_state for /admin/connectors;
 * a fault raised in the stand-in lands through fleet.terminal as a delta report. Real app, real
 * database, real job clock; nothing mocked. The panel's "Omnitracs XRS (via Terminal) · sim" badge
 * comes with fleet-faults' row text.
 *
 * Runs under the sim stack (skips unless CONNECTOR_TERMINAL=sim), once, in the `wall` project.
 */
import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { getConfig } from '../src/config';
import { type MachineView, machineViewSchema } from '../src/domain/fleet';
import { buildSimFarm } from '../src/sim/index';
import { simTelematicsMachines } from '../src/sim/types';
import { TERMINAL_SIM_FAULT_CODES_PATH } from '../src/sim/vendors/terminal/control-types';
import { fleetPanelDataSchema } from '../src/ui/fleet/contract';
import { signInAs } from './support/auth';
import { WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });
test.describe.configure({ mode: 'serial' });

const cfg = getConfig();
const H3 = simTelematicsMachines(buildSimFarm(cfg.SIM_SEED), 'terminal')[0];
/** 10 s grid + 10 s of Terminal's sync lag + the 15 s demo cadence, with room to spare. */
const MAX_FIX_AGE_MS = 45_000;

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
  test.skip(modes.terminal !== 'sim', 'the sim stack (CONNECTOR_TERMINAL=sim)');
}

async function h3(page: Page): Promise<MachineView> {
  const res = await page.request.get('/api/fleet');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { machines: unknown[] };
  const m = body.machines.map((x) => machineViewSchema.parse(x)).find((x) => x.id === H3?.id);
  if (!m) throw new Error('H3 has no fix yet');
  return m;
}

test('H3 through Terminal: on the board, live from the history, every 10 s, its vendor id and stats', async ({
  page,
}, info) => {
  await skipUnlessSim(page, info.project.name);
  test.setTimeout(150_000);
  await page.goto('/board');
  await waitForMap(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            (window.__map?.fleet() ?? [])
              .filter((m) => m.id === id && !m.stale && m.positionSource === 'eld')
              .map((m) => `${m.unitNo} ${m.kind}`),
          H3?.id,
        ),
      { timeout: 90_000, intervals: [2_000], message: 'H3 on the map (is the clock running?)' },
    )
    .toEqual(['H3 semi']);

  const first = await h3(page);
  await page.waitForTimeout(25_000);
  const later = await h3(page);
  expect(later.stale).toBe(false);
  expect(later.positionKind, 'live from the history, not the snapshot').toBeUndefined();
  expect(Date.parse(later.ts)).toBeGreaterThan(Date.parse(first.ts));
  expect(Date.parse(later.ts) % 10_000, 'on the 10 s grid').toBe(0);
  expect(Date.now() - Date.parse(later.ts), 'fix age (ms)').toBeLessThan(MAX_FIX_AGE_MS);

  const row = (
    await db.query(
      `select s.position_vendor, s.position_kind,
              m.engine_hours::float8 as engine_hours, m.odometer_mi::float8 as odometer_mi
         from farm.machines m join farm.machine_state s on s.machine_id = m.id where m.id = $1`,
      [H3?.id],
    )
  ).rows[0];
  expect(row).toMatchObject({ position_vendor: 'terminal_omnitracs_xrs', position_kind: 'live' });
  expect(row.engine_hours).toBeGreaterThan(10_000); // engine_runtime ms → h
  expect(row.odometer_mi).toBeGreaterThan(100_000); // odometer km → mi
  // History became breadcrumbs (live fixes in farm.positions).
  const n = (
    await db.query('select count(*)::int as n from farm.positions where machine_id = $1', [H3?.id])
  ).rows[0].n;
  expect(n).toBeGreaterThan(10);

  // The provider's capability row, for /admin/connectors (sync-health shows it under Terminal).
  const providers = (
    await db.query(
      `select extra->'providers' as p from ingest.sync_state
        where source = 'terminal' and stream = 'providers'`,
    )
  ).rows[0]?.p as {
    code: string;
    vendorId: string;
    capabilities: { stats: { fuelPct: string } };
  }[];
  expect(providers.map((p) => [p.code, p.vendorId, p.capabilities.stats.fuelPct])).toEqual([
    ['omnitracs-xrs', 'terminal_omnitracs_xrs', 'no'],
  ]);
});

test('a fault raised in the Terminal stand-in lands through fleet.terminal as a delta report', async ({
  page,
}, info) => {
  await skipUnlessSim(page, info.project.name);
  test.setTimeout(90_000);
  const since = new Date();
  const knob = async (body: unknown) => {
    const res = await fetch(`${cfg.VENDOR_SIM_URL}${TERMINAL_SIM_FAULT_CODES_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  };
  await knob({ action: 'open', kind: 'obdii' });
  try {
    await expect
      .poll(
        async () =>
          (
            await db.query(
              `select status, payload->'event'->>'code' as code from ingest.raw_events
                where source = 'terminal' and stream = 'faults' and fetched_at >= $1`,
              [since],
            )
          ).rows
            .filter((r) => r.status === 'processed')
            .map((r) => r.code),
        {
          timeout: 75_000,
          intervals: [2_000],
          message: 'the fault event landed and was processed',
        },
      )
      .toEqual(['P0217']);
  } finally {
    await knob({ action: 'clear' });
  }
});
