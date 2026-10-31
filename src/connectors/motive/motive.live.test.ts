/**
 * Motive live contract suite (`pnpm test:live`, by hand only, never in CI; docs/contracts-1f.md
 * §9): the same client against Motive itself with a hauler's company key (read-only scopes;
 * sandbox = a TEST MODE key on the same host). Read-only calls only. Without
 * CONNECTOR_MOTIVE=sandbox|live and MOTIVE_API_KEY the suite skips and says what to set.
 */
import { describe, expect, test } from 'vitest';
import { getConfig } from '../../config';
import { MotiveClient } from './client';
import { mapMotiveFault, mapMotivePosition, mapMotiveStat } from './mapper';

const cfg = getConfig();
const mode = cfg.CONNECTOR_MOTIVE;
const ready = (mode === 'sandbox' || mode === 'live') && !!cfg.MOTIVE_API_KEY;
const client = () => MotiveClient.forMode(mode, cfg, { timeoutMs: 30_000 });

describe.skipIf(!ready)(
  'Motive live (skipped: set CONNECTOR_MOTIVE=sandbox or live and MOTIVE_API_KEY)',
  () => {
    test('the company id (the sourceOrg)', async () => {
      expect(await client().companyId()).not.toBe('');
    });

    test('vehicle locations: v3 gateway units and v2 for the rest map to positions', async () => {
      const r = await client().pollPositions(null);
      for (const i of r.items) {
        const [p] = mapMotivePosition(i.payload);
        expect(p?.lat).toBeGreaterThanOrEqual(-90);
        expect(p?.speedMph === null || (p?.speedMph ?? 0) >= 0).toBe(true);
      }
    });

    test('stats from v2 current_location, and the fault codes of the last week', async () => {
      const c = client();
      for (const i of (await c.pollStats(null)).items) {
        expect(mapMotiveStat(i.payload).length).toBeLessThanOrEqual(1);
      }
      for (const i of (await c.pollFaults(null)).items) {
        expect(Array.isArray(mapMotiveFault(i.payload))).toBe(true);
      }
    });

    test('the vehicle list with its group names', async () => {
      const v = await client().asTelematicsSource().vehicles();
      expect(Array.isArray(v)).toBe(true);
    });
  },
);
