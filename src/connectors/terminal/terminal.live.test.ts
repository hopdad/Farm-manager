/**
 * Terminal live contract suite (`pnpm test:live`, by hand only, never in CI; docs/contracts-1f.md
 * §9): the same client against Terminal itself (sandbox: `https://api.sandbox.withterminal.com`,
 * Terminal customers only; live: production) with the application's secret key. Read-only calls
 * only. Without CONNECTOR_TERMINAL=sandbox|live and TERMINAL_SECRET_KEY the suite skips and says
 * what to set. The sandbox Link accepts any credentials: link a test hauler first (Terminal's
 * docs: the username `invalid` or `permissions` simulates a failure).
 */
import { describe, expect, test } from 'vitest';
import { getConfig } from '../../config';
import { TerminalClient } from './client';
import {
  mapTerminalFault,
  mapTerminalPosition,
  mapTerminalProviders,
  mapTerminalStat,
} from './mapper';

const cfg = getConfig();
const mode = cfg.CONNECTOR_TERMINAL;
const ready = (mode === 'sandbox' || mode === 'live') && !!cfg.TERMINAL_SECRET_KEY;
// No `only`: every vehicle of every linked connection (a sandbox fleet is anonymized).
const client = () => TerminalClient.forMode(mode, cfg, { timeoutMs: 30_000 });

describe.skipIf(!ready)(
  'Terminal live (skipped: set CONNECTOR_TERMINAL=sandbox or live and TERMINAL_SECRET_KEY)',
  () => {
    test('connections are discovered with the secret key (each with its token)', async () => {
      const conns = await client().connections();
      for (const c of conns) {
        expect(c.id).toMatch(/^conn_/);
        expect(c.token).not.toBe('');
      }
    });

    test('/providers maps to capability rows for the providers behind the connections', async () => {
      const r = await client().pollProviders(null);
      const [rows] = mapTerminalProviders(r.items[0]?.payload ?? { codes: [], providers: [] });
      expect(rows?.length).toBe(r.items[0]?.payload.codes.length);
    });

    test('history and latest locations map to live and last-known fixes; stats and faults map', async () => {
      const c = client();
      for (const i of (await c.pollPositions(null)).items) {
        const [p] = mapTerminalPosition(i.payload);
        expect(p?.lat).toBeGreaterThanOrEqual(-90);
        expect(p?.speedMph === null || (p?.speedMph ?? 0) >= 0).toBe(true);
      }
      for (const i of (await c.pollStats(null)).items) {
        expect(mapTerminalStat(i.payload).length).toBeLessThanOrEqual(1);
      }
      for (const i of (await c.pollFaults(null)).items) {
        expect(mapTerminalFault(i.payload).length).toBeLessThanOrEqual(1);
      }
    });
  },
);
