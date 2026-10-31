/**
 * Deere live contract suite (1f, sync-health; `pnpm test:live`, by hand on Derrick's PC, never in
 * CI): the live client against Deere's sandbox (CONNECTOR_DEERE=sandbox) or production (live) with
 * the grant `/api/oauth/deere` stored, checking what the stand-in and the doc-derived fixtures
 * assume. Read-only calls only; they count against the app's Deere budget (a handful).
 *
 * Skips with the reason when the mode isn't sandbox/live, the app's credentials or the database
 * are missing, or nobody has signed in yet.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type Config, getConfig } from '../../config';
import { createPool } from '../../db/client';
import { deereEndpoints } from '../endpoints';
import { tokenKey } from '../oauth/crypto';
import { missingScopes } from '../oauth/grant-info';
import { OAuthTokenStore } from '../oauth/token-store';
import { DeereClient } from './client';
import { deereOrgAccess } from './orgs';
import { DEERE_SCOPES } from './schemas';

function readiness(): { ready: true; cfg: Config } | { ready: false; why: string } {
  let cfg: Config;
  try {
    cfg = getConfig();
  } catch (e) {
    return { ready: false, why: `configuration: ${(e as Error).message.split('\n')[0]}` };
  }
  if (cfg.CONNECTOR_DEERE !== 'sandbox' && cfg.CONNECTOR_DEERE !== 'live') {
    return {
      ready: false,
      why: `CONNECTOR_DEERE is ${cfg.CONNECTOR_DEERE}: set sandbox (or live)`,
    };
  }
  if (!cfg.DEERE_CLIENT_ID || !cfg.DEERE_CLIENT_SECRET) {
    return { ready: false, why: 'DEERE_CLIENT_ID / DEERE_CLIENT_SECRET are not set' };
  }
  return { ready: true, cfg };
}

const r = readiness();
if (!r.ready) process.stderr.write(`[deere live] skipped: ${r.why}\n`);

describe.skipIf(!r.ready)(
  `Deere live (${r.ready ? r.cfg.CONNECTOR_DEERE : `skipped: ${r.ready ? '' : r.why}`})`,
  () => {
    const cfg = (r as { cfg: Config }).cfg;
    const pool = r.ready ? createPool({ max: 2, applicationName: 'farm-live-test' }) : null;
    let store: OAuthTokenStore;
    let client: DeereClient;
    let signedIn = false;

    beforeAll(async () => {
      if (!pool) return;
      const ep = deereEndpoints(cfg.CONNECTOR_DEERE, cfg);
      store = new OAuthTokenStore({
        pool,
        source: 'deere',
        org: '',
        key: tokenKey(cfg.TOKEN_ENC_KEY),
      });
      signedIn = (await store.read()) !== null;
      if (!signedIn)
        console.info('[deere live] no stored grant: sign in at /api/oauth/deere first');
      client = new DeereClient({ endpoints: ep, tokens: store, http: { timeoutMs: 60_000 } });
    });
    afterAll(async () => {
      await pool?.end();
    });

    test('the stored grant has every scope the app asks for (offline_access ag1 ag2 eq1)', async (ctx) => {
      if (!signedIn) ctx.skip();
      const grant = await store.read();
      expect(missingScopes(grant?.scopes ?? [], DEERE_SCOPES)).toEqual([]);
    });

    test('organizations: each connected or needing approval through its links', async (ctx) => {
      if (!signedIn) ctx.skip();
      const orgs = await client.organizations();
      expect(orgs.length).toBeGreaterThan(0);
      for (const o of orgs) {
        const access = deereOrgAccess(o);
        expect(['connected', 'needs_approval']).toContain(access.status);
        if (access.status === 'needs_approval') expect(access.approvalUrl).toMatch(/^https:\/\//);
      }
    });

    test("a connected org's machines (Equipment API) and the last hour of breadcrumbs parse", async (ctx) => {
      if (!signedIn) ctx.skip();
      const org = (await client.organizations()).find(
        (o) => deereOrgAccess(o).status === 'connected',
      );
      if (!org) ctx.skip();
      const machines = await client.machines((org as { id: string }).id);
      const m = machines.find((x) => x.principalId);
      if (!m) return;
      const now = new Date();
      const crumbs = await client.breadcrumbs(
        String(m.principalId),
        new Date(now.getTime() - 3600_000),
        now,
      );
      expect(Array.isArray(crumbs)).toBe(true);
    });
  },
);
