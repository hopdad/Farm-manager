/**
 * Replay mode on the board (plan 1a done-when "CONNECTOR_DEERE=replay runs on the doc-derived
 * fixtures"; contracts-m1 §10): with CONNECTOR_DEERE=replay and CONNECTOR_SAMSARA=replay the board
 * shows the replayed trucks and working machines, fresh (time-shifted to now), moving, without
 * the vendor stand-in. The panel flags the replay so nobody takes it for live data.
 *
 * Runs only against an app started in replay mode; under the default sim stack it skips. To run:
 *   PowerShell:  $env:CONNECTOR_DEERE='replay'; $env:CONNECTOR_SAMSARA='replay'; pnpm pilot
 *   then, in another window:  pnpm test:e2e e2e/fleet-panel-replay.spec.ts
 * (or put both lines in .env.local / .env.production.local).
 */
import { expect, test } from '@playwright/test';
import { fleetPanelDataSchema } from '../src/ui/fleet/contract';
import { signInAs } from './support/auth';
import { WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

test('replay mode: replayed machines on the board, fresh and moving, flagged as replay', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'wall', 'run once');
  await signInAs(page.context(), 'viewer');
  const res = await page.request.get('/api/machines');
  expect(res.status()).toBe(200);
  const { modes } = fleetPanelDataSchema.parse(await res.json());
  test.skip(
    modes.deere !== 'replay' || modes.samsara !== 'replay',
    'start the app with CONNECTOR_DEERE=replay and CONNECTOR_SAMSARA=replay',
  );
  test.setTimeout(150_000);

  await page.goto('/board');
  await waitForMap(page);
  await expect(page.getByTestId('fleet-mode-badge')).toHaveText(/Deere: replay.*Samsara: replay/i);

  const fleet = () => page.evaluate(() => window.__map?.fleet() ?? []);
  // The four replayed trucks (ELD) and at least two working Deere machines, none stale.
  await expect
    .poll(
      async () => {
        const f = await fleet();
        const semis = f.filter((m) => m.kind === 'semi' && m.positionSource === 'eld' && !m.stale);
        const deere = f.filter((m) => m.positionSource === 'deere_working' && !m.stale);
        return semis.length >= 4 && deere.length >= 2;
      },
      { timeout: 90_000, message: 'replayed machines on the map (is the job clock running?)' },
    )
    .toBe(true);
  const rows = page.getByTestId('fleet-panel-row');
  await expect(rows.filter({ hasText: 'ELD' }).first()).toBeVisible();
  await expect(rows.filter({ hasText: 'Deere' }).first()).toBeVisible();

  // The trucks move from one poll to the next (5 s demo cadence, 30 s live).
  const where = async () =>
    Object.fromEntries(
      (await fleet()).filter((m) => m.kind === 'semi').map((m) => [m.id, `${m.lng},${m.lat}`]),
    );
  const before = await where();
  await expect
    .poll(
      async () => {
        const now = await where();
        return Object.keys(now).filter((id) => now[id] !== before[id]).length;
      },
      { timeout: 75_000, message: 'replayed trucks moving' },
    )
    .toBeGreaterThan(0);
});
