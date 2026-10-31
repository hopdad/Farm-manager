/**
 * The /admin/connectors sync-health read model on a real database, as farm_app (1f, §11.4):
 * calls today and yesterday per source and mode, the Deere budget ("limit unknown" unset; the
 * split and its warning set, sandbox rows only), the Deere OAuth grant (connected, scopes, the
 * missing-scope warning; config errors in sandbox without the app's credentials), the current
 * mode's orgs with their 403 kinds, the home org and where it came from, the unmappable
 * equipment and Terminal's provider rows.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { lastFullUtcDay } from '../../../connectors/deere/call-shares';
import { tokenKey } from '../../../connectors/oauth/crypto';
import { OAuthTokenStore, SIM_GRANT_ORG } from '../../../connectors/oauth/token-store';
import { ensureStream } from '../../../db/leases';
import { saveConnectorOrgs } from '../../../db/queries/connector-orgs';
import type { JobRegistry } from '../../../jobs/types';
import { setupTestDb } from '../../../test/db';
import { loadSyncHealth, type SyncHealthConfig } from './health';

const t = setupTestDb(import.meta.url);
const now = new Date();
const today = now.toISOString().slice(0, 10);
const yesterday = lastFullUtcDay(now);
const run = async () => ({ items: 0 });
const registry: JobRegistry = { 'fleet.deere': { cron: '*/2 * * * *', run } };
const KEY = 'ab'.repeat(32);

const cfg = (over: Partial<SyncHealthConfig> = {}): SyncHealthConfig => ({
  CONNECTOR_DEERE: 'sim',
  DEERE_DAILY_CALL_BUDGET: undefined,
  DEERE_HOME_ORG_ID: undefined,
  DEERE_REDIRECT_URI: undefined,
  FLEET_STALE_SECONDS_DEERE: 900,
  PUBLIC_URL: 'http://localhost:3114',
  VENDOR_SIM_URL: 'http://127.0.0.1:4024',
  TOKEN_ENC_KEY: KEY,
  DEERE_CLIENT_ID: undefined,
  DEERE_CLIENT_SECRET: undefined,
  SAMSARA_API_TOKEN: undefined,
  MOTIVE_API_KEY: undefined,
  DEERE_API_BASE: undefined,
  DEERE_EQUIPMENT_API_BASE: undefined,
  ...over,
});

const grant = (scopes: string[]) => ({
  accessToken: 'a',
  refreshToken: 'r',
  tokenType: 'Bearer',
  expiresAt: new Date(now.getTime() + 300_000),
  refreshExpiresAt: null,
  scopes,
});

beforeAll(async () => {
  const p = t().pool;
  await p.query(
    `insert into ingest.api_calls_daily (source, stream, mode, day, calls, errors, rate_limited)
     values ('deere', 'locations', 'sim', $1::date, 40, 1, 0),
            ('deere', '', 'sim', $1::date, 2, 0, 0),
            ('deere', 'locations', 'sim', $2::date, 30, 0, 0),
            ('samsara', 'positions', 'sim', $1::date, 100, 0, 3),
            ('deere', 'locations', 'live', $2::date, 1000, 0, 0),
            ('deere', 'operations', 'live', $2::date, 7000, 0, 0),
            ('deere', 'fields', 'live', $2::date, 2000, 0, 0)`,
    [today, yesterday],
  );
  await ensureStream(p, 'deere', 'locations', 'live');
  await p.query(
    `update ingest.sync_state set extra = '{"callsPerRun": 12, "callsPerRunMode": "live",
       "homeOrg": {"orgId": null, "source": "unknown", "mode": "live", "at": "2026-10-31T00:00:00Z",
         "candidates": [{"id": "111", "name": "Mine", "member": true}, {"id": "222", "name": "Theirs", "member": true}]}}'
      where source = 'deere' and stream = 'locations'`,
  );
  await ensureStream(p, 'deere', 'equipment', 'sim');
  await p.query(
    `update ingest.sync_state set extra = '{"unmappedKinds": {"Utility Vehicle": 2, "Loader": 1}}'
      where source = 'deere' and stream = 'equipment'`,
  );
  await ensureStream(p, 'terminal', 'providers', 'sim');
  await p.query(
    `update ingest.sync_state set extra = jsonb_build_object('providers', jsonb_build_array(
       jsonb_build_object('code', 'omnitracs-xrs', 'label', 'Omnitracs XRS', 'vendorId', 'terminal_omnitracs_xrs',
         'capabilities', jsonb_build_object('positions', jsonb_build_object('live', 'yes', 'lastKnown', 'yes')))))
      where source = 'terminal' and stream = 'providers'`,
  );
  await saveConnectorOrgs(
    p,
    'deere',
    'sim',
    [
      { orgId: 'org-home', name: 'Home', status: 'connected', approvalUrl: null, detail: null },
      {
        orgId: 'org-customer-1',
        name: 'Customer 1',
        status: 'needs_approval',
        approvalUrl: 'https://connections.deere.com/connections/c/select-organizations',
        detail: 'the organization has not approved this app (Deere Connections)',
      },
      {
        orgId: 'org-customer-2',
        name: 'Customer 2',
        status: 'needs_approval',
        approvalUrl: null,
        detail:
          "403 from /isg/equipment: accept Deere's terms at https://teammanager.deere.com/organizations/org-customer-2/terms",
      },
    ],
    { listed: true },
  );
  await saveConnectorOrgs(
    p,
    'deere',
    'live',
    [{ orgId: '111', name: 'Mine', status: 'connected', approvalUrl: null, detail: null }],
    { listed: true },
  );
  await new OAuthTokenStore({
    pool: p,
    source: 'deere',
    org: SIM_GRANT_ORG,
    key: tokenKey(KEY),
  }).save(grant(['offline_access', 'ag1', 'ag2', 'eq1']));
  await new OAuthTokenStore({ pool: p, source: 'deere', org: '', key: tokenKey(KEY) }).save(
    grant(['offline_access', 'ag1', 'eq1']),
  );
});

describe('loadSyncHealth (sim)', () => {
  test('calls today and yesterday per source and mode, by stream', async () => {
    const h = await loadSyncHealth(t().pool, cfg(), registry, now);
    const deereSim = h.calls.find((c) => c.source === 'deere' && c.mode === 'sim');
    expect(deereSim).toMatchObject({
      today: { calls: 42, errors: 1, rateLimited: 0 },
      yesterday: { calls: 30, errors: 0, rateLimited: 0 },
    });
    expect(deereSim?.streams.map((s) => s.stream)).toEqual(['', 'locations']);
    expect(h.calls.find((c) => c.source === 'samsara')?.today).toEqual({
      calls: 100,
      errors: 0,
      rateLimited: 3,
    });
    expect(h.calls.find((c) => c.source === 'deere' && c.mode === 'live')?.yesterday.calls).toBe(
      10_000,
    );
  });

  test('budget unset: limit unknown; the sim grant, its scopes, nothing missing', async () => {
    const h = await loadSyncHealth(t().pool, cfg(), registry, now);
    expect(h.budget).toMatchObject({ budget: null, applies: false, split: null });
    expect(h.budget.pace.reason).toMatch(/limit unknown/);
    expect(h.oauth).toMatchObject({
      sim: true,
      grantOrg: SIM_GRANT_ORG,
      connectUrl: null,
      missing: [],
    });
    expect(h.oauth.grant?.scopes).toEqual(['offline_access', 'ag1', 'ag2', 'eq1']);
    expect(h.oauth.redirectUri).toBe('http://localhost:3114/api/oauth/deere');
  });

  test("the current mode's orgs with their 403 kinds; the sim home org", async () => {
    const h = await loadSyncHealth(t().pool, cfg(), registry, now);
    expect(h.orgs.rows.map((o) => [o.orgId, o.view.kind])).toEqual([
      ['org-customer-1', 'needs_approval'],
      ['org-customer-2', 'terms'],
      ['org-home', 'connected'],
    ]);
    expect(h.orgs.rows.find((o) => o.orgId === 'org-customer-2')?.view.termsUrl).toMatch(
      /teammanager/,
    );
    expect(h.homeOrg).toMatchObject({ orgId: 'org-home', source: 'sim' });
    expect(h.unmappedKinds).toEqual({ 'Utility Vehicle': 2, Loader: 1 });
    expect(h.terminalProviders.map((p) => p.code)).toEqual(['omnitracs-xrs']);
  });
});

describe('loadSyncHealth (live)', () => {
  const live = (over: Partial<SyncHealthConfig> = {}) =>
    cfg({
      CONNECTOR_DEERE: 'live',
      DEERE_CLIENT_ID: 'app',
      DEERE_CLIENT_SECRET: 'secret',
      DEERE_REDIRECT_URI: 'https://pages.example/deere-callback.html',
      ...over,
    });

  test('without the app credentials: not configured, no Connect link', async () => {
    const h = await loadSyncHealth(t().pool, cfg({ CONNECTOR_DEERE: 'live' }), registry, now);
    expect(h.oauth.configError).toMatch(/DEERE_CLIENT_ID is required/);
    expect(h.oauth.connectUrl).toBeNull();
    expect(h.oauth.grant).toBeNull();
  });

  test('the real grant lacks ag2: the scope warning; Connect link and the forwarder callback', async () => {
    const h = await loadSyncHealth(t().pool, live(), registry, now);
    expect(h.oauth).toMatchObject({
      sim: false,
      grantOrg: '',
      connectUrl: '/api/oauth/deere',
      missing: ['ag2'],
      redirectUri: 'https://pages.example/deere-callback.html',
    });
    // sim's org rows never show in live.
    expect(h.orgs.rows.map((o) => o.orgId)).toEqual(['111']);
    // Several member orgs, no DEERE_HOME_ORG_ID: unknown, with the ids to pick from.
    expect(h.homeOrg).toMatchObject({ orgId: null, source: 'unknown' });
    expect(h.homeOrg.candidates.map((c) => c.id)).toEqual(['111', '222']);
    const configured = await loadSyncHealth(
      t().pool,
      live({ DEERE_HOME_ORG_ID: '111' }),
      registry,
      now,
    );
    expect(configured.homeOrg).toMatchObject({ orgId: '111', source: 'config' });
  });

  test('with a budget: the split of the last full day and the warning when others pass 80 %', async () => {
    const h = await loadSyncHealth(
      t().pool,
      live({ DEERE_DAILY_CALL_BUDGET: 10_000 }),
      registry,
      now,
    );
    expect(h.budget.applies).toBe(true);
    expect(h.budget.split).toMatchObject({
      budget: 10_000,
      target: 8000,
      lastDay: { locations: 1000, operations: 7000, others: 2000 },
      othersOverTarget: true,
    });
    expect(h.budget.split?.shares.locations).toBe(1000); // the 10 % floor
    // 12 calls a run at 1 000 a day → every 1 037 s, past FLEET_STALE_SECONDS_DEERE (900).
    expect(h.budget.pace.minIntervalSeconds).toBe(1037);
    expect(h.budget.staleWarning).toMatch(/FLEET_STALE_SECONDS_DEERE \(900 s\)/);
    expect(h.budget.cronSeconds).toBe(120);
    const roomy = await loadSyncHealth(
      t().pool,
      live({ DEERE_DAILY_CALL_BUDGET: 10_000_000 }),
      registry,
      now,
    );
    expect(roomy.budget.split?.othersOverTarget).toBe(false);
    expect(roomy.budget.staleWarning).toBeNull();
  });
});
