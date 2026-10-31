/**
 * The machines of slice 1f.2 on the board (docs/contracts-1f.md §B.8.2), against the running app
 * in sim (its stand-in, its job clock):
 *  - L1 (Kubota on the generic ISO 15143-3 client) as a LAST-KNOWN fix: positionKind last_known,
 *    not stale (3 h threshold), no trail, position_vendor `aemp_kubota`, engine hours;
 *  - C3 and T1 (Case IH on CNH FieldOps' own stand-in) live from the Locations trail,
 *    position_vendor `cnh`, hours and odometer from the Fleet snapshot;
 *  - SP2 (the RoGator on a Samsara asset gateway) live from the equipment feeds,
 *    position_vendor `samsara`, telematics_via gateway (its Samsara AEMP snapshot waits);
 *  - the CNH sign-in round trip through the stand-in's consent page (audience and connection on
 *    /authorize), ending "Connected to CNH FieldOps".
 * Panel text (the vendor badge) arrives with fleet-faults (part A): until then this checks
 * /api/fleet, the map's frames and the database (§B.2).
 */
import { expect, type Page, test } from '@playwright/test';
import type { Pool } from 'pg';
import { getConfig } from '../src/config';
import { createPool } from '../src/db/client';
import { fleetTickSchema, type MachineView } from '../src/domain/fleet';
import { signInAs } from './support/auth';
import { WEBGL_ARGS, waitForMap } from './support/map';

test.use({ launchOptions: { args: WEBGL_ARGS } });

const UNITS = ['L1', 'C3', 'T1', 'SP2'] as const;
let pool: Pool;

test.beforeAll(() => {
  pool = createPool({ connectionString: getConfig().DATABASE_URL, max: 2 });
});
test.afterAll(async () => {
  await pool?.end();
});

async function fleet(page: Page): Promise<MachineView[]> {
  const res = await page.request.get('/api/fleet');
  expect(res.status()).toBe(200);
  return fleetTickSchema.parse(await res.json()).machines;
}

async function stateOf(unit: string) {
  const r = await pool.query<{
    position_vendor: string | null;
    position_kind: string | null;
    engine_hours: string | null;
    odometer_mi: string | null;
    telematics_via: string | null;
    trail: number;
  }>(
    `select ms.position_vendor, ms.position_kind, m.engine_hours, m.odometer_mi, m.telematics_via,
            (select count(*)::int from farm.positions p where p.machine_id = m.id) as trail
       from farm.machines m left join farm.machine_state ms on ms.machine_id = m.id
      where m.unit_no = $1`,
    [unit],
  );
  return r.rows[0];
}

test('L1 last-known from AEMP, C3 and T1 live from CNH, SP2 live from the equipment feed', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'wall', 'run once');
  test.setTimeout(150_000);
  await signInAs(page.context(), 'viewer');
  // The jobs run every 10-30 s in the demo cadence: wait for all four.
  await expect
    .poll(
      async () =>
        (await fleet(page))
          .filter((m) => (UNITS as readonly string[]).includes(m.unitNo))
          .map((m) => m.unitNo)
          .sort(),
      { timeout: 90_000, intervals: [2_000], message: 'L1, C3, T1 and SP2 on /api/fleet' },
    )
    .toEqual([...UNITS].sort());
  // CNH's live trail may land after its snapshot: wait for live fixes from both machines.
  await expect
    .poll(
      async () => {
        const by = new Map((await fleet(page)).map((m) => [m.unitNo, m]));
        return UNITS.map((u) => `${u}:${by.get(u)?.positionKind ?? 'live'}:${by.get(u)?.stale}`);
      },
      { timeout: 60_000, intervals: [2_000], message: 'kinds and freshness' },
    )
    .toEqual(['L1:last_known:false', 'C3:live:false', 'T1:live:false', 'SP2:live:false']);

  expect(await stateOf('L1')).toMatchObject({
    position_vendor: 'aemp_kubota',
    position_kind: 'last_known',
    odometer_mi: null, // Kubota sends no Distance: never 0
    trail: 0,
  });
  expect(Number((await stateOf('L1'))?.engine_hours)).toBeGreaterThan(1800);
  for (const unit of ['C3', 'T1']) {
    const s = await stateOf(unit);
    expect(s, unit).toMatchObject({ position_vendor: 'cnh', position_kind: 'live' });
    expect(s?.trail, unit).toBeGreaterThan(0);
    expect(Number(s?.engine_hours), unit).toBeGreaterThan(1400);
    expect(Number(s?.odometer_mi), unit).toBeGreaterThan(3800);
  }
  expect(await stateOf('SP2')).toMatchObject({
    position_vendor: 'samsara',
    position_kind: 'live',
    telematics_via: 'gateway',
  });

  // On the map: the same four, L1 drawn as last-known.
  await page.goto('/board');
  await waitForMap(page);
  await expect
    .poll(
      async () =>
        page.evaluate(
          (units) =>
            (window.__map?.fleet() ?? [])
              .filter((m) => units.includes(m.unitNo))
              .map((m) => `${m.unitNo}:${m.positionKind ?? 'live'}`)
              .sort(),
          [...UNITS] as string[],
        ),
      { timeout: 30_000, intervals: [1_000], message: 'the four machines on the map' },
    )
    .toEqual(['C3:live', 'L1:last_known', 'SP2:live', 'T1:live']);
});

test('CNH sign-in in sim: /authorize with audience and connection, consent, Connected', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'wall', 'run once');
  const authorize: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/cnh/identity/authorize') && r.method() === 'GET') {
      authorize.push(r.url());
    }
  });
  await page.goto('/api/oauth/cnh');
  await expect(page.getByRole('heading', { name: 'Sign in to FieldOps (simulated)' })).toBeVisible({
    timeout: 15_000,
  });
  const u = new URL(authorize[0] as string);
  const required = ['audience', 'client_id', 'connection', 'redirect_uri', 'response_type'];
  expect([...u.searchParams.keys()].sort()).toEqual([...required, 'scope', 'state'].sort());
  expect(u.searchParams.get('scope')).toBe('offline_access');
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByRole('heading', { name: 'Connected to CNH FieldOps' })).toBeVisible();
  const grant = await pool.query(
    `select org_external_id from ingest.oauth_tokens where source = 'cnh'`,
  );
  expect(grant.rows).toEqual([{ org_external_id: 'sim' }]);
});
