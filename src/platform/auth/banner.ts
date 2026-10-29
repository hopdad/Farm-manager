/**
 * What the launchers print about sign-in (`pnpm run bootstrap`, `pnpm dev` and `pnpm pilot` call
 * `authBannerLines` from scripts/bootstrap.ts and tools/dev.ts; `pnpm auth:links` prints the same):
 *
 *  - until the farm's owner exists: the one-time OWNER SETUP link (derived from SESSION_SECRET,
 *    so every launcher prints the same link; it stops working once the owner is set up);
 *  - afterwards: where to sign in, and the recovery command;
 *  - the demo people's PINs (this install's; ./demo.ts) while they are switched on;
 *  - where devices are enrolled.
 */
import type { Executor } from '../../db/exec';
import { ownerSetupCode } from './codes';
import { formatDemoPins, listDemoPeople } from './demo';
import { realOwnerExists } from './store';

export const OWNER_SETUP_PATH = '/login/setup';
export const RESET_OWNER_COMMAND = 'pnpm auth:reset-owner';

/** The first-run owner setup link for `base` (the app's origin as this PC opens it). */
export function ownerSetupUrl(base: string, secret: string): string {
  const url = new URL(OWNER_SETUP_PATH, base);
  url.searchParams.set('code', ownerSetupCode(secret));
  return url.toString();
}

/** Banner lines (two-space indent, matching tools/dev.ts); never throws (a note instead). */
export async function authBannerLines(
  ex: Executor,
  secret: string,
  base: string,
): Promise<string[]> {
  try {
    const lines: string[] = [];
    if (await realOwnerExists(ex)) {
      lines.push(
        `  Sign in   ${new URL('/login', base)}   (forgot the owner PIN? ${RESET_OWNER_COMMAND})`,
      );
    } else {
      lines.push(`  Owner     ${ownerSetupUrl(base, secret)}`);
      lines.push('            (first run, on this PC: makes you the owner, with your own PIN)');
    }
    lines.push(
      `  Devices   ${new URL('/admin/devices', base)}   (enroll the wall and cab iPads: docs/kiosk.md)`,
    );
    const pins = formatDemoPins(await listDemoPeople(ex, secret));
    if (pins.length) {
      lines.push('  Demo PINs (switch them off on /admin/people before real use):');
      for (let i = 0; i < pins.length; i += 3)
        lines.push(`    ${pins.slice(i, i + 3).join(' · ')}`);
    }
    return lines;
  } catch (e) {
    return [`  Sign-in   (could not read the people table: ${(e as Error).message})`];
  }
}
