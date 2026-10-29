-- M0 migration 1 of 3: extensions, app schemas and the farm_app role (plan §4).
--
-- Runs as `postgres`, which is NOSUPERUSER on hosted Supabase and on the local
-- supabase/postgres image; supautils lets it create postgis and btree_gist. So: no
-- superuser-only statements here, ever. pg_cron and pg_net are NOT created in migrations;
-- `pnpm db:configure` creates them in the `postgres` database only.

-- The image's init scripts create `extensions` only in the `postgres` database, so a brand-new
-- database (farm_test_template, CI, db:lint) lacks it. On hosted Supabase this is a no-op.
create schema if not exists extensions;
--> statement-breakpoint
-- Extensions live in `extensions`, never in `public`.
create extension if not exists postgis with schema extensions;
--> statement-breakpoint
create extension if not exists btree_gist with schema extensions;
--> statement-breakpoint
create schema if not exists farm;
--> statement-breakpoint
create schema if not exists gis;
--> statement-breakpoint
create schema if not exists ingest;
--> statement-breakpoint
create schema if not exists app;
--> statement-breakpoint
comment on schema farm is 'The operation: parties, farms, fields, boundaries, machines, positions, geofences.';
--> statement-breakpoint
comment on schema gis is 'Public reference data: soils, CDL, CSB, parcels, terrain, map layers.';
--> statement-breakpoint
comment on schema ingest is 'Sync plumbing: external refs, sync state and leases, job runs, raw events, OAuth tokens.';
--> statement-breakpoint
comment on schema app is 'Runtime settings, realtime sequence numbers and shared SQL functions.';
--> statement-breakpoint
-- farm_app: a NOLOGIN group role. Roles are cluster-wide, so this must be idempotent and must
-- not fail when two databases on a fresh cluster migrate at once (parallel CI jobs, agents). `pnpm db:configure` turns on LOGIN and sets the password
-- (locally from .env.local; in production by hand). Never put a password in a migration.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'farm_app') then
    begin
      create role farm_app nologin;
    exception when duplicate_object or unique_violation then
      null; -- created concurrently by another database's migration
    end;
  end if;
end
$$;
--> statement-breakpoint
-- PostGIS lives in `extensions`, so farm_app's search_path must include it (same as postgres's).
-- Written only when missing. pg_db_role_setting is a shared catalog: when two databases on a
-- fresh cluster migrate at once, both see no setting (the other's write is uncommitted) and
-- the loser's ALTER ROLE fails with a unique violation or "tuple concurrently updated"
-- (internal_error). The winner wrote the same value, so the loser can ignore it.
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_db_role_setting s
      join pg_catalog.pg_roles r on r.oid = s.setrole
     where r.rolname = 'farm_app'
       and s.setdatabase = 0
       and 'search_path="$user", public, extensions' = any (s.setconfig)
  ) then
    begin
      alter role farm_app set search_path = "$user", public, extensions;
    exception when unique_violation or internal_error then
      null; -- set concurrently by another database's migration (same value)
    end;
  end if;
end
$$;
--> statement-breakpoint
grant usage on schema extensions to farm_app;
--> statement-breakpoint
grant usage on schema farm, gis, ingest, app to farm_app;
--> statement-breakpoint
-- Every table, view, sequence and app function created later by postgres (these migrations and
-- all future ones) is usable by farm_app. farm_app gets no CREATE anywhere.
alter default privileges in schema farm, gis, ingest, app
  grant select, insert, update, delete on tables to farm_app;
--> statement-breakpoint
alter default privileges in schema farm, gis, ingest, app
  grant usage, select, update on sequences to farm_app;
--> statement-breakpoint
alter default privileges in schema app
  grant execute on functions to farm_app;
