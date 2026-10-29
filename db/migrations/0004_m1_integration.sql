-- M1 integration: the schema the M1 builders parked in db/pending (docs/contracts-m1.md §2),
-- folded into one migration. Same rules as 0000-0003: runs as `postgres` (NOSUPERUSER on
-- Supabase and locally), no extensions, no pg_cron/pg_net, no passwords, and every statement is
-- re-runnable (`if not exists`, `create or replace`), so a dev database that already had the
-- pending files applied (`pnpm db:pending`) converges instead of failing.
--
--   1b  index farm.spray_assessments (grid_id, forecast_issued_at, for_hour) for the weather.nws
--       job's forecast retention (was db/pending/weather.sql)
--   1d  app.mvt_parcels(z, x, y, with_owners): the parcels tile with owner names only for
--       managers and up (was db/pending/imagery.sql)

-- ============================================================================================
-- 1b: forecast retention index
-- ============================================================================================

-- Pruning deletes farm.weather_forecasts rows of old issues EXCEPT those a stored assessment
-- used:
--   not exists (select 1 from farm.spray_assessments s
--                where s.grid_id = f.grid_id and s.forecast_issued_at = f.issued_at
--                  and s.for_hour = f.valid_at)
-- Without this index the anti-join sorts every assessment (about 4.5 million rows at 500 fields
-- and 30 days of detail) for each 5 000-row batch; with it each candidate row is one index-only
-- probe. EXPLAIN ANALYZE on a 500-field fixture (475k assessments, 200k forecast rows): 26 ms
-- (nested loop anti join, index only scan) with it, 341 ms plus an 18 MB on-disk sort without.
-- Mirrored in src/db/schema/farm.ts (sprayAssessments).
create index if not exists spray_assessments_grid_id_forecast_issued_at_for_hour_idx
  on farm.spray_assessments using btree (grid_id, forecast_issued_at, for_hour);
--> statement-breakpoint

-- ============================================================================================
-- 1d: parcel tiles with or without owner names
-- ============================================================================================

-- 0003's app.mvt_parcels(z, x, y) always carries owner_name / owner_mailing. This overload takes
-- the decision as a parameter: with_owners = false leaves both properties out, everything else
-- is identical. The tiles route passes roleAtLeast(session.role, PARCEL_OWNERS_MIN_ROLE)
-- (src/db/queries/parcels-access.ts, D8: manager and up) and puts the variant into the tile
-- URL's version (`?v=<version>.o` for owner tiles), so a shared browser that cached owner tiles
-- for a manager never shows them to the next person. The 3-argument function stays as 0003
-- defined it.
create or replace function app.mvt_parcels(z integer, x integer, y integer, with_owners boolean)
returns bytea
language sql
stable
parallel safe
set search_path = extensions, pg_catalog, pg_temp
as $$
  with env as (
    select ST_TileEnvelope(z, x, y) as tile,
           ST_Transform(ST_TileEnvelope(z, x, y, margin => 64.0 / 4096), 4326) as query_box
     where z >= 12
  ),
  feats as (
    select ST_AsMVTGeom(ST_Transform(p.geom, 3857), env.tile, 4096, 64, true) as geom,
           p.id::text as id,
           p.county_fips as county_fips,
           p.parcel_no as parcel_no,
           case when with_owners then p.owner_name end as owner_name,
           case when with_owners then p.owner_mailing end as owner_mailing,
           round(coalesce(p.acres, p.gis_acres), 1)::double precision as acres
      from gis.parcels p
     cross join env
     where p.geom && env.query_box
  )
  select coalesce(
    (select ST_AsMVT(feats.*, 'parcels', 4096, 'geom') from feats where feats.geom is not null),
    ''::bytea
  );
$$;
--> statement-breakpoint
comment on function app.mvt_parcels(integer, integer, integer, boolean) is
  'MVT tile of parcels, layer ''parcels'' (id, county_fips, parcel_no, acres; owner_name and owner_mailing only when with_owners); empty below z12. PRIVATE.';
--> statement-breakpoint
revoke all on function app.mvt_parcels(integer, integer, integer, boolean) from public;
--> statement-breakpoint
grant execute on function app.mvt_parcels(integer, integer, integer, boolean) to farm_app;
