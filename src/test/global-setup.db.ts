/**
 * Vitest globalSetup for the `db` project: make sure farm_test_template exists and matches the
 * current migrations (rebuilt under the server-wide template lock, so concurrent runs and
 * parallel agents rebuild it at most once), and that farm_app can log in.
 */
import { getConfig } from '../config';
import { farmAppCanLogin, refreshTestTemplate } from '../db/admin';

export default async function setup(): Promise<void> {
  const cfg = getConfig();
  const state = await refreshTestTemplate({ log: (m) => console.log(`[test:db] ${m}`) });
  if (state === 'rebuilt')
    console.log('[test:db] farm_test_template rebuilt for the current migrations');
  const err = await farmAppCanLogin(cfg.DATABASE_URL);
  // Never ALTER ROLE here: roles are cluster-wide, so changing farm_app's password from one
  // checkout would break every other checkout sharing the container.
  if (err)
    throw new Error(
      `farm_app cannot log in with DATABASE_URL (${err}). Run pnpm db:configure local, or copy .env.local from the checkout that created this container.`,
    );
}
