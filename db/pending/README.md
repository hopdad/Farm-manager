# db/pending: SQL waiting to become a migration

Parallel agents may not edit `db/migrations`. If your work needs a schema change, put it in
`db/pending/<agent>.sql` and list it in your stage report; the integration step turns it into a real
drizzle-kit migration (and updates `src/db/schema/*.ts`).

Rules for a pending file:

- **Idempotent**: `create table if not exists`, `create or replace function`, `create index if not exists`,
  `alter table ... add column if not exists`, `do $$ ... $$` guards. It is applied again to every test
  database and on every `pnpm db:pending`.
- Same conventions as the migrations: schemas `farm`, `gis`, `ingest`, `app`; uuid PKs; `timestamptz`;
  geometry in EPSG:4326 with a GiST index; `source` + `source_id` unique for outside-source rows; grants
  come from the default privileges (no explicit `grant` needed for new tables or app functions).
- No superuser-only statements, no `create extension`, no passwords, no pg_cron/pg_net.

How it is applied:

- **Tests**: `src/test/db.ts` applies every `db/pending/*.sql` (name order, one transaction each) to each
  per-file test database right after cloning `farm_test_template`.
- **Your dev database**: `pnpm db:pending` applies them as `postgres` to the database in
  `DATABASE_URL_MIGRATE`.
