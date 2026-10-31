/**
 * The AEMP live suite (`pnpm test:live`, by hand only: never in CI). It reads config like the
 * app (src/config.ts) and runs only with CONNECTOR_AEMP=sandbox or live and AEMP_PROVIDERS set:
 * one Fleet page per configured provider through the real client (read-only GETs; the provider's
 * pacing is the operator's to respect: run it once). A `deere_oauth` provider needs the Deere
 * connection signed in (its grant is read from ingest.oauth_tokens).
 */
import { describe, expect, test } from 'vitest';
import { getConfig } from '../../config';
import { getPool } from '../../db/client';
import { refreshDeereTokens } from '../deere/oauth';
import { aempEndpoints, deereEndpoints } from '../endpoints';
import { tokenKey } from '../oauth/crypto';
import { OAuthTokenStore, userGrantOrg } from '../oauth/token-store';
import { AempClient } from './client';

const cfg = getConfig();
const mode = cfg.CONNECTOR_AEMP;
const enabled = (mode === 'sandbox' || mode === 'live') && cfg.AEMP_PROVIDERS.length > 0;

describe.skipIf(!enabled)(`AEMP providers (${mode})`, () => {
  test('page 1 of every provider parses; machines have ids; nothing dropped silently', async () => {
    const endpoints = aempEndpoints(mode, cfg);
    const deereEp = endpoints.some((e) => e.auth === 'deere_oauth')
      ? deereEndpoints(mode === 'sandbox' ? 'sandbox' : 'live', cfg)
      : null;
    const dropped: string[] = [];
    const client = new AempClient({
      endpoints,
      deere: deereEp
        ? {
            store: new OAuthTokenStore({
              pool: getPool(),
              source: 'deere',
              org: userGrantOrg(deereEp),
              key: tokenKey(cfg.TOKEN_ENC_KEY),
            }),
            refresher: (rt) => refreshDeereTokens(deereEp, rt),
          }
        : null,
      onDropped: (provider, d) => dropped.push(`${provider}: ${d.what} ${d.reason}`),
    });
    for (const ep of endpoints) {
      const page = await client.fleetPage(ep, 1);
      console.log(
        `[aemp live] ${ep.id}: ${page.machines.length} machines, version ${page.version}`,
      );
      expect(page.machines.every((m) => m.id.length > 0)).toBe(true);
    }
    if (dropped.length) console.warn('[aemp live] dropped:', dropped);
  });
});
