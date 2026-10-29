/**
 * Sign-in housekeeping from the PC's terminal (reserved package.json scripts, docs/kiosk.md):
 *
 *   pnpm auth:reset-owner          one-time link (30 min) to set a new owner PIN: the recovery
 *                                  path when the owner forgot it or is locked out. Before the
 *                                  owner exists it prints the first-run setup link instead.
 *   pnpm auth:links                the sign-in lines the launchers print (owner setup or sign-in,
 *                                  devices, demo PINs)
 *   pnpm auth:demo-people [--off]  create the demo crew's sign-ins and print their PINs, or
 *                                  switch every demo person off
 *
 * Runs as farm_app against DATABASE_URL, like the app. Links use PUBLIC_URL (or --base=<url>).
 * Each command spawns nothing and works the same in PowerShell.
 */
import { parseArgs } from 'node:util';
import { getConfig } from '../../config';
import { assertLocalUrl } from '../../db/admin';
import { createPool } from '../../db/client';
import { isMainModule } from '../../lib/proc';
import { authBannerLines, ownerSetupUrl } from './banner';
import { deactivateDemoPeople, formatDemoPins, listDemoPeople, seedDemoPeople } from './demo';
import { issueOwnerReset, listOwners, realOwnerExists } from './store';

export const AUTH_COMMANDS = ['reset-owner', 'links', 'demo-people'] as const;
export type AuthCommand = (typeof AUTH_COMMANDS)[number];

const USAGE = `usage: tsx src/platform/auth/cli.ts <${AUTH_COMMANDS.join('|')}> [--base=<url>] [--off]
  (pnpm auth:reset-owner, pnpm auth:links, pnpm auth:demo-people [--off])`;

export class UsageError extends Error {}

export function parseAuthArgs(argv: string[]): {
  command: AuthCommand;
  base: string | null;
  off: boolean;
} {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        base: { type: 'string' },
        off: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (
    values.help ||
    positionals.length !== 1 ||
    !(AUTH_COMMANDS as readonly string[]).includes(command as string)
  ) {
    throw new UsageError(USAGE);
  }
  const base = (values.base as string | undefined) ?? null;
  if (base !== null && !URL.canParse(base)) throw new UsageError(`--base must be a URL\n${USAGE}`);
  if (values.off && command !== 'demo-people')
    throw new UsageError(`--off is for demo-people\n${USAGE}`);
  return { command: command as AuthCommand, base, off: !!values.off };
}

async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parseAuthArgs>;
  try {
    args = parseAuthArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const cfg = getConfig();
  const base = args.base ?? cfg.PUBLIC_URL;
  const pool = createPool({ max: 2, applicationName: 'farm-auth-cli' });
  try {
    if (args.command === 'links') {
      console.log((await authBannerLines(pool, cfg.SESSION_SECRET, base)).join('\n'));
      return 0;
    }
    if (args.command === 'demo-people') {
      assertLocalUrl(cfg.DATABASE_URL, 'auth:demo-people');
      if (args.off) {
        const n = await deactivateDemoPeople(pool);
        console.log(`[auth] switched off ${n} demo ${n === 1 ? 'person' : 'people'}`);
        return 0;
      }
      const r = await seedDemoPeople(pool, cfg.SESSION_SECRET);
      console.log(
        `[auth] demo people: ${r.inserted} added, ${r.existing} already there, ${r.skipped} skipped (no demo crew or already signed up)`,
      );
      const pins = formatDemoPins(await listDemoPeople(pool, cfg.SESSION_SECRET));
      if (pins.length) console.log(`  Demo PINs: ${pins.join(' · ')}`);
      return 0;
    }
    // reset-owner
    if (!(await realOwnerExists(pool))) {
      console.log('[auth] the owner is not set up yet. Open this link on the PC (one time):');
      console.log(`  ${ownerSetupUrl(base, cfg.SESSION_SECRET)}`);
      return 0;
    }
    const { code, expiresAt } = await issueOwnerReset(pool, cfg.SESSION_SECRET, new Date());
    const url = new URL('/login/setup', base);
    url.searchParams.set('reset', code);
    const owners = (await listOwners(pool)).map((o) => o.displayName).join(', ');
    console.log(
      `[auth] owner PIN reset for ${owners}. Open this link (works once, until ${expiresAt.toLocaleTimeString()}):`,
    );
    console.log(`  ${url}`);
    console.log('  It sets a new PIN, unlocks the owner and signs out their other sessions.');
    return 0;
  } finally {
    await pool.end();
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: Error) => {
      console.error(`[auth] error: ${e.message}`);
      process.exitCode = 1;
    },
  );
}
