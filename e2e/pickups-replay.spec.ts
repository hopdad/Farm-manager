/**
 * Replay mode for the pickups route and Terminal (slice 1f.2, terminal-pickups;
 * docs/contracts-1f.md §B.6, §B.8.3): with CONNECTOR_TERMINAL=replay the doc-derived Terminal
 * fixtures put H3 on the board, fresh (time-shifted to now) and live from Terminal's history, with
 * its vendor id; with CONNECTOR_SAMSARA=replay fleet.vehicles reads the doc-derived vehicle list
 * (the pickups by their `Pickup` tag and carmaker routes). No vendor stand-in involved.
 *
 * Runs only against an app started in replay mode; under the default sim stack it skips. To run:
 *   PowerShell:  $env:CONNECTOR_TERMINAL='replay'; $env:CONNECTOR_SAMSARA='replay'; pnpm pilot
 *   then, in another window:  pnpm test:e2e e2e/pickups-replay.spec.ts
 * (or put both lines in .env.local / .env.production.local).
 */
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { getConfig } from '../src/config';
import { buildSimFarm } from '../src/sim/index';
import { simTelematicsMachines } from '../src/sim/types';
import { fleetPanelDataSchema } from '../src/ui/fleet/contract';
import { signInAs } from './support/auth';
import { WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

const cfg = getConfig();
const farm = buildSimFarm(cfg.SIM_SEED);
const H3 = simTelematicsMachines(farm, 'terminal')[0];
const PICKUPS = simTelematicsMachines(farm, 'samsara', { feed: 'vehicle' }).filter(
  (m) => m.kind === 'pickup',
);

test('replay: H3 from the Terminal fixtures, live and fresh; the pickups from the vehicle list', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'wall', 'run once');
  await signInAs(page.context(), 'viewer');
  const res = await page.request.get('/api/machines');
  expect(res.status()).toBe(200);
  const { modes } = fleetPanelDataSchema.parse(await res.json());
  test.skip(
    modes.terminal !== 'replay' || modes.samsara !== 'replay',
    'start the app with CONNECTOR_TERMINAL=replay and CONNECTOR_SAMSARA=replay',
  );
  test.setTimeout(150_000);
  const db = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 2 });
  try {
    await page.goto('/board');
    await waitForMap(page);
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) => (window.__map?.fleet() ?? []).filter((m) => m.id === id && !m.stale).length,
            H3?.id,
          ),
        { timeout: 90_000, intervals: [2_000], message: 'H3 replayed onto the map' },
      )
      .toBe(1);
    const state = (
      await db.query(
        `select position_vendor, position_kind, ts from farm.machine_state where machine_id = $1`,
        [H3?.id],
      )
    ).rows[0];
    expect(state).toMatchObject({
      position_vendor: 'terminal_omnitracs_xrs',
      position_kind: 'live',
    });
    expect(Date.now() - new Date(state.ts).getTime()).toBeLessThan(60_000);

    // fleet.vehicles (hourly, 59 s in the demo) reads the replayed list: kinds set by the vendor.
    await expect
      .poll(
        async () =>
          (
            await db.query(
              `select unit_no, kind, kind_set_by, telematics_via from farm.machines
                where id = any($1::uuid[]) order by unit_no`,
              [PICKUPS.map((m) => m.id)],
            )
          ).rows.map((r) => [r.unit_no, r.kind, r.kind_set_by, r.telematics_via]),
        { timeout: 90_000, intervals: [3_000], message: 'fleet.vehicles ran in replay' },
      )
      .toEqual([
        ['PU1', 'pickup', 'vendor', 'ford_pro'],
        ['PU2', 'pickup', 'vendor', 'stellantis'],
      ]);
  } finally {
    await db.end();
  }
});
