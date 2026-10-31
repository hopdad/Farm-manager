/**
 * deere.fields and Deere org access (docs/contracts-1f.md §5.4, decisions 5 and 8; done-when
 * §11.1): an org that needs approval (a `connections` link and Deere's 403, as sync-health's knob
 * makes it) is skipped and logged, an org that answers 403 mid-run is skipped for the rest of the
 * run with Deere's reason, and the other orgs sync. In SANDBOX mode (the client pointed at the
 * stand-in through DEERE_API_BASE / DEERE_EQUIPMENT_API_BASE, a stored grant) with several member
 * orgs and DEERE_HOME_ORG_ID unset there is no home org: no farm, field or machine is created,
 * fields that map are still updated; once DEERE_HOME_ORG_ID names it, the Deere-only field is.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { deterministicId } from '../../../domain/ids';
import { createDeereFieldsJob, type DeereFieldsConfig } from '../../../jobs/deere-fields';
import { buildDemoFarm } from '../../../sim/farm/build';
import { createSimWorld } from '../../../sim/index';
import { SIM_CREDENTIALS } from '../../../sim/types';
import { deereFieldsRoutes } from '../../../sim/vendors/deere/fields-routes';
import { simDeereOnlyField } from '../../../sim/vendors/deere/fields-world';
import type { DeereRouteModule } from '../../../sim/vendors/deere/modules';
import { deereModuleWith } from '../../../sim/vendors/deere/routes';
import { json } from '../../../sim/vendors/http';
import { startVendorSim, type VendorSim } from '../../../sim/vendors/server';
import { createTestDb, setupTestDb, type TestDb } from '../../../test/db';
import { type ConnectorConfig, deereEndpoints } from '../../endpoints';
import { tokenKey } from '../../oauth/crypto';
import { OAuthTokenStore } from '../../oauth/token-store';
import { seedSimFarm, testJobContext } from '../../testkit';
import { simAutoConnect } from '../oauth';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm(1);
const only = simDeereOnlyField(farm);
const halvorsen = farm.fields.filter(
  (f) => farm.farms.find((u) => u.id === f.farmId)?.deereOrgId === 'org-customer-1',
);
const sharedFields = farm.fields.filter((f) => f.sharedWith);
const now = () => new Date('2026-10-15T14:07:00.000Z');
const KEY = 'ef'.repeat(32);

/**
 * Like sync-health's connections module: org-customer-1 needs approval (its listing carries a
 * `connections` link; every call naming it is refused), and org-customer-2 answers 403 to its
 * boundary listing only (a 403 mid-run, with no link: a terms block, here).
 */
const blocker: DeereRouteModule = {
  key: 'connections',
  route: ({ orgIds, parts }) => {
    if (orgIds.includes('org-customer-1')) {
      return json(403, { errors: [{ message: 'Access Denied' }] });
    }
    if (orgIds.includes('org-customer-2') && parts[2] === 'boundaries') {
      return json(
        403,
        { errors: [{ message: 'Requested org is in a restricted state' }] },
        {
          'x-deere-terms-location':
            'https://teammanager.deere.com/organizations/org-customer-2/terms',
        },
      );
    }
    return null;
  },
  orgLinks: (org) =>
    org.id === 'org-customer-1'
      ? [
          {
            rel: 'connections',
            uri: 'https://connections.deere.com/connections/sim/select-organizations',
          },
        ]
      : [],
};

let sim: VendorSim;
const http = { timeoutMs: 5_000, baseBackoffMs: 1, sleep: async () => {} };
const job = (cfg: DeereFieldsConfig) => createDeereFieldsJob({ config: () => cfg, http });
const n = async (db: TestDb, sql: string, p: unknown[] = []) =>
  (await db.pool.query<{ n: number }>(sql, p)).rows[0]?.n ?? 0;

beforeAll(async () => {
  sim = await startVendorSim({
    createWorld: createSimWorld,
    port: 0,
    now,
    scenario: 'harvest-day',
    modules: { deere: deereModuleWith([blocker, deereFieldsRoutes]) },
  });
});
afterAll(() => sim?.close());

describe('orgs that need approval or refuse mid-run', () => {
  test('are skipped and logged; the other orgs sync', async () => {
    await seedSimFarm(t().adminDb, farm);
    const ctx = testJobContext(t(), { name: 'deere.fields', now });
    const cfg: DeereFieldsConfig = {
      VENDOR_SIM_URL: sim.url,
      PUBLIC_URL: 'http://localhost:3111',
      TOKEN_ENC_KEY: KEY,
      CONNECTOR_DEERE: 'sim',
    };
    const result = await job(cfg)(ctx);
    expect(result.items).toBeGreaterThan(0);
    // org-customer-1 (Halvorsen's own org) was never read: its fields keep the demo boundary.
    for (const f of halvorsen) {
      const open = await t().pool.query(
        `select source from farm.field_boundaries where field_id = $1 and upper_inf(valid)`,
        [f.id],
      );
      expect(open.rows[0]?.source).toBe('demo');
    }
    // org-customer-2 refused its boundaries: no sharing refs were written for it.
    expect(
      await n(
        t(),
        `select count(*)::int as n from ingest.external_refs where source = 'deere' and kind = 'boundary' and source_org = 'org-customer-2'`,
      ),
    ).toBe(0);
    // The home org synced: the shared fields' owner (home) boundaries are Deere versions.
    for (const f of sharedFields) {
      const open = await t().pool.query(
        `select source from farm.field_boundaries where field_id = $1 and upper_inf(valid)`,
        [f.id],
      );
      expect(open.rows[0]?.source).toBe('deere');
    }
    expect(await n(t(), `select count(*)::int as n from farm.pins`)).toBeGreaterThan(0);
    const lines = ctx.log.lines.map((l) => `${l.msg} ${JSON.stringify(l.data ?? {})}`);
    expect(lines.some((l) => l.includes('needs approval') && l.includes('org-customer-1'))).toBe(
      true,
    );
    expect(
      lines.some(
        (l) =>
          l.includes('Deere refused it') && l.includes('org-customer-2') && l.includes('terms'),
      ),
    ).toBe(true);
  });
});

describe('sandbox with several member orgs and no DEERE_HOME_ORG_ID', () => {
  let db: TestDb;
  const sandbox = (home?: string): DeereFieldsConfig => {
    const base: ConnectorConfig = {
      VENDOR_SIM_URL: sim.url,
      PUBLIC_URL: 'http://localhost:3111',
      TOKEN_ENC_KEY: KEY,
      DEERE_CLIENT_ID: SIM_CREDENTIALS.deere.clientId,
      DEERE_CLIENT_SECRET: SIM_CREDENTIALS.deere.clientSecret,
      DEERE_API_BASE: `${sim.url}/deere/platform`,
      DEERE_EQUIPMENT_API_BASE: `${sim.url}/deere/isg`,
    };
    return { ...base, CONNECTOR_DEERE: 'sandbox', ...(home ? { DEERE_HOME_ORG_ID: home } : {}) };
  };

  beforeAll(async () => {
    db = await createTestDb('deere-fields-sandbox');
    await seedSimFarm(db.adminDb, farm);
    // A stored real-mode grant (org ''), minted by the stand-in.
    const store = new OAuthTokenStore({
      pool: db.pool,
      source: 'deere',
      org: '',
      key: tokenKey(KEY),
      now,
    });
    await simAutoConnect(deereEndpoints('sim', sandbox()), store, http);
  });
  afterAll(() => db?.drop());

  test('nothing is created, mapped fields still update', async () => {
    const fields = await n(db, 'select count(*)::int as n from farm.fields');
    const farms = await n(db, 'select count(*)::int as n from farm.farms');
    await job(sandbox())(testJobContext(db, { name: 'deere.fields', now }));
    expect(await n(db, 'select count(*)::int as n from farm.fields')).toBe(fields);
    expect(await n(db, 'select count(*)::int as n from farm.farms')).toBe(farms);
    expect(
      await n(
        db,
        `select count(*)::int as n from farm.field_boundaries where source = 'deere' and upper_inf(valid)`,
      ),
    ).toBeGreaterThan(0);
    // Sandbox calls never count as sim; the mode on sync_state says sandbox.
    const modes = await db.pool.query(
      `select distinct mode from ingest.sync_state where source = 'deere' and stream in ('fields', 'flags', 'equipment', 'hours')`,
    );
    expect(modes.rows).toEqual([{ mode: 'sandbox' }]);
  });

  test('with DEERE_HOME_ORG_ID set, the Deere-only field is created', async () => {
    await db.pool.query(`delete from ingest.raw_events where source = 'deere'`);
    await job(sandbox('org-home'))(testJobContext(db, { name: 'deere.fields', now }));
    const r = await db.pool.query(`select tenure from farm.fields where id = $1`, [
      deterministicId('deere', only?.deereFieldId as string),
    ]);
    expect(r.rows[0]?.tenure).toBe('unknown');
  });
});
