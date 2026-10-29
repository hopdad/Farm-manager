# ADR 0001: Local database image is `supabase/postgres:17.11.0.008`

- Status: accepted
- Date: Oct 28, 2026
- Context: build plan §1 (local stack vs. production), §2 (setup and fallback), §6 (M0 day-1 spike)

## Decision

The local database is Supabase's own Postgres build, `supabase/postgres:17.11.0.008`, run by
`docker-compose.yml` on `127.0.0.1:${DB_PORT:-15432}` with a named `pgdata` volume. Migrations run as
`postgres` (NOSUPERUSER, as on hosted Supabase); the app connects as `farm_app`. The image is re-pinned
to the hosted project's version at milestone MD, and `pnpm db:parity` must then show zero drift.

## Why

Running the same build as production makes the PostGIS version, the extension set, the `extensions`
schema, the role model (`postgres` is not a superuser) and supautils' privileged-extension rules
identical on the PC and on Supabase, so a migration that works locally works in production and a missing
grant fails on the PC first. The image publishes amd64 and arm64 and preloads pg_cron and pg_net, so
`CLOCK=pgcron` can rehearse Supabase Cron locally.

## Spike result

On **Oct 28, 2026**, in the cloud build container (Linux, Docker 29), `supabase/postgres:17.11.0.008`
passed every check:

| Check | Result |
|---|---|
| `postgres` role flags | NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS |
| `postgres` search_path | `"$user", public, extensions` |
| `realtime.send(jsonb,text,text,boolean)` | absent, so `app.publish` uses `pg_notify('app_events')` locally |
| PostGIS | 3.3.7 (GEOS 3.14.1, PROJ 9.7.1) |
| postgis + btree_gist in `postgres` | creatable `with schema extensions` |
| postgis + btree_gist in a new database | creatable after `create schema extensions` (the image's init creates that schema only in `postgres`) |
| pg_cron + pg_net in `postgres` | creatable (pg_cron can live only in `postgres`: `cron.database_name = postgres`) |
| EPSG 3078 (Michigan GeoRef), 5070 (CONUS Albers), 3857 (web mercator) | present in `extensions.spatial_ref_sys` |
| supautils `privileged_extensions` | includes postgis, btree_gist, pg_cron, pg_net |

The same checks were re-run on Oct 29 against the compose-managed container with `pnpm db:check`
(15 checks, all PASS), which also verifies the `farm_app` role: its search_path includes `extensions`,
it can log in with `DATABASE_URL`, and it sees PostGIS.

**On the Windows PC** `pnpm db:check` (part of `pnpm run bootstrap` later) re-checks all of this and
exits non-zero on any FAIL.

## Consequences

- Migration 1 starts with `create schema if not exists extensions` and installs postgis and btree_gist
  there (never in `public`); on hosted Supabase the schema statement is a no-op.
- pg_cron and pg_net are never in migrations; `pnpm db:configure local` creates them in `postgres` only.
- No superuser-only statements in migrations, ever.
- The `farm_app` role is created NOLOGIN by migrations; its password is set by `db:configure`, never in SQL.
- The `postgres` database is never dropped (`db:reset` drops only the app schemas): its Supabase init
  objects can't be rebuilt by the `postgres` role. `pnpm db:nuke` recreates the volume instead.

## Fallback (if `db:check` fails on the PC)

Plan §2: `imresamu/postgis:17-3.5-alpine3.23` + `pnpm db:parity-init` (extensions schema, search_path,
the Supabase roles and `farm_app`), and `pnpm db:lint` rejects PostGIS functions newer than 3.3. That image
has no pg_cron or pg_net, so only the croner clock is available.
