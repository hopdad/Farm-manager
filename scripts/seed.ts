/**
 * pnpm db:seed demo [--seed N]
 *
 * Writes the simulated demo farm (fields, parties, fleet, elevators, seasons, external refs)
 * into the database DATABASE_URL names, as farm_app, then the M1 extras (tools/seed/extras.ts:
 * demo people with their PINs, soils, synthetic parcels, the online NAIP layer row). `pnpm db:reset` runs `scripts/seed.ts demo`
 * after migrating. Idempotent: running it again changes nothing. Refuses any database that
 * isn't on this machine (plan §1). The seed defaults to SIM_SEED; every machine's refs use its own vendor.
 */
import { parseArgs } from 'node:util';
import { getConfig } from '../src/config';
import { assertLocalUrl } from '../src/db/admin';
import { createPool } from '../src/db/client';
import { isMainModule } from '../src/lib/proc';
import { formatSeedReport, seedDemo } from '../tools/seed/demo';
import { formatExtrasReport, seedDemoExtras } from '../tools/seed/extras';

export const SEED_SETS = ['demo'] as const;
export type SeedSet = (typeof SEED_SETS)[number];

export class UsageError extends Error {}

const USAGE = `usage: pnpm db:seed <${SEED_SETS.join('|')}> [--seed N]`;

export function parseSeedArgs(argv: string[], defaultSeed: number): { set: SeedSet; seed: number } {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { seed: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false } },
    });
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length !== 1) throw new UsageError(USAGE);
  const set = positionals[0] as string;
  if (!(SEED_SETS as readonly string[]).includes(set)) {
    throw new UsageError(`unknown seed set '${set}'\n${USAGE}`);
  }
  let seed = defaultSeed;
  const raw = values.seed as string | undefined;
  if (raw !== undefined) {
    seed = Number(raw);
    if (!Number.isInteger(seed) || seed < 0) throw new UsageError('--seed must be an integer >= 0');
  }
  return { set: set as SeedSet, seed };
}

async function main(): Promise<void> {
  const cfg = getConfig();
  let args: { set: SeedSet; seed: number };
  try {
    args = parseSeedArgs(process.argv.slice(2), cfg.SIM_SEED);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 2;
    return;
  }
  assertLocalUrl(cfg.DATABASE_URL, 'db:seed');
  const pool = createPool({ max: 2, applicationName: 'farm-seed' });
  try {
    const started = performance.now();
    const report = await seedDemo(pool, { seed: args.seed });
    const db = new URL(cfg.DATABASE_URL).pathname.slice(1) || 'postgres';
    console.log(
      `[seed] ${args.set} (seed ${report.seed}) into ${db} in ${Math.round(performance.now() - started)} ms`,
    );
    console.log(formatSeedReport(report));
    const extras = await seedDemoExtras(pool, {
      secret: cfg.SESSION_SECRET,
      projectDir: cfg.projectDir,
    });
    for (const l of await formatExtrasReport(pool, extras, cfg.SESSION_SECRET)) console.log(l);
  } finally {
    await pool.end();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    console.error(`[seed] error: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
