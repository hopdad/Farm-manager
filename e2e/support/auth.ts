/**
 * Sessions in e2e (docs/contracts-m1.md §2 "E2E sessions", §4). Every M1 spec gets its session
 * from `signInAs`, before its first navigation, and never calls `unlockAdmin` itself (only M0's
 * specs do):
 *
 *   await signInAs(context, 'driver');                 // the role the action needs (ROLE_FOR)
 *   await signInAs(context);                           // 'viewer': reads
 *   await signInAs(phone, 'viewer', 'http://<lan-ip>:3000'); // a context on another host
 *
 * Cookies belong to one host: a context that opens the app on another origin than the suite's
 * baseURL (the M0 demo's phone on the LAN address) passes that origin.
 *
 * PLACEHOLDER (contracts stage), matching the placeholder getSession() in
 * src/platform/auth/server.ts until the auth builder's LocalAuth lands:
 *  - 'viewer': nothing to add. A request without the admin cookie is already the provisional
 *    anonymous viewer, so "a viewer is refused" (403) can be asserted today.
 *  - 'driver' and above: the admin cookie (`unlockAdmin`), i.e. a provisional OWNER session. A
 *    spec can show the role it needs is enough, not yet that a lower role above viewer is
 *    refused: test those refusals with `runWithSession` in unit/DB tests until auth lands.
 *
 * The auth builder reimplements it with this exact signature: a real device or person session
 * for exactly `role`, as cookies for `baseURL`'s host (pnpm pilot over http://<lan-ip> included).
 */
import type { BrowserContext } from '@playwright/test';
import { getE2eSettings } from '../../src/config';
import type { Role } from '../../src/platform/auth/types';
import { unlockAdmin } from './admin';

export async function signInAs(
  context: BrowserContext,
  role: Role = 'viewer',
  baseURL: string = getE2eSettings().baseURL,
): Promise<void> {
  if (role === 'viewer') return;
  await unlockAdmin(context, baseURL);
}
