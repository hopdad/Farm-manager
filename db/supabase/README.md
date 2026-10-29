# db/supabase: production-only SQL

Objects that exist only on hosted Supabase (plan §4 "Keeping migrations identical", rule 5) and are
applied by `pnpm db:configure prod` at milestone MD, never by migrations:

- `cron.sql`: **generated** by `pnpm jobs:emit-cron` from `src/jobs/registry.ts` (do not edit; not
  committed until MD, since the registry is still growing). One named `cron.schedule` per job that
  POSTs `<base>/api/jobs/<name>` through `net.http_post` with the bearer secret and
  `timeout_milliseconds := 5000`; `host: 'pc'` jobs are skipped. The base URL and `JOBS_SECRET` are
  read from Vault at run time (`farm_jobs_base_url`, `farm_jobs_secret`), never written into the file.
  `pnpm jobs:emit-cron --check` fails when the file is out of date.
- Later (MD): `realtime.messages` RLS policies for the private Broadcast channels, Vault secrets.

Rehearsing locally (`CLOCK=pgcron`): pg_cron and pg_net live in the `postgres` database of the local
container (`pnpm db:configure local` creates them). Create the two Vault secrets there (base URL
`http://host.docker.internal:3000`), apply `cron.sql` as `postgres`, and run `pnpm dev`: with
`CLOCK=pgcron` it does not start tools/clock.
