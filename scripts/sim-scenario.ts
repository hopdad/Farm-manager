/**
 * pnpm sim:scenario <name> [--speed N] [--poll S] [--seed N] [--days N] [--assert] [--json] [--wall]
 *
 * Runs a scenario headless (plan §3 / §7) and prints what happened: acres worked per field,
 * loads per elevator, miles / hours / fuel per machine, and the checks (transport stays on the
 * section-line roads, no pass leaves its field, counters only go up, the scenario's own
 * expectations). The world is a pure function of (scenario, seed, sim time), so a whole day
 * runs in about a second.
 *
 *   --speed N   sim speed the board would run at (default 60): sets the board-view sampling
 *               (one poll every --poll wall seconds = poll x speed sim seconds)
 *   --poll S    wall seconds between board polls (default 5)
 *   --seed N    world seed (default SIM_SEED, else 1)
 *   --days N    run N days from the scenario's first day (default 1)
 *   --assert    exit 1 when any check fails (CI)
 *   --json      print the full result as JSON
 *   --wall      also replay the day in wall time at --speed (Ctrl+C stops), printing one
 *               status line per poll, like a headless board
 *
 * Touches no database or network (so it needs no .env), and runs the same on Windows.
 */
import { parseArgs } from 'node:util';
import { tryGetConfig } from '../src/config';
import { isMainModule } from '../src/lib/proc';
import { runScenario, type ScenarioRun } from '../src/sim/check';
import { SCENARIO_NAMES, type ScenarioName } from '../src/sim/types';
import { createDemoWorld } from '../src/sim/world';

export interface SimScenarioArgs {
  scenario: ScenarioName;
  speed: number;
  poll: number;
  seed: number;
  days: number;
  assert: boolean;
  json: boolean;
  wall: boolean;
}

export class UsageError extends Error {}

const USAGE = `usage: pnpm sim:scenario <${SCENARIO_NAMES.join('|')}> [--speed N] [--poll S] [--seed N] [--days N] [--assert] [--json] [--wall]`;

function positiveNumber(
  name: string,
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0 || v > max) {
    throw new UsageError(`--${name} must be a number in (0, ${max}] (got '${raw}')`);
  }
  return v;
}

/** Parse argv (without node and the script). `defaultSeed` comes from config when available. */
export function parseSimScenarioArgs(argv: string[], defaultSeed = 1): SimScenarioArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        speed: { type: 'string' },
        poll: { type: 'string' },
        seed: { type: 'string' },
        days: { type: 'string' },
        assert: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        wall: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) throw new UsageError(USAGE);
  const name = positionals[0];
  if (!name || positionals.length > 1) throw new UsageError(USAGE);
  if (!(SCENARIO_NAMES as readonly string[]).includes(name)) {
    throw new UsageError(`unknown scenario '${name}'\n${USAGE}`);
  }
  const seedRaw = values.seed as string | undefined;
  let seed = defaultSeed;
  if (seedRaw !== undefined) {
    seed = Number(seedRaw);
    if (!Number.isInteger(seed) || seed < 0) throw new UsageError('--seed must be an integer >= 0');
  }
  return {
    scenario: name as ScenarioName,
    speed: positiveNumber('speed', values.speed as string | undefined, 60, 3600),
    poll: positiveNumber('poll', values.poll as string | undefined, 5, 3600),
    seed,
    days: Math.floor(positiveNumber('days', values.days as string | undefined, 1, 30)),
    assert: Boolean(values.assert),
    json: Boolean(values.json),
    wall: Boolean(values.wall),
  };
}

const pad = (v: unknown, n: number) => String(v).padEnd(n);
const lpad = (v: unknown, n: number) => String(v).padStart(n);

/** Human-readable summary. */
export function formatRun(run: ScenarioRun): string {
  const out: string[] = [];
  out.push(
    `${run.scenario} (seed ${run.seed}), ${run.days.length} day(s) from ${run.days[0]?.start}, starts at ${run.startsAt}`,
  );
  const acres = Object.entries(run.summary.acres)
    .map(([op, a]) => `${op} ${a} ac`)
    .join(', ');
  out.push(`work: ${acres || 'none'}; loads: ${run.summary.loads} (${run.summary.bushels} bu)`);
  for (const [e, n] of Object.entries(run.summary.loadsByElevator))
    out.push(`  ${pad(e, 34)} ${lpad(n, 4)} loads`);
  for (const [f, a] of Object.entries(run.summary.acresByField))
    out.push(`  ${pad(f, 34)} ${lpad(a, 8)} ac`);
  out.push('');
  out.push(
    `${pad('unit', 6)}${pad('kind', 11)}${lpad('miles', 8)}${lpad('eng h', 8)}${lpad('work h', 8)}${lpad('max mph', 9)}${lpad('fuel %', 8)}`,
  );
  for (const m of run.summary.machines) {
    out.push(
      `${pad(m.unitNo, 6)}${pad(m.kind, 11)}${lpad(m.miles, 8)}${lpad(m.engineHours, 8)}${lpad(m.workingHours, 8)}${lpad(m.maxSpeedMph, 9)}${lpad(m.fuelUsedPct, 8)}`,
    );
  }
  const b = run.summary.board;
  out.push('');
  out.push(
    `board at ${run.speed}x, polling every ${run.pollSeconds} s (${b.pollSimSeconds} sim s): ${b.samples} samples, largest jump ${b.maxJumpM} m (${b.maxJumpUnit})`,
  );
  out.push('');
  for (const c of run.checks) out.push(`${c.ok ? 'PASS' : 'FAIL'}  ${pad(c.name, 44)} ${c.detail}`);
  out.push('');
  out.push(
    run.ok ? 'all checks passed' : `${run.checks.filter((c) => !c.ok).length} check(s) failed`,
  );
  return out.join('\n');
}

/** Replay day 0 in wall time at `speed`, one status line per poll, until done or Ctrl+C. */
async function replayWall(args: SimScenarioArgs, signal: AbortSignal): Promise<void> {
  const world = createDemoWorld({ scenario: args.scenario, seed: args.seed });
  const w = world.dayWindow(0);
  const startWall = Date.now();
  const startSim = world.startsAt.getTime();
  for (;;) {
    if (signal.aborted) return;
    const sim = startSim + (Date.now() - startWall) * args.speed;
    if (sim >= w.end.getTime()) return;
    const parts = world.farm.machines.map((m) => {
      const s = world.machineAt(m.id, new Date(sim));
      if (!s) return `${m.unitNo}:?`;
      return `${m.unitNo}:${s.activity.slice(0, 4)}${s.speedMph > 0 ? `@${Math.round(s.speedMph)}` : ''}`;
    });
    console.log(`${new Date(sim).toISOString().slice(11, 19)}Z  ${parts.join(' ')}`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, args.poll * 1000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function main(): Promise<void> {
  const cfg = tryGetConfig();
  const defaultSeed = cfg.ok ? cfg.config.SIM_SEED : 1;
  let args: SimScenarioArgs;
  try {
    args = parseSimScenarioArgs(process.argv.slice(2), defaultSeed);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 2;
    return;
  }
  const started = performance.now();
  const run = runScenario({
    scenario: args.scenario,
    seed: args.seed,
    days: args.days,
    speed: args.speed,
    pollSeconds: args.poll,
  });
  if (args.json) console.log(JSON.stringify(run, null, 2));
  else {
    console.log(formatRun(run));
    console.log(`(ran in ${Math.round(performance.now() - started)} ms)`);
  }
  if (args.wall) {
    const ac = new AbortController();
    const stop = () => ac.abort();
    // Ctrl+C: Node delivers SIGINT on Windows consoles too.
    process.once('SIGINT', stop);
    try {
      await replayWall(args, ac.signal);
    } finally {
      process.off('SIGINT', stop);
    }
  }
  if (args.assert && !run.ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) await main();
