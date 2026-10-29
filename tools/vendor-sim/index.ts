/**
 * `pnpm vendor-sim`: the vendor API stand-in (plan §5, contracts §9) on loopback.
 *
 *   pnpm vendor-sim [--port 4010] [--scenario harvest-day] [--seed 1] [--speed 30]
 *                   [--fresh] [--stub-world] [--no-persist] [--log-requests] [--stdin-shutdown]
 *
 * Spawn it from Node on any OS as `process.execPath <tsx cli> tools/vendor-sim/index.ts …`
 * (src/lib/proc.ts `tsxBin()`), or `node --import tsx tools/vendor-sim/index.ts`.
 *
 * Defaults come from src/config.ts: port and host from VENDOR_SIM_URL, SIM_SCENARIO, SIM_SEED,
 * SIM_SPEED, SIM_FROZEN_AT, PUBLIC_URL (webhook target). State persists in
 * .data/vendor-sim/state.json and is resumed when the scenario and seed match.
 *
 * Shutdown: Ctrl+C (SIGINT), SIGTERM, Windows Ctrl+Break (SIGBREAK), or with --stdin-shutdown
 * when the parent closes our stdin (the portable way for tools/dev.ts on Windows, where
 * child.kill() is a hard TerminateProcess). State is written on every change, so even a hard
 * kill loses nothing.
 *
 * Readiness: prints `[vendor-sim] ready <url>` once listening; GET <url>/_control/status answers.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getConfig } from '../../src/config';
import { reservedPortHint } from '../../src/lib/ports';
import { createSimWorld } from '../../src/sim/index';
import { SCENARIO_NAMES, type ScenarioName } from '../../src/sim/types';
import { startVendorSim } from '../../src/sim/vendors/server';
import { memoryStateStore } from '../../src/sim/vendors/state';
import { createStubSimWorld } from '../../src/sim/vendors/stub-world';
import { fileStateStore, STATE_FILE } from './state-file';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function fail(msg: string): never {
  console.error(`[vendor-sim] ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      scenario: { type: 'string' },
      seed: { type: 'string' },
      speed: { type: 'string' },
      fresh: { type: 'boolean', default: false },
      'stub-world': { type: 'boolean', default: false },
      'no-persist': { type: 'boolean', default: false },
      'log-requests': { type: 'boolean', default: false },
      'stdin-shutdown': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const cfg = getConfig();
  const simUrl = new URL(cfg.VENDOR_SIM_URL);
  const host = values.host ?? (simUrl.hostname === 'localhost' ? '127.0.0.1' : simUrl.hostname);
  if (!LOOPBACK_HOSTS.has(host)) fail(`refusing to listen on non-loopback host '${host}'`);
  const port = Number(values.port ?? (simUrl.port || 80));
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`bad --port '${values.port}'`);

  const scenario = (values.scenario ?? cfg.SIM_SCENARIO) as ScenarioName;
  if (!(SCENARIO_NAMES as readonly string[]).includes(scenario)) {
    fail(`unknown scenario '${scenario}' (one of ${SCENARIO_NAMES.join(', ')})`);
  }
  const seed = values.seed !== undefined ? Number(values.seed) : cfg.SIM_SEED;
  if (!Number.isInteger(seed) || seed < 0) fail(`bad --seed '${values.seed}'`);
  const speed = values.speed !== undefined ? Number(values.speed) : cfg.SIM_SPEED;
  if (!(speed > 0) || speed > 3600) fail(`bad --speed '${values.speed}' (0 < speed <= 3600)`);

  const log = values.quiet ? () => {} : (line: string) => console.log(`[vendor-sim] ${line}`);
  const store = values['no-persist']
    ? memoryStateStore()
    : fileStateStore(path.join(cfg.projectDir, STATE_FILE), log);

  let sim: Awaited<ReturnType<typeof startVendorSim>>;
  try {
    sim = await startVendorSim({
      createWorld: values['stub-world'] ? createStubSimWorld : createSimWorld,
      host,
      port,
      store,
      scenario,
      seed,
      speed,
      frozenAt: cfg.SIM_FROZEN_AT,
      fresh: values.fresh,
      log,
      logRequests: values['log-requests'],
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') fail(`port ${port} is in use (another stand-in running?)`);
    if (err.code === 'EACCES')
      fail(reservedPortHint(port, 'VENDOR_SIM_URL in .env.local, or --port'));
    fail(`${err.message}\n  (--stub-world serves a small test world instead)`);
  }

  console.log(
    `[vendor-sim] ready ${sim.url} (scenario ${sim.world.scenario}, seed ${sim.world.seed}, ` +
      `speed ${sim.status().clock.speed}; webhooks -> ${cfg.PUBLIC_URL}/api/webhooks/<source>)`,
  );

  let closing = false;
  const shutdown = (why: string) => {
    if (closing) return;
    closing = true;
    log(`shutting down (${why})`);
    const force = setTimeout(() => process.exit(0), 3_000);
    force.unref();
    sim.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Windows: Ctrl+Break in the console.
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  if (values['stdin-shutdown']) {
    process.stdin.on('end', () => shutdown('stdin closed'));
    process.stdin.on('error', () => shutdown('stdin error'));
    process.stdin.resume();
  }
}

main().catch((e: unknown) => fail((e as Error).stack ?? String(e)));
