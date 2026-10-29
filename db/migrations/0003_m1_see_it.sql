-- M1 "See it" (slices 1a-1d): every table, column and SQL function the parallel M1 builders
-- need, in one migration (plan §4, docs/contracts-m1.md §3). Mirrored by src/db/schema/*.ts;
-- constraint and index names follow drizzle-kit's conventions, like 0001.
--
-- Same rules as M0: runs as `postgres` (NOSUPERUSER on Supabase and locally), no extensions,
-- no pg_cron/pg_net, no passwords. Re-runnable: every statement is `if not exists`,
-- `create or replace` or guarded, so applying it to a database that already has part of it
-- (a builder's db/pending SQL, a half-finished manual run) converges instead of failing.
--
--   1a  farm.app_users, farm.devices, farm.geofence_visits; machines.down_at/down_by;
--       fields.notes_updated_at/notes_updated_by
--   1b  farm.weather_grids, farm.field_weather_grids, farm.weather_forecasts,
--       farm.weather_observations, farm.soil_temp_readings, farm.spray_assessments
--   1c  farm.field_lineage, farm.boundary_change_requests, gis.soil_mapunits,
--       gis.soil_polygons, gis.field_soils + gis.rebuild_field_soils() (trigger on every new
--       boundary version)
--   1d  farm.tile_lines, gis.parcel_imports, gis.parcels, gis.map_layers (+ rows for the MVT
--       layers), app.mvt_soils, app.mvt_parcels, app.mvt_tile_lines; app.mvt_fields gains the
--       custom-work client (client_id, client)

-- ============================================================================================
-- 1a: people, devices, machines down, geofence visits, field notes
-- ============================================================================================

-- A person who can sign in. auth_user_id links the Supabase Auth user at the first verified
-- sign-in in production (MD), so no primary key ever changes. pin_hash is the operator PIN
-- (scrypt, format owned by src/platform/auth), checked the same way in both environments.
create table if not exists farm.app_users (
  id uuid primary key default gen_random_uuid() not null,
  party_id uuid not null,
  role text not null,
  auth_user_id uuid,
  pin_hash text,
  pin_set_at timestamp with time zone,
  failed_pins integer default 0 not null,
  locked_until timestamp with time zone,
  session_epoch integer default 0 not null,
  active boolean default true not null,
  last_sign_in_at timestamp with time zone,
  source text default 'app' not null,
  source_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint app_users_party_id_key unique (party_id),
  constraint app_users_auth_user_id_key unique (auth_user_id),
  constraint app_users_source_source_id_key unique (source, source_id),
  constraint app_users_role_check check (role in ('viewer', 'driver', 'operator', 'manager', 'owner')),
  constraint app_users_failed_pins_check check (failed_pins >= 0),
  constraint app_users_session_epoch_check check (session_epoch >= 0)
);
--> statement-breakpoint
-- An enrolled screen. Shared devices (wall, cab/truck iPads) carry a device session plus an
-- operator PIN layer; a phone is personal (app_user_id). auth_user_id is the production device
-- login (MD). Local enrollment: an admin issues a one-time code (only its hash is stored, with
-- an expiry); redeeming it sets enrolled_at and the device cookie. Bumping session_epoch or
-- setting revoked_at invalidates every cookie the device holds.
create table if not exists farm.devices (
  id uuid primary key default gen_random_uuid() not null,
  kind text not null,
  name text not null,
  role text default 'viewer' not null,
  app_user_id uuid,
  auth_user_id uuid,
  enroll_code_hash text,
  enroll_expires_at timestamp with time zone,
  enrolled_at timestamp with time zone,
  session_epoch integer default 0 not null,
  last_seen_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_by uuid,
  source text default 'app' not null,
  source_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint devices_auth_user_id_key unique (auth_user_id),
  constraint devices_source_source_id_key unique (source, source_id),
  constraint devices_kind_check check (kind in ('wall', 'cab_ipad', 'truck_ipad', 'phone')),
  -- A device on its own is never a manager or owner: those need a person.
  constraint devices_role_check check (role in ('viewer', 'driver', 'operator')),
  constraint devices_session_epoch_check check (session_epoch >= 0)
);
--> statement-breakpoint
create unique index if not exists devices_enroll_code_hash_key on farm.devices using btree (enroll_code_hash)
  where enroll_code_hash is not null;
--> statement-breakpoint
-- Machines marked down from a phone (1a): when and by whom (status/down_reason exist since M0).
alter table farm.machines
  add column if not exists down_at timestamp with time zone,
  add column if not exists down_by uuid;
--> statement-breakpoint
-- Field notes edited from the panel: who and when (notes exists since M0).
alter table farm.fields
  add column if not exists notes_updated_at timestamp with time zone,
  add column if not exists notes_updated_by uuid;
--> statement-breakpoint
-- Geofence enter/exit, computed in PostGIS from positions inside the positions job (plan §5:
-- switching ELD vendors doesn't touch it). At most one open visit per machine and geofence.
create table if not exists farm.geofence_visits (
  id uuid primary key default gen_random_uuid() not null,
  machine_id uuid not null,
  geofence_id uuid not null,
  entered_at timestamp with time zone not null,
  exited_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint geofence_visits_machine_id_geofence_id_entered_at_key unique (machine_id, geofence_id, entered_at),
  constraint geofence_visits_exit_after_entry_check check (exited_at is null or exited_at >= entered_at)
);
--> statement-breakpoint
create unique index if not exists geofence_visits_open_key on farm.geofence_visits using btree (machine_id, geofence_id)
  where exited_at is null;
--> statement-breakpoint
create index if not exists geofence_visits_geofence_id_entered_at_idx on farm.geofence_visits using btree (geofence_id, entered_at desc nulls last);
--> statement-breakpoint

-- ============================================================================================
-- 1b: weather and spray go/no-go
-- ============================================================================================

-- NWS forecast grid cells, cached (plan 1b "per-field grid lookup (cached)"). id is
-- '<WFO>/<gridX>,<gridY>' like the /gridpoints/{wfo}/{x},{y} path; stations nearest first.
create table if not exists farm.weather_grids (
  id text primary key not null,
  wfo text not null,
  grid_x integer not null,
  grid_y integer not null,
  stations jsonb default '[]'::jsonb not null,
  geom extensions.geometry(Polygon, 4326),
  time_zone text,
  looked_up_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint weather_grids_wfo_grid_x_grid_y_key unique (wfo, grid_x, grid_y),
  constraint weather_grids_id_check check (id = wfo || '/' || grid_x || ',' || grid_y)
);
--> statement-breakpoint
-- Which grid cell a field's weather comes from (looked up once from a point inside its
-- current boundary; redone when the boundary moves).
create table if not exists farm.field_weather_grids (
  field_id uuid primary key not null,
  grid_id text not null,
  point extensions.geometry(Point, 4326) not null,
  looked_up_at timestamp with time zone default now() not null
);
--> statement-breakpoint
-- Hourly forecast per grid cell and NWS issue (updateTime), kept per issue so every spray
-- assessment can name the forecast it used. valid_at is the start of the hour (UTC).
create table if not exists farm.weather_forecasts (
  grid_id text not null,
  issued_at timestamp with time zone not null,
  valid_at timestamp with time zone not null,
  temp_f double precision,
  dewpoint_f double precision,
  rh_pct double precision,
  wind_mph double precision,
  gust_mph double precision,
  wind_dir double precision,
  pop_pct double precision,
  qpf_in double precision,
  sky_pct double precision,
  mixing_height_ft double precision,
  transport_wind_mph double precision,
  source text default 'nws' not null,
  fetched_at timestamp with time zone default now() not null,
  constraint weather_forecasts_pkey primary key (grid_id, issued_at, valid_at),
  constraint weather_forecasts_wind_dir_check check (wind_dir is null or (wind_dir >= 0 and wind_dir <= 360)),
  constraint weather_forecasts_pct_check check (
    (pop_pct is null or pop_pct between 0 and 100) and (sky_pct is null or sky_pct between 0 and 100)
    and (rh_pct is null or rh_pct between 0 and 100)
  )
);
--> statement-breakpoint
create index if not exists weather_forecasts_grid_id_valid_at_idx on farm.weather_forecasts using btree (grid_id, valid_at, issued_at desc nulls last);
--> statement-breakpoint
-- Station observations (latest per station near the fields), with the station's location.
create table if not exists farm.weather_observations (
  station_id text not null,
  observed_at timestamp with time zone not null,
  geom extensions.geometry(Point, 4326),
  temp_f double precision,
  dewpoint_f double precision,
  rh_pct double precision,
  wind_mph double precision,
  gust_mph double precision,
  wind_dir double precision,
  precip_last_hour_in double precision,
  source text default 'nws' not null,
  fetched_at timestamp with time zone default now() not null,
  constraint weather_observations_pkey primary key (station_id, observed_at),
  constraint weather_observations_wind_dir_check check (wind_dir is null or (wind_dir >= 0 and wind_dir <= 360))
);
--> statement-breakpoint
-- Soil temperature: manual probe readings from a phone first (1b), shown with their age; D5's
-- source later (2b). field_id null = a reading not tied to one field.
create table if not exists farm.soil_temp_readings (
  id uuid primary key default gen_random_uuid() not null,
  field_id uuid,
  observed_at timestamp with time zone not null,
  depth_in double precision default 2 not null,
  temp_f double precision not null,
  source text default 'manual' not null,
  source_id text,
  geom extensions.geometry(Point, 4326),
  entered_by uuid,
  device_id uuid,
  note text,
  created_at timestamp with time zone default now() not null,
  constraint soil_temp_readings_source_source_id_key unique (source, source_id),
  constraint soil_temp_readings_source_check check (source in ('manual', 'station', 'probe')),
  constraint soil_temp_readings_depth_in_check check (depth_in > 0 and depth_in <= 72),
  constraint soil_temp_readings_temp_f_check check (temp_f between -40 and 140)
);
--> statement-breakpoint
create index if not exists soil_temp_readings_field_id_observed_at_idx on farm.soil_temp_readings using btree (field_id, observed_at desc nulls last);
--> statement-breakpoint
-- Every go/no-go call, with its reasons, inputs, rule version and the forecast issue it used
-- (an audit trail). Advisory (D4). A re-run with the same field, hour, rules and forecast is a
-- no-op (unique, nulls not distinct).
create table if not exists farm.spray_assessments (
  id uuid primary key default gen_random_uuid() not null,
  field_id uuid not null,
  for_hour timestamp with time zone not null,
  verdict text not null,
  reasons jsonb default '[]'::jsonb not null,
  inputs jsonb default '{}'::jsonb not null,
  rules_version text not null,
  forecast_issued_at timestamp with time zone,
  grid_id text,
  assessed_at timestamp with time zone default now() not null,
  constraint spray_assessments_run_key unique nulls not distinct (field_id, for_hour, rules_version, forecast_issued_at),
  constraint spray_assessments_verdict_check check (verdict in ('go', 'caution', 'no_go')),
  constraint spray_assessments_for_hour_check check (mod(extract(epoch from for_hour)::numeric, 3600) = 0)
);
--> statement-breakpoint
create index if not exists spray_assessments_field_id_for_hour_idx on farm.spray_assessments using btree (field_id, for_hour desc nulls last, assessed_at desc nulls last);
--> statement-breakpoint

-- ============================================================================================
-- 1c: field lineage and soils
-- ============================================================================================

-- Splits and merges, so 5-season history follows a field through boundary edits.
create table if not exists farm.field_lineage (
  id uuid primary key default gen_random_uuid() not null,
  parent_field_id uuid not null,
  child_field_id uuid not null,
  kind text not null,
  effective_on date not null,
  note text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  constraint field_lineage_parent_field_id_child_field_id_key unique (parent_field_id, child_field_id),
  constraint field_lineage_kind_check check (kind in ('split', 'merge')),
  constraint field_lineage_not_self_check check (parent_field_id <> child_field_id)
);
--> statement-breakpoint
create index if not exists field_lineage_child_field_id_idx on farm.field_lineage using btree (child_field_id);
--> statement-breakpoint
-- Deere is the boundary master for every field with a deere_field_id (D6): an attempted edit
-- of such a boundary is kept here as a "change this in Ops Center" note, with the shape the
-- person drew, until someone makes the change in Operations Center and resolves it.
create table if not exists farm.boundary_change_requests (
  id uuid primary key default gen_random_uuid() not null,
  field_id uuid not null,
  proposed_geom extensions.geometry(MultiPolygon, 4326),
  note text not null,
  requested_by uuid,
  requested_at timestamp with time zone default now() not null,
  resolved_at timestamp with time zone,
  resolved_by uuid,
  resolution text,
  constraint boundary_change_requests_resolution_check check (
    (resolved_at is null) = (resolution is null)
  )
);
--> statement-breakpoint
create index if not exists boundary_change_requests_open_idx on farm.boundary_change_requests using btree (field_id)
  where resolved_at is null;
--> statement-breakpoint
-- SSURGO map units (one row per mukey), with the dominant component's attributes and the
-- component-percent-weighted NCCPI (0-1) from SDA cointerp (plan §5).
create table if not exists gis.soil_mapunits (
  mukey text primary key not null,
  areasymbol text not null,
  musym text,
  muname text not null,
  dominant_component text,
  drainage_class text,
  hydgrp text,
  farmland_class text,
  nccpi double precision,
  components jsonb default '[]'::jsonb not null,
  survey_version text,
  loaded_at timestamp with time zone default now() not null,
  constraint soil_mapunits_nccpi_check check (nccpi is null or (nccpi >= 0 and nccpi <= 1))
);
--> statement-breakpoint
-- SSURGO map unit polygons (county-wide, MI091 Lenawee and MI115 Monroe). source_id is the
-- loader's stable key (SDA mupolygonkey, or areasymbol:mukey:<sha8 of the geometry> for a Web
-- Soil Survey download), so a reload converges. Geometries are valid (ST_MakeValid at load).
create table if not exists gis.soil_polygons (
  id uuid primary key default gen_random_uuid() not null,
  mukey text not null,
  areasymbol text not null,
  geom extensions.geometry(MultiPolygon, 4326) not null,
  source text default 'ssurgo' not null,
  source_id text not null,
  loaded_at timestamp with time zone default now() not null,
  constraint soil_polygons_source_source_id_key unique (source, source_id)
);
--> statement-breakpoint
create index if not exists soil_polygons_mukey_idx on gis.soil_polygons using btree (mukey);
--> statement-breakpoint
-- Soils per boundary version: rebuilt in SQL (gis.rebuild_field_soils) whenever a boundary
-- version is inserted or its geometry changes, so it runs anywhere (plan §4).
create table if not exists gis.field_soils (
  boundary_id uuid not null,
  mukey text not null,
  acres numeric(12, 4) not null,
  pct numeric(7, 4) not null,
  computed_at timestamp with time zone default now() not null,
  constraint field_soils_pkey primary key (boundary_id, mukey),
  constraint field_soils_acres_check check (acres >= 0),
  constraint field_soils_pct_check check (pct >= 0 and pct <= 100)
);
--> statement-breakpoint
create index if not exists field_soils_mukey_idx on gis.field_soils using btree (mukey);
--> statement-breakpoint

-- ============================================================================================
-- 1d: tile lines, parcels, the map layer registry
-- ============================================================================================

-- Drainage tile as-builts: imported (installer drawings traced, Deere tile plow logs) or drawn.
create table if not exists farm.tile_lines (
  id uuid primary key default gen_random_uuid() not null,
  field_id uuid,
  geom extensions.geometry(MultiLineString, 4326) not null,
  kind text default 'lateral' not null,
  size_in numeric(5, 2),
  depth_ft numeric(5, 2),
  installed_on date,
  origin text not null,
  installer text,
  notes text,
  source text default 'app' not null,
  source_id text,
  source_ref text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint tile_lines_source_source_id_key unique (source, source_id),
  constraint tile_lines_kind_check check (kind in ('main', 'submain', 'lateral', 'unknown')),
  constraint tile_lines_origin_check check (origin in ('installer_drawing', 'deere_tile_plow', 'manual')),
  constraint tile_lines_size_in_check check (size_in is null or size_in > 0),
  constraint tile_lines_depth_ft_check check (depth_ft is null or depth_ft > 0)
);
--> statement-breakpoint
create index if not exists tile_lines_field_id_idx on farm.tile_lines using btree (field_id);
--> statement-breakpoint
-- One parcel file as received (county or vendor, D7; the synthetic fixture until one arrives).
create table if not exists gis.parcel_imports (
  id uuid primary key default gen_random_uuid() not null,
  source text not null,
  county_fips text,
  received_on date,
  license_note text default '' not null,
  file_name text,
  sha256 text,
  feature_count integer,
  imported_at timestamp with time zone default now() not null,
  notes text,
  constraint parcel_imports_county_fips_check check (county_fips ~ '^[0-9]{5}$'),
  constraint parcel_imports_sha256_check check (sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
-- Parcels with owners (private: served only through the private parcels MVT). One row per
-- county parcel number; a newer import updates it (import_id names the latest). acres is what
-- the file says; gis_acres is the geodesic area (trigger).
create table if not exists gis.parcels (
  id uuid primary key default gen_random_uuid() not null,
  import_id uuid not null,
  county_fips text not null,
  parcel_no text not null,
  owner_name text,
  owner_mailing text,
  property_address text,
  acres numeric(12, 4),
  gis_acres numeric(12, 4) default 0 not null,
  attrs jsonb default '{}'::jsonb not null,
  geom extensions.geometry(MultiPolygon, 4326) not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint parcels_county_fips_parcel_no_key unique (county_fips, parcel_no),
  constraint parcels_county_fips_check check (county_fips ~ '^[0-9]{5}$')
);
--> statement-breakpoint
create index if not exists parcels_import_id_idx on gis.parcels using btree (import_id);
--> statement-breakpoint
-- The map layer registry (plan §4): what is built and where it lives. How a layer is drawn
-- lives in code (src/ui/map/layers, LayerDef with the same key). kind is the delivery format:
-- pmtiles (url_or_key = a key in the `tiles` bucket), mvt (url_or_key = '/api/tiles/<layer>'),
-- xyz (url_or_key = an online URL template). version null = computed per request (mvt).
create table if not exists gis.map_layers (
  key text primary key not null,
  kind text not null,
  url_or_key text not null,
  version text,
  cache_policy text default 'public' not null,
  minzoom integer default 0 not null,
  maxzoom integer default 22 not null,
  attribution text,
  legend jsonb,
  source_vintage text,
  built_at timestamp with time zone,
  default_visible boolean default false not null,
  meta jsonb default '{}'::jsonb not null,
  updated_at timestamp with time zone default now() not null,
  constraint map_layers_key_check check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  constraint map_layers_kind_check check (kind in ('pmtiles', 'mvt', 'xyz')),
  constraint map_layers_cache_policy_check check (cache_policy in ('public', 'private')),
  constraint map_layers_zoom_check check (minzoom >= 0 and maxzoom <= 24 and minzoom <= maxzoom),
  constraint map_layers_version_check check (version is null or version ~ '^[0-9A-Za-z_.-]{1,64}$')
);
--> statement-breakpoint

-- ============================================================================================
-- Foreign keys (named like drizzle-kit's), added only when missing
-- ============================================================================================

do $$
declare
  fk record;
begin
  for fk in
    select * from (values
      ('farm.app_users', 'app_users_party_id_parties_id_fk',
       'foreign key (party_id) references farm.parties (id) on delete restrict'),
      ('farm.devices', 'devices_app_user_id_app_users_id_fk',
       'foreign key (app_user_id) references farm.app_users (id) on delete set null'),
      ('farm.devices', 'devices_created_by_app_users_id_fk',
       'foreign key (created_by) references farm.app_users (id) on delete set null'),
      ('farm.machines', 'machines_down_by_app_users_id_fk',
       'foreign key (down_by) references farm.app_users (id) on delete set null'),
      ('farm.fields', 'fields_notes_updated_by_app_users_id_fk',
       'foreign key (notes_updated_by) references farm.app_users (id) on delete set null'),
      ('farm.geofence_visits', 'geofence_visits_machine_id_machines_id_fk',
       'foreign key (machine_id) references farm.machines (id) on delete cascade'),
      ('farm.geofence_visits', 'geofence_visits_geofence_id_geofences_id_fk',
       'foreign key (geofence_id) references farm.geofences (id) on delete cascade'),
      ('farm.field_weather_grids', 'field_weather_grids_field_id_fields_id_fk',
       'foreign key (field_id) references farm.fields (id) on delete cascade'),
      ('farm.field_weather_grids', 'field_weather_grids_grid_id_weather_grids_id_fk',
       'foreign key (grid_id) references farm.weather_grids (id) on delete cascade'),
      ('farm.weather_forecasts', 'weather_forecasts_grid_id_weather_grids_id_fk',
       'foreign key (grid_id) references farm.weather_grids (id) on delete cascade'),
      ('farm.soil_temp_readings', 'soil_temp_readings_field_id_fields_id_fk',
       'foreign key (field_id) references farm.fields (id) on delete set null'),
      ('farm.soil_temp_readings', 'soil_temp_readings_entered_by_app_users_id_fk',
       'foreign key (entered_by) references farm.app_users (id) on delete set null'),
      ('farm.soil_temp_readings', 'soil_temp_readings_device_id_devices_id_fk',
       'foreign key (device_id) references farm.devices (id) on delete set null'),
      ('farm.spray_assessments', 'spray_assessments_field_id_fields_id_fk',
       'foreign key (field_id) references farm.fields (id) on delete cascade'),
      ('farm.field_lineage', 'field_lineage_parent_field_id_fields_id_fk',
       'foreign key (parent_field_id) references farm.fields (id) on delete cascade'),
      ('farm.field_lineage', 'field_lineage_child_field_id_fields_id_fk',
       'foreign key (child_field_id) references farm.fields (id) on delete cascade'),
      ('farm.field_lineage', 'field_lineage_created_by_app_users_id_fk',
       'foreign key (created_by) references farm.app_users (id) on delete set null'),
      ('farm.boundary_change_requests', 'boundary_change_requests_field_id_fields_id_fk',
       'foreign key (field_id) references farm.fields (id) on delete cascade'),
      ('farm.boundary_change_requests', 'boundary_change_requests_requested_by_app_users_id_fk',
       'foreign key (requested_by) references farm.app_users (id) on delete set null'),
      ('farm.boundary_change_requests', 'boundary_change_requests_resolved_by_app_users_id_fk',
       'foreign key (resolved_by) references farm.app_users (id) on delete set null'),
      ('gis.soil_polygons', 'soil_polygons_mukey_soil_mapunits_mukey_fk',
       'foreign key (mukey) references gis.soil_mapunits (mukey) on delete cascade'),
      ('gis.field_soils', 'field_soils_boundary_id_field_boundaries_id_fk',
       'foreign key (boundary_id) references farm.field_boundaries (id) on delete cascade'),
      ('gis.field_soils', 'field_soils_mukey_soil_mapunits_mukey_fk',
       'foreign key (mukey) references gis.soil_mapunits (mukey) on delete cascade'),
      ('farm.tile_lines', 'tile_lines_field_id_fields_id_fk',
       'foreign key (field_id) references farm.fields (id) on delete set null'),
      ('farm.tile_lines', 'tile_lines_created_by_app_users_id_fk',
       'foreign key (created_by) references farm.app_users (id) on delete set null'),
      ('gis.parcels', 'parcels_import_id_parcel_imports_id_fk',
       'foreign key (import_id) references gis.parcel_imports (id) on delete cascade')
    ) as t(tbl, name, def)
  loop
    if not exists (
      select 1 from pg_catalog.pg_constraint c
       where c.conname = fk.name and c.conrelid = fk.tbl::regclass
    ) then
      execute format('alter table %s add constraint %I %s', fk.tbl, fk.name, fk.def);
    end if;
  end loop;
end
$$;
--> statement-breakpoint

-- ============================================================================================
-- GiST on every new geometry column
-- ============================================================================================

create index if not exists boundary_change_requests_proposed_geom_gist on farm.boundary_change_requests using gist (proposed_geom);
--> statement-breakpoint
create index if not exists weather_grids_geom_gist on farm.weather_grids using gist (geom);
--> statement-breakpoint
create index if not exists field_weather_grids_point_gist on farm.field_weather_grids using gist (point);
--> statement-breakpoint
create index if not exists weather_observations_geom_gist on farm.weather_observations using gist (geom);
--> statement-breakpoint
create index if not exists soil_temp_readings_geom_gist on farm.soil_temp_readings using gist (geom);
--> statement-breakpoint
create index if not exists soil_polygons_geom_gist on gis.soil_polygons using gist (geom);
--> statement-breakpoint
create index if not exists tile_lines_geom_gist on farm.tile_lines using gist (geom);
--> statement-breakpoint
create index if not exists parcels_geom_gist on gis.parcels using gist (geom);
--> statement-breakpoint

-- ============================================================================================
-- Field soils: rebuilt per boundary version, in SQL
-- ============================================================================================

-- Rebuild gis.field_soils for one boundary version: the boundary intersected with every soil
-- polygon, geodesic acres per mukey, pct of the boundary's area. Returns the number of map
-- units written. A GEOS failure on a broken geometry leaves the boundary without soils and
-- raises a WARNING instead of failing the boundary write that triggered it.
create or replace function gis.rebuild_field_soils(p_boundary_id uuid)
returns integer
language plpgsql
volatile
set search_path = extensions, pg_catalog, pg_temp
as $$
declare
  n integer := 0;
begin
  delete from gis.field_soils where boundary_id = p_boundary_id;
  begin
    with b as (
      select fb.id, ST_MakeValid(fb.geom) as geom, ST_Area(fb.geom::geography) as m2
        from farm.field_boundaries fb
       where fb.id = p_boundary_id
    ),
    pieces as (
      select p.mukey,
             ST_Area(ST_CollectionExtract(ST_Intersection(b.geom, p.geom), 3)::geography) as m2
        from b
        join gis.soil_polygons p on p.geom && b.geom and ST_Intersects(p.geom, b.geom)
    ),
    per_unit as (
      select mukey, sum(m2) as m2 from pieces group by mukey having sum(m2) > 0
    )
    insert into gis.field_soils (boundary_id, mukey, acres, pct)
    select b.id,
           u.mukey,
           round((u.m2 / 4046.86)::numeric, 4),
           round(least(100.0, 100.0 * u.m2 / nullif(b.m2, 0))::numeric, 4)
      from per_unit u
     cross join b
     where b.m2 > 0;
    get diagnostics n = row_count;
  exception when internal_error then
    raise warning 'gis.rebuild_field_soils(%): % (boundary left without soils)', p_boundary_id, sqlerrm;
    n := 0;
  end;
  return n;
end
$$;
--> statement-breakpoint
-- After a soils (re)load: rebuild every boundary version. Returns the rows written.
create or replace function gis.rebuild_all_field_soils()
returns integer
language plpgsql
volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  b record;
  total integer := 0;
begin
  for b in select id from farm.field_boundaries order by id loop
    total := total + gis.rebuild_field_soils(b.id);
  end loop;
  return total;
end
$$;
--> statement-breakpoint
create or replace function gis.field_boundaries_rebuild_soils() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  perform gis.rebuild_field_soils(new.id);
  return null;
end
$$;
--> statement-breakpoint
-- A new boundary version (or a changed geometry) gets its soils immediately (plan §5 "Derived
-- stats for new boundaries"). Closing a version (updating `valid`) doesn't touch them.
create or replace trigger field_boundaries_rebuild_soils
  after insert or update of geom on farm.field_boundaries
  for each row execute function gis.field_boundaries_rebuild_soils();
--> statement-breakpoint

-- ============================================================================================
-- Parcel acreage trigger (geodesic, like farm.field_boundaries.acres)
-- ============================================================================================

create or replace function gis.parcels_set_gis_acres() returns trigger
language plpgsql
set search_path = extensions, pg_catalog, pg_temp
as $$
begin
  new.gis_acres := round((ST_Area(new.geom::geography) / 4046.86)::numeric, 4);
  return new;
end
$$;
--> statement-breakpoint
create or replace trigger parcels_set_gis_acres
  before insert or update of geom on gis.parcels
  for each row execute function gis.parcels_set_gis_acres();
--> statement-breakpoint

-- ============================================================================================
-- Vector tiles for the new layers (same pattern as app.mvt_fields: extent 4096, buffer 64,
-- '' when empty). Each returns '' below its minimum zoom so a zoomed-out request can't make the
-- database clip a whole county.
-- ============================================================================================

-- Fields (M0's function, extended): adds client_id / client, the custom-work customer of the
-- field's farm (farm.farms.client_party_id; absent for your own operation), for the rail's
-- "custom-work customers" toggle. Everything else is unchanged.
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
  feats as (
    select ST_AsMVTGeom(ST_Transform(b.geom, 3857), env.tile, 4096, 64, true) as geom,
           f.id::text as id,
           f.name as name,
           round(b.acres, 1)::double precision as acres,
           f.tenure as tenure,
           f.farm_id::text as farm_id,
           fa.client_party_id::text as client_id,
           cp.display_name as client
      from farm.current_boundaries b
      join farm.fields f on f.id = b.field_id
      join farm.farms fa on fa.id = f.farm_id
      left join farm.parties cp on cp.id = fa.client_party_id
     cross join env
     where b.geom && env.query_box
       and f.active
  )
  select coalesce(
    (select ST_AsMVT(feats.*, 'fields', 4096, 'geom') from feats where feats.geom is not null),
    ''::bytea
  );
$$;
--> statement-breakpoint
comment on function app.mvt_fields(integer, integer, integer) is
  'MVT tile of current field boundaries, layer ''fields'' (id, name, acres, tenure, farm_id, client_id, client).';
--> statement-breakpoint
-- Soils (public data): layer 'soils'; properties mukey, musym, muname, drainage_class, hydgrp,
-- farmland_class, nccpi (3 decimals; absent when unknown).
create or replace function app.mvt_soils(z integer, x integer, y integer)
returns bytea
language sql
stable
parallel safe
set search_path = extensions, pg_catalog, pg_temp
as $$
  with env as (
    select ST_TileEnvelope(z, x, y) as tile,
           ST_Transform(ST_TileEnvelope(z, x, y, margin => 64.0 / 4096), 4326) as query_box
     where z >= 10
  ),
  feats as (
    select ST_AsMVTGeom(ST_Transform(p.geom, 3857), env.tile, 4096, 64, true) as geom,
           p.mukey as mukey,
           u.musym as musym,
           u.muname as muname,
           u.drainage_class as drainage_class,
           u.hydgrp as hydgrp,
           u.farmland_class as farmland_class,
           round(u.nccpi::numeric, 3)::double precision as nccpi
      from gis.soil_polygons p
      join gis.soil_mapunits u on u.mukey = p.mukey
     cross join env
     where p.geom && env.query_box
  )
  select coalesce(
    (select ST_AsMVT(feats.*, 'soils', 4096, 'geom') from feats where feats.geom is not null),
    ''::bytea
  );
$$;
--> statement-breakpoint
comment on function app.mvt_soils(integer, integer, integer) is
  'MVT tile of SSURGO soil polygons, layer ''soils'' (mukey, musym, muname, drainage_class, hydgrp, farmland_class, nccpi); empty below z10. Public data.';
--> statement-breakpoint
-- Parcels with owners (PRIVATE: serve with Cache-Control private, after a session check):
-- layer 'parcels'; properties id, county_fips, parcel_no, owner_name, owner_mailing, acres
-- (the file's acres, else the geodesic area; 1 decimal).
create or replace function app.mvt_parcels(z integer, x integer, y integer)
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
           p.owner_name as owner_name,
           p.owner_mailing as owner_mailing,
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
comment on function app.mvt_parcels(integer, integer, integer) is
  'MVT tile of parcels, layer ''parcels'' (id, county_fips, parcel_no, owner_name, owner_mailing, acres); empty below z12. PRIVATE (owner names).';
--> statement-breakpoint
-- Tile lines (PRIVATE): layer 'tile_lines'; properties id, field_id, kind, origin, size_in,
-- depth_ft, installed_on (YYYY-MM-DD); absent when null.
create or replace function app.mvt_tile_lines(z integer, x integer, y integer)
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
    select ST_AsMVTGeom(ST_Transform(t.geom, 3857), env.tile, 4096, 64, true) as geom,
           t.id::text as id,
           t.field_id::text as field_id,
           t.kind as kind,
           t.origin as origin,
           t.size_in::double precision as size_in,
           t.depth_ft::double precision as depth_ft,
           to_char(t.installed_on, 'YYYY-MM-DD') as installed_on
      from farm.tile_lines t
     cross join env
     where t.geom && env.query_box
  )
  select coalesce(
    (select ST_AsMVT(feats.*, 'tile_lines', 4096, 'geom') from feats where feats.geom is not null),
    ''::bytea
  );
$$;
--> statement-breakpoint
comment on function app.mvt_tile_lines(integer, integer, integer) is
  'MVT tile of drainage tile lines, layer ''tile_lines'' (id, field_id, kind, origin, size_in, depth_ft, installed_on); empty below z12. PRIVATE.';
--> statement-breakpoint

-- ============================================================================================
-- The app's vector layers in the registry (pmtiles/xyz rows are written by the gis:* CLIs)
-- ============================================================================================

insert into gis.map_layers (key, kind, url_or_key, cache_policy, minzoom, maxzoom, attribution, default_visible)
values
  ('fields', 'mvt', '/api/tiles/fields', 'private', 8, 16, null, true),
  ('soils', 'mvt', '/api/tiles/soils', 'public', 10, 16, 'Soils: USDA NRCS SSURGO', false),
  ('parcels', 'mvt', '/api/tiles/parcels', 'private', 12, 16, null, false),
  ('tile_lines', 'mvt', '/api/tiles/tile_lines', 'private', 12, 16, null, false)
on conflict (key) do nothing;
--> statement-breakpoint

-- ============================================================================================
-- Grants: default privileges (0000) already cover new tables and app.* functions; repeated so
-- the intent is visible. gis.* functions are not public: farm_app only.
-- ============================================================================================

grant select, insert, update, delete on all tables in schema farm, gis, ingest, app to farm_app;
--> statement-breakpoint
grant execute on all functions in schema app to farm_app;
--> statement-breakpoint
revoke execute on function gis.rebuild_field_soils(uuid), gis.rebuild_all_field_soils(),
  gis.field_boundaries_rebuild_soils(), gis.parcels_set_gis_acres() from public;
--> statement-breakpoint
grant execute on function gis.rebuild_field_soils(uuid), gis.rebuild_all_field_soils() to farm_app;
--> statement-breakpoint

-- ============================================================================================
-- Documentation
-- ============================================================================================

comment on table farm.app_users is 'People who can sign in (1a): role, operator PIN (scrypt hash) with lockout, auth_user_id linked at the first verified sign-in in production.';
--> statement-breakpoint
comment on table farm.devices is 'Enrolled screens (1a): wall, cab/truck iPads (shared: operator PIN), phones (personal). Revoke with revoked_at or a session_epoch bump.';
--> statement-breakpoint
comment on column farm.devices.role is 'Role of the device session before an operator signs in; never manager or owner.';
--> statement-breakpoint
comment on table farm.geofence_visits is 'Machine enter/exit of geofences, computed from positions in PostGIS (1a); one open visit per machine and geofence.';
--> statement-breakpoint
comment on table farm.weather_grids is 'Cached NWS grid cells: id ''<WFO>/<x>,<y>'', nearest observation stations first (1b).';
--> statement-breakpoint
comment on table farm.weather_forecasts is 'NWS hourly forecast per grid cell and issue (issued_at = updateTime); valid_at = hour start, UTC (1b).';
--> statement-breakpoint
comment on table farm.weather_observations is 'NWS station observations near the fields (1b).';
--> statement-breakpoint
comment on table farm.soil_temp_readings is 'Soil temperature readings: manual probe first (1b), D5 source later (2b).';
--> statement-breakpoint
comment on table farm.spray_assessments is 'Advisory spray go/no-go per field and hour: verdict, reasons, inputs, rules_version, forecast issue used (audit trail, 1b).';
--> statement-breakpoint
comment on table farm.field_lineage is 'Field splits and merges, so history follows a field through boundary edits (1c).';
--> statement-breakpoint
comment on table farm.boundary_change_requests is 'Attempted edits of Deere-mastered boundaries (D6), kept as "change this in Ops Center" notes with the proposed shape (1c).';
--> statement-breakpoint
comment on table gis.soil_mapunits is 'SSURGO map units: dominant component attributes and component-weighted NCCPI (1c).';
--> statement-breakpoint
comment on table gis.soil_polygons is 'SSURGO map unit polygons, county-wide (1c).';
--> statement-breakpoint
comment on table gis.field_soils is 'Soils per boundary version (acres, pct), rebuilt by gis.rebuild_field_soils on every new boundary version (1c).';
--> statement-breakpoint
comment on table farm.tile_lines is 'Drainage tile as-builts: imported or drawn (1d).';
--> statement-breakpoint
comment on table gis.parcel_imports is 'Parcel files as received, with licence notes (1d, D7).';
--> statement-breakpoint
comment on table gis.parcels is 'Parcels with owner names: PRIVATE data, served only by the private parcels MVT (1d).';
--> statement-breakpoint
comment on table gis.map_layers is 'Map layer registry: format, location, version, cache policy, zooms, legend (1d). Drawing lives in code (LayerDef, same key).';
