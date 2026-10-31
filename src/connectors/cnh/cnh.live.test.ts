/**
 * The CNH FieldOps live suite (`pnpm test:live`, by hand only: never in CI). Runs only with
 * CONNECTOR_CNH=sandbox (staging) or live (production), the app's credentials for that
 * environment, and a CNH grant (sign in at /api/oauth/cnh first; read from ingest.oauth_tokens).
 * Read-only GETs: companies, equipment, one Fleet page, one VIN's last hour of Locations. This
 * is the "staging recording" step's smoke test before `pnpm connectors:record`.
 */
import { describe, expect, test } from 'vitest';
import { getConfig } from '../../config';
import { getPool } from '../../db/client';
import { cnhEndpoints } from '../endpoints';
import { tokenKey } from '../oauth/crypto';
import { OAuthTokenStore } from '../oauth/token-store';
import { CnhClient, CnhEulaError } from './client';
import { cnhGrantOrg } from './oauth';

const cfg = getConfig();
const mode = cfg.CONNECTOR_CNH;
const enabled = mode === 'sandbox' || mode === 'live';

describe.skipIf(!enabled)(`CNH FieldOps (${mode})`, () => {
  test('companies, equipment, a Fleet page and a Locations window', async () => {
    const ep = cnhEndpoints(mode, cfg);
    const client = new CnhClient({
      endpoints: ep,
      tokens: new OAuthTokenStore({
        pool: getPool(),
        source: 'cnh',
        org: cnhGrantOrg(ep),
        key: tokenKey(cfg.TOKEN_ENC_KEY),
      }),
    });
    const companies = await client.companies();
    expect(companies.length).toBeGreaterThan(0);
    const { items } = await client.equipment();
    console.log(`[cnh live] ${companies.length} companies, ${items.length} machines`);
    const page = await client.fleetPage(1);
    console.log(`[cnh live] Fleet page 1: ${page.machines.length} machines`);
    const first = items[0];
    if (first) {
      const now = Date.now();
      try {
        const locs = await client.locations(first.vin, now - 3_600_000, now);
        console.log(`[cnh live] ${first.vin}: ${locs.length} locations in the last hour`);
      } catch (e) {
        if (!(e instanceof CnhEulaError)) throw e;
        console.log(`[cnh live] ${first.vin}: no accepted EULA`);
      }
    }
  });
});
