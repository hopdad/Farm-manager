/**
 * The admin gate for M0's admin pages and their server actions (/admin/connectors,
 * /admin/realtime): a manager or the owner (ROLE_FOR.admin, docs/contracts-m1.md §4). The M1
 * pages call requireRole / pageSession themselves.
 *
 * The admin link `pnpm dev` prints (`farm_admin` cookie, src/platform/auth/admin-key.ts) still
 * opens them on the PC: getSession() treats it as a provisional owner (never in production).
 */
import { ADMIN_LOCKED_MESSAGE } from '@/platform/auth/admin-key';
import {
  getSession,
  isAuthError,
  ROLE_FOR,
  requireRole,
  roleAtLeast,
} from '@/platform/auth/server';

export class AdminLockedError extends Error {
  constructor() {
    super(ADMIN_LOCKED_MESSAGE);
    this.name = 'AdminLockedError';
  }
}

/** Is a manager (or the owner, or the admin link on the PC) signed in on this request? */
export async function adminUnlocked(): Promise<boolean> {
  const s = await getSession();
  return !!s && roleAtLeast(s.role, ROLE_FOR.admin);
}

/** Throws AdminLockedError unless a manager (or above) is signed in. */
export async function assertAdmin(): Promise<void> {
  try {
    await requireRole(ROLE_FOR.admin);
  } catch (e) {
    if (isAuthError(e)) throw new AdminLockedError();
    throw e;
  }
}
