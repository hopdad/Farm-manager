import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Three projects:
 *  - unit: pure tests, no database (`pnpm test`).
 *  - db:   *.db.test.ts against the real supabase/postgres container (`pnpm test:db`). Each file
 *          gets its own database cloned from the test template, farm_tpl_<migrations hash> (src/test/db.ts); the global
 *          setup (re)builds the template when migrations changed.
 *  - live: *.live.test.ts, the connector contract suites against a vendor's sandbox or live API
 *          (`pnpm test:live`, plan §5/§7; slice 1f). By hand only, never in CI: they need real
 *          credentials and reach the vendor. They read config like the app (src/config.ts).
 */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    env: { APP_ENV: 'test' },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          // The Windows CI runner is several times slower under the full parallel suite; tests
          // that start servers or child processes went past the 5 s default there.
          testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'tools/**/*.test.ts'],
          exclude: ['**/*.db.test.ts', '**/*.live.test.ts', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          environment: 'node',
          include: [
            'src/**/*.db.test.ts',
            'db/**/*.db.test.ts',
            'scripts/**/*.db.test.ts',
            'tools/**/*.db.test.ts',
          ],
          globalSetup: ['./src/test/global-setup.db.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'live',
          environment: 'node',
          include: [
            'src/**/*.live.test.ts',
            'scripts/**/*.live.test.ts',
            'tools/**/*.live.test.ts',
          ],
          // Real vendors are slow and rate-limited: one file at a time, generous timeouts.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
