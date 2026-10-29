-- M1 review fixes. Same rules as 0000-0004: runs as `postgres` (NOSUPERUSER on Supabase and
-- locally), no extensions, no pg_cron/pg_net, no passwords, every statement re-runnable.
--
--   1a  app.mvt_fields gains a second layer, 'fields_label': one point per field
--       (ST_PointOnSurface of its current boundary) with id, name, acres and client. The map
--       labelled the tile-clipped polygons of layer 'fields', so a field that crossed tile edges
--       got its name once per tile ("Gilchrist 80 74.4 ac" four times at z14); a point is one
--       label, and MapLibre drops the copy a neighbouring tile carries in its buffer. Layer
--       'fields' is unchanged.

create or replace function app.mvt_fields(z integer, x integer, y integer)
returns bytea
language sql
stable
parallel safe
set search_path = extensions, pg_catalog, pg_temp
as $$
  with env as (
    select ST_TileEnvelope(z, x, y) as tile,
           ST_Transform(ST_TileEnvelope(z, x, y, margin => 64.0 / 4096), 4326) as query_box
  ),
  cur as (
    select b.geom, b.acres, f.id, f.name, f.tenure, f.farm_id,
           fa.client_party_id, cp.display_name as client
      from farm.current_boundaries b
      join farm.fields f on f.id = b.field_id
      join farm.farms fa on fa.id = f.farm_id
      left join farm.parties cp on cp.id = fa.client_party_id
     cross join env
     where b.geom && env.query_box
       and f.active
  ),
  feats as (
    select ST_AsMVTGeom(ST_Transform(cur.geom, 3857), env.tile, 4096, 64, true) as geom,
           cur.id::text as id,
           cur.name as name,
           round(cur.acres, 1)::double precision as acres,
           cur.tenure as tenure,
           cur.farm_id::text as farm_id,
           cur.client_party_id::text as client_id,
           cur.client as client
      from cur cross join env
  ),
  labels as (
    select ST_AsMVTGeom(ST_Transform(ST_PointOnSurface(cur.geom), 3857), env.tile, 4096, 64, true)
             as geom,
           cur.id::text as id,
           cur.name as name,
           round(cur.acres, 1)::double precision as acres,
           cur.tenure as tenure,
           cur.client as client
      from cur cross join env
  )
  -- Two layers in one tile: MVT layers concatenate.
  select coalesce(
           (select ST_AsMVT(feats.*, 'fields', 4096, 'geom') from feats where feats.geom is not null),
           ''::bytea)
      || coalesce(
           (select ST_AsMVT(labels.*, 'fields_label', 4096, 'geom') from labels
             where labels.geom is not null),
           ''::bytea);
$$;
--> statement-breakpoint
comment on function app.mvt_fields(integer, integer, integer) is
  'MVT tile of current field boundaries: layer ''fields'' (id, name, acres, tenure, farm_id, client_id, client) and layer ''fields_label'', one point per field (id, name, acres, tenure, client).';
