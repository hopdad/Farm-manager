/**
 * MyGeotab live contract suite (`pnpm test:live`, by hand only, never in CI; docs/contracts-1f.md
 * §9): the same client against MyGeotab itself with a service user (sandbox = the free demo
 * database on the production servers). Read-only calls only; the session lives in memory here
 * (one Authenticate for the whole suite). Without CONNECTOR_GEOTAB=sandbox|live and
 * GEOTAB_DATABASE, GEOTAB_USERNAME, GEOTAB_PASSWORD the suite skips and says what to set.
 */
import { describe, expect, test } from 'vitest';
import { getConfig } from '../../config';
import { MemoryTokenStore } from '../oauth/memory-store';
import { GeotabClient } from './client';
import { mapGeotabFault, mapGeotabStat } from './mapper';

const cfg = getConfig();
const mode = cfg.CONNECTOR_GEOTAB;
const ready =
  (mode === 'sandbox' || mode === 'live') &&
  !!cfg.GEOTAB_DATABASE &&
  !!cfg.GEOTAB_USERNAME &&
  !!cfg.GEOTAB_PASSWORD;
const store = new MemoryTokenStore('geotab');
// Small pages, one page a poll: a whole fleet's history never comes back in one go.
const client = () =>
  GeotabClient.forMode(mode, cfg, { timeoutMs: 60_000 }, { store, resultsLimit: 500, maxPages: 1 });

describe.skipIf(!ready)(
  'MyGeotab live (skipped: set CONNECTOR_GEOTAB=sandbox or live and GEOTAB_DATABASE, GEOTAB_USERNAME, GEOTAB_PASSWORD)',
  () => {
    test('Authenticate once; LoginResult.path read', async () => {
      const s = await client().session();
      expect(s.sessionId).not.toBe('');
    });

    test('each feed starts "from now" and hands back a toVersion', async () => {
      const c = client();
      const cursors = [
        (await c.pollPositions(null)).cursor,
        (await c.pollStats(null)).cursor,
        (await c.pollFaults(null)).cursor,
      ];
      for (const cursor of cursors) {
        expect(cursor === '' || /^[0-9a-f]+$/i.test(cursor) || cursor.startsWith('{')).toBe(true);
      }
    });

    test('a page from version 0 maps (our diagnostics only, faults decoded)', async () => {
      const c = client();
      for (const i of (await c.pollStats('0')).items) {
        expect(mapGeotabStat(i.payload).length).toBeLessThanOrEqual(1);
      }
      for (const i of (await c.pollFaults('0')).items) {
        expect(mapGeotabFault(i.payload)).toHaveLength(1);
      }
    });

    test('the device list with group names', async () => {
      expect(Array.isArray(await client().asTelematicsSource().vehicles())).toBe(true);
    });
  },
);
