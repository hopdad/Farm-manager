import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Two projects:
 *  - unit: pure tests, no database (`pnpm test`).
 *  - db:   *.db.test.ts against the real supabase/postgres container (`pnpm test:db`). Each file
 *          gets its own database cloned from farm_test_template (src/test/db.ts); the global
 *          setup (re)builds the template when migrations changed.
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
          exclude: ['**/*.db.test.ts', '**/node_modules/**'],
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
    ],
  },
});
