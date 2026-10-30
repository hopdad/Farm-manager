/**
 * Sim connector setup (bootstrap step 7; also `pnpm vendor-sim:connect`): in sim mode, connect
 * the simulated vendor accounts once so `pnpm dev` syncs from its first job run.
 *
 *  - Deere: the authorization-code flow against the stand-in's unattended consent
 *    (`simAutoConnect`, sim only), tokens stored encrypted in ingest.oauth_tokens with
 *    TOKEN_ENC_KEY. An existing grant the stand-in still accepts is kept (refreshed if needed).
 *    Then one organizations + machines read proves the token works.
 *  - Trucks (1f.2: each telematics vendor on its own key; Samsara and Motive have sim clients
 *    today): sim bearer tokens are fixed (SIM_CREDENTIALS); one feed read proves each.
 *
 * It uses the stand-in already answering at VENDOR_SIM_URL, or starts one in-process on that
 * port for the duration, with the same state file (.data/vendor-sim/state.json), so the grant is
 * still valid when `pnpm dev` starts the stand-in later (the launcher restarts the scenario day
 * through /_control/scenario, which keeps grants).
 *
 * Connectors in sandbox/live are skipped: a person connects those at /api/oauth/deere.
 * Exit codes: 0 ok or nothing to do, 1 failure.
 */
import path from 'node:path';
import type pg from 'pg';
import { type Config, getConfig } from '../../src/config';
import { DeereClient } from '../../src/connectors/deere/client';
import { deereEndpoints } from '../../src/connectors/endpoints';
import { MotiveClient } from '../../src/connectors/motive/client';
import { tokenKey } from '../../src/connectors/oauth/crypto';
import { OAuthTokenStore, SIM_GRANT_ORG } from '../../src/connectors/oauth/token-store';
import { SamsaraClient } from '../../src/connectors/samsara/client';
import { createPool } from '../../src/db/client';
import { isMainModule } from '../../src/lib/proc';
import { createSimWorld } from '../../src/sim/index';
import type { SimStatus } from '../../src/sim/types';
import { startVendorSim, type VendorSim } from '../../src/sim/vendors/server';
import { fileStateStore, STATE_FILE } from './state-file';

export type ConnectConfig = Pick<
  Config,
  | 'CONNECTOR_DEERE'
  | 'CONNECTOR_SAMSARA'
  | 'CONNECTOR_MOTIVE'
  | 'VENDOR_SIM_URL'
  | 'PUBLIC_URL'
  | 'TOKEN_ENC_KEY'
>;

/** The truck vendors with a sim client today (the 1f.2 builders add theirs). */
export const CONNECT_TRUCK_VENDORS = ['samsara', 'motive'] as const;
type TruckCheck = { status: 'skipped'; why: string } | { status: 'verified'; vehicles: number };

export interface ConnectSimOptions {
  cfg: ConnectConfig;
  /** App pool (farm_app): ingest.oauth_tokens. */
  pool: pg.Pool;
  log?: (line: string) => void;
}

export interface ConnectSimResult {
  deere:
    | { status: 'skipped'; why: string }
    | { status: 'connected' | 'verified'; orgs: number; machines: number };
  trucks: Record<(typeof CONNECT_TRUCK_VENDORS)[number], TruckCheck>;
}

/** Connect (or verify) every sim-mode vendor account against the stand-in at VENDOR_SIM_URL. */
export async function connectSimVendors(o: ConnectSimOptions): Promise<ConnectSimResult> {
  const { cfg, pool } = o;
  const log = o.log ?? (() => {});
  const result: ConnectSimResult = {
    deere: { status: 'skipped', why: `CONNECTOR_DEERE=${cfg.CONNECTOR_DEERE}` },
    trucks: {
      samsara: { status: 'skipped', why: `CONNECTOR_SAMSARA=${cfg.CONNECTOR_SAMSARA}` },
      motive: { status: 'skipped', why: `CONNECTOR_MOTIVE=${cfg.CONNECTOR_MOTIVE}` },
    },
  };

  if (cfg.CONNECTOR_DEERE === 'sim') {
    const tokens = new OAuthTokenStore({
      pool,
      source: 'deere',
      org: SIM_GRANT_ORG,
      key: tokenKey(cfg.TOKEN_ENC_KEY),
    });
    const had = (await tokens.read()) !== null;
    // autoConnect: a missing or rejected grant is (re)created with the stand-in's consent.
    const client = new DeereClient({ endpoints: deereEndpoints('sim', cfg), tokens });
    const orgs = await client.organizations();
    let machines = 0;
    for (const org of orgs) machines += (await client.machines(org.id)).length;
    result.deere = { status: had ? 'verified' : 'connected', orgs: orgs.length, machines };
    log(
      `Deere (sim): ${had ? 'existing grant works' : 'connected'}; ${orgs.length} org(s), ${machines} machine(s)`,
    );
  } else {
    log(`Deere: ${cfg.CONNECTOR_DEERE} mode, skipped (connect a real account at /api/oauth/deere)`);
  }

  if (cfg.CONNECTOR_SAMSARA === 'sim') {
    const page = await SamsaraClient.forMode('sim', cfg).locationsFeed(null);
    result.trucks.samsara = { status: 'verified', vehicles: page.data.length };
    log(`Samsara (sim): API token works; ${page.data.length} vehicle(s)`);
  } else {
    log(`Samsara: ${cfg.CONNECTOR_SAMSARA} mode, skipped`);
  }
  if (cfg.CONNECTOR_MOTIVE === 'sim') {
    const r = await MotiveClient.forMode('sim', cfg).pollPositions(null);
    const vehicles = new Set(r.items.map((i) => i.externalId)).size;
    result.trucks.motive = { status: 'verified', vehicles };
    log(`Motive (sim): API key works; ${vehicles} vehicle(s)`);
  } else {
    log(`Motive: ${cfg.CONNECTOR_MOTIVE} mode, skipped`);
  }
  return result;
}

/** GET /_control/status of a running stand-in, or null. */
async function runningStandIn(baseUrl: string): Promise<SimStatus | null> {
  try {
    const res = await fetch(`${baseUrl}/_control/status`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as SimStatus;
    return body?.clock && body.scenario ? body : null;
  } catch {
    return null;
  }
}

export async function main(): Promise<number> {
  const cfg = getConfig();
  const say = (line: string) => console.log(`[vendor-sim:connect] ${line}`);
  if (
    cfg.CONNECTOR_DEERE !== 'sim' &&
    cfg.CONNECTOR_SAMSARA !== 'sim' &&
    cfg.CONNECTOR_MOTIVE !== 'sim'
  ) {
    say('no connector is in sim mode; nothing to do');
    return 0;
  }
  const base = new URL(cfg.VENDOR_SIM_URL);
  let started: VendorSim | null = null;
  if (await runningStandIn(base.origin)) {
    say(`using the stand-in running at ${base.origin}`);
  } else {
    started = await startVendorSim({
      createWorld: createSimWorld,
      host: base.hostname === 'localhost' ? '127.0.0.1' : base.hostname,
      port: Number(base.port) || 80,
      store: fileStateStore(path.join(cfg.projectDir, STATE_FILE), say),
      scenario: cfg.SIM_SCENARIO,
      seed: cfg.SIM_SEED,
      speed: cfg.SIM_SPEED,
      frozenAt: cfg.SIM_FROZEN_AT,
    });
    say(`started the stand-in at ${started.url} for setup`);
  }
  const pool = createPool({ max: 2, applicationName: 'farm-sim-connect' });
  try {
    await connectSimVendors({ cfg, pool, log: say });
    return 0;
  } catch (e) {
    say(`failed: ${(e as Error).message}`);
    return 1;
  } finally {
    await pool.end().catch(() => {});
    await started?.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      const err = e as NodeJS.ErrnoException;
      console.error(
        `[vendor-sim:connect] ${err.code === 'EADDRINUSE' ? `port ${new URL(getConfig().VENDOR_SIM_URL).port} is in use by something that is not the stand-in` : (err.stack ?? String(e))}`,
      );
      process.exit(1);
    },
  );
}
