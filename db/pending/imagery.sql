-- Imagery builder (M1 1d): extra schema for the private parcels layer. Idempotent.
--
-- Owner names only for managers and owners (task 1d, D8 roles): `app.mvt_parcels(z, x, y)` from
-- 0003 always carries owner_name / owner_mailing, so every signed-in viewer (a shared wall or
-- cab iPad, a driver's phone) would get them in the tiles. This overload takes the decision as a
-- parameter: with_owners = false leaves both properties out (everything else is identical).
--
-- The tiles route (integrator-owned, src/app/api/tiles/**) calls
--   select app.mvt_parcels($1, $2, $3, $4) as mvt      -- $4 = roleAtLeast(session.role, 'manager')
-- and adds the variant to the tile URL's version (e.g. `?v=<version>.o` for managers), so a
-- browser that cached owner tiles for a manager never shows them to the next viewer on that
-- device. src/db/queries/parcels.ts has the helpers (parcelTileSql, PARCEL_OWNERS_MIN_ROLE).
--
-- The 3-argument function stays as 0003 defined it (its DB test checks the owner fields).

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

comment on function app.mvt_parcels(integer, integer, integer, boolean) is
  'MVT tile of parcels, layer ''parcels'' (id, county_fips, parcel_no, acres; owner_name and owner_mailing only when with_owners); empty below z12. PRIVATE.';

revoke all on function app.mvt_parcels(integer, integer, integer, boolean) from public;
grant execute on function app.mvt_parcels(integer, integer, integer, boolean) to farm_app;
