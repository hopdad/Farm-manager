/**
 * The admin lock for server components and server actions (src/platform/auth/admin-key.ts):
 * the `farm_admin` cookie set by /admin/unlock must carry this install's admin key.
 */
import { cookies } from 'next/headers';
import { getConfig } from '@/config';
import { ADMIN_COOKIE, ADMIN_LOCKED_MESSAGE, isAdminKey } from '@/platform/auth/admin-key';

export class AdminLockedError extends Error {
  constructor() {
    super(ADMIN_LOCKED_MESSAGE);
    this.name = 'AdminLockedError';
  }
}

/** Does this request carry the admin cookie? */
export async function adminUnlocked(): Promise<boolean> {
  return isAdminKey(getConfig(), (await cookies()).get(ADMIN_COOKIE)?.value);
}

/** Throws AdminLockedError unless the request carries the admin cookie. */
export async function assertAdmin(): Promise<void> {
  if (!(await adminUnlocked())) throw new AdminLockedError();
}
