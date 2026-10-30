/**
 * Bootstrap's sim connector setup against the stand-in in-process (stub world, random port):
 * the first run creates the Deere grant through the unattended consent, a second run reuses it
 * (no new authorization-code grant), and connectors outside sim mode are skipped.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startVendorSim, type VendorSim } from '../../src/sim/vendors/server';
import { createStubSimWorld } from '../../src/sim/vendors/stub-world';
import { setupTestDb } from '../../src/test/db';
import { type ConnectConfig, connectSimVendors } from './connect';

const t = setupTestDb(import.meta.url);
let sim: VendorSim;
let cfg: ConnectConfig;

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createStubSimWorld, port: 0 });
  cfg = {
    CONNECTOR_DEERE: 'sim',
    CONNECTOR_SAMSARA: 'sim',
    // The stub world has no Motive vehicle; the Motive check is the same call shape.
    CONNECTOR_MOTIVE: 'sim',
    VENDOR_SIM_URL: sim.url,
    PUBLIC_URL: 'http://localhost:3000',
    TOKEN_ENC_KEY: 'cd'.repeat(32),
  };
});
afterAll(() => sim.close());

describe('connectSimVendors', () => {
  test('connects Deere once, then only verifies; checks each truck vendor token', async () => {
    const lines: string[] = [];
    const first = await connectSimVendors({ cfg, pool: t().pool, log: (l) => lines.push(l) });
    expect(first.deere).toMatchObject({ status: 'connected' });
    expect(first.deere.status !== 'skipped' && first.deere.machines).toBeGreaterThan(0);
    expect(first.trucks.samsara).toMatchObject({ status: 'verified' });
    expect(
      first.trucks.samsara.status === 'verified' && first.trucks.samsara.vehicles,
    ).toBeGreaterThan(0);
    expect(first.trucks.motive).toEqual({ status: 'verified', vehicles: 0 });
    const rows = await t().pool.query(
      `select count(*)::int as n from ingest.oauth_tokens where source = 'deere'`,
    );
    expect(rows.rows[0].n).toBe(1);
    const grants = sim.counters.tokenGrants.authorization_code;

    const second = await connectSimVendors({ cfg, pool: t().pool });
    expect(second.deere).toMatchObject({ status: 'verified' });
    expect(sim.counters.tokenGrants.authorization_code).toBe(grants);
    expect(lines.join('\n')).toMatch(/Deere \(sim\): connected/);
  });

  test('connectors outside sim mode are skipped', async () => {
    const r = await connectSimVendors({
      cfg: { ...cfg, CONNECTOR_DEERE: 'off', CONNECTOR_SAMSARA: 'replay', CONNECTOR_MOTIVE: 'off' },
      pool: t().pool,
    });
    expect(r).toEqual({
      deere: { status: 'skipped', why: 'CONNECTOR_DEERE=off' },
      trucks: {
        samsara: { status: 'skipped', why: 'CONNECTOR_SAMSARA=replay' },
        motive: { status: 'skipped', why: 'CONNECTOR_MOTIVE=off' },
      },
    });
  });
});
