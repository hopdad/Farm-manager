/**
 * drizzle-kit configuration. `pnpm db:migrate` runs `drizzle-kit migrate` with this file;
 * the URL is DATABASE_URL_MIGRATE (the postgres role), loaded from .env.local by src/config.ts.
 *
 * db/migrations holds hand-written custom SQL migrations (plan §4): schemas, roles, functions,
 * triggers, EXCLUDE constraints and GiST/BRIN indexes live there. The meta/ snapshots mirror
 * src/db/schema so a future `pnpm db:generate` only emits real changes.
 */
import { defineConfig } from 'drizzle-kit';
import { tryGetMigrateUrl } from './src/config';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './db/migrations',
  dbCredentials: {
    // generate/check don't connect; a fresh clone without .env.local must still load this file.
    url: tryGetMigrateUrl() ?? 'postgres://postgres@127.0.0.1:15432/postgres',
  },
  schemaFilter: ['farm', 'gis', 'ingest', 'app'],
  extensionsFilters: ['postgis'],
  migrations: { table: '__drizzle_migrations', schema: 'drizzle' },
  strict: true,
  verbose: true,
});
