/**
 * Vitest globalSetup for the `db` project: make sure farm_test_template exists and matches the
 * current migrations (rebuilding it if not), and that farm_app can log in.
 */
import { getConfig } from '../config';
import {
  farmAppCanLogin,
  refreshTestTemplate,
  setFarmAppLogin,
  testTemplateIsCurrent,
  withAdmin,
} from '../db/admin';

export default async function setup(): Promise<void> {
  const cfg = getConfig();
  await withAdmin(async (admin) => {
    if (!(await testTemplateIsCurrent(admin))) {
      console.log('[test:db] farm_test_template missing or stale: rebuilding');
      await refreshTestTemplate(admin, (m) => console.log(`[test:db] ${m}`));
    }
    const err = await farmAppCanLogin(cfg.DATABASE_URL);
    if (err) {
      if (!cfg.FARM_APP_PASSWORD)
        throw new Error(`farm_app cannot log in (${err}); run pnpm env:init`);
      console.log('[test:db] farm_app cannot log in yet: applying db:configure login');
      await setFarmAppLogin(admin, cfg.FARM_APP_PASSWORD);
    }
  });
}
