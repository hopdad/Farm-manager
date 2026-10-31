/**
 * Samsara live contract suite (1f, sync-health; `pnpm test:live`, by hand on Derrick's PC, never in
 * CI): the live client against Samsara's API with SAMSARA_API_TOKEN (CONNECTOR_SAMSARA=sandbox or
 * live; Samsara has no sandbox host: a test org's token). Read-only: the first page of each feed.
 * Skips with the reason when the mode or the token is missing.
 */
import { describe, expect, test } from 'vitest';
import { type Config, getConfig } from '../../config';
import { SamsaraClient } from './client';

function readiness(): { ready: true; cfg: Config } | { ready: false; why: string } {
  let cfg: Config;
  try {
    cfg = getConfig();
  } catch (e) {
    return { ready: false, why: `configuration: ${(e as Error).message.split('\n')[0]}` };
  }
  if (cfg.CONNECTOR_SAMSARA !== 'sandbox' && cfg.CONNECTOR_SAMSARA !== 'live') {
    return {
      ready: false,
      why: `CONNECTOR_SAMSARA is ${cfg.CONNECTOR_SAMSARA}: set sandbox or live`,
    };
  }
  if (!cfg.SAMSARA_API_TOKEN) return { ready: false, why: 'SAMSARA_API_TOKEN is not set' };
  return { ready: true, cfg };
}

const r = readiness();
if (!r.ready) process.stderr.write(`[samsara live] skipped: ${r.why}\n`);

describe.skipIf(!r.ready)(
  `Samsara live (${r.ready ? r.cfg.CONNECTOR_SAMSARA : `skipped: ${r.ready ? '' : r.why}`})`,
  () => {
    const client = r.ready
      ? SamsaraClient.forMode(r.cfg.CONNECTOR_SAMSARA, r.cfg, { timeoutMs: 60_000 })
      : null;

    test('the vehicle locations feed: first page parses, with a cursor', async () => {
      const page = await (client as SamsaraClient).locationsFeed(null);
      expect(Array.isArray(page.data)).toBe(true);
      expect(typeof page.pagination.endCursor).toBe('string');
    });

    test('the stats feed (engine hours, fuel, odometer): first page parses', async () => {
      const page = await (client as SamsaraClient).statsFeed(null);
      expect(Array.isArray(page.data)).toBe(true);
    });
  },
);
