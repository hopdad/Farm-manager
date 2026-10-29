-- M0 migration 2 of 3: tables, constraints, indexes, the acreage trigger and the
-- current-boundary view (plan §4). Mirrored by src/db/schema/*.ts; constraint and index names
-- match what drizzle-kit would generate so future `pnpm db:generate` diffs line up.
--
-- Conventions: uuid PKs; timestamptz (UTC); acres numeric; geometry EPSG:4326 with a GiST index
-- on every geometry column; outside-source rows carry source + source_id, unique together.

-- ============================================================================================
-- farm
-- ============================================================================================

create table farm.parties (
  id uuid primary key default gen_random_uuid() not null,
  kind text not null,
  org_id uuid,
  display_name text not null,
  roles text[] default '{}'::text[] not null,
  phone text,
  email text,
  address text,
  introduced_by uuid,
  notes text,
  source text default 'app' not null,
  source_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint parties_source_source_id_key unique (source, source_id),
  constraint parties_kind_check check (kind in ('person', 'org')),
  constraint parties_roles_check check (
    roles <@ array['owner', 'crew', 'landlord', 'customer', 'elevator', 'vendor', 'neighbor']::text[]
  )
);
--> statement-breakpoint
create table farm.farms (
  id uuid primary key default gen_random_uuid() not null,
  name text not null,
  client_party_id uuid,
  deere_farm_id text,
  source text default 'app' not null,
  source_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint farms_source_source_id_key unique (source, source_id)
);
--> statement-breakpoint
create table farm.fields (
  id uuid primary key default gen_random_uuid() not null,
  farm_id uuid not null,
  name text not null,
  county_fips text,
  tenure text not null,
  landlord_party_id uuid,
  deere_field_id text,
  active boolean default true not null,
  notes text,
  source text default 'app' not null,
  source_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint fields_source_source_id_key unique (source, source_id),
  constraint fields_tenure_check check (tenure in ('owned', 'cash_rent', 'share', 'custom')),
  constraint fields_county_fips_check check (county_fips ~ '^[0-9]{5}$')
);
--> statement-breakpoint
-- Boundary versions. valid is half-open [from, to); the current version has an open upper bound.
create table farm.field_boundaries (
  id uuid primary key default gen_random_uuid() not null,
  field_id uuid not null,
  geom extensions.geometry(MultiPolygon, 4326) not null,
  acres numeric(12, 4) default 0 not null,
  valid tstzrange default tstzrange(now(), null, '[)') not null,
  source text not null,
  source_id text,
  source_ref text,
  derived_stale boolean default true not null,
  created_at timestamp with time zone default now() not null,
  constraint field_boundaries_source_source_id_key unique (source, source_id),
  constraint field_boundaries_valid_not_empty check (not isempty(valid)),
  -- One boundary version per field at any instant (btree_gist provides `uuid WITH =`).
  constraint field_boundaries_no_overlap exclude using gist (field_id with =, valid with &&)
);
--> statement-breakpoint
create table farm.field_seasons (
  id uuid primary key default gen_random_uuid() not null,
  field_id uuid not null,
  crop_year integer not null,
  crop text,
  variety text,
  planted_on date,
  harvested_on date,
  yield_bu_ac numeric(8, 2),
  source text default 'app' not null,
  source_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint field_seasons_field_id_crop_year_key unique (field_id, crop_year),
  constraint field_seasons_source_source_id_key unique (source, source_id),
  constraint field_seasons_crop_year_check check (crop_year between 1950 and 2100)
);
--> statement-breakpoint
create table farm.machines (
  id uuid primary key default gen_random_uuid() not null,
  kind text not null,
  unit_no text not null,
  make text,
  model text,
  year integer,
  vin_serial text,
  status text default 'active' not null,
  down_reason text,
  engine_hours numeric(10, 1),
  odometer_mi numeric(10, 1),
  source text default 'app' not null,
  source_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint machines_source_source_id_key unique (source, source_id),
  constraint machines_kind_check check (
    kind in ('combine', 'tractor', 'sprayer', 'planter', 'grain_cart', 'semi', 'trailer', 'drone', 'pickup')
  ),
  constraint machines_status_check check (status in ('active', 'down', 'retired'))
);
--> statement-breakpoint
-- Latest state per machine, written by the fleet jobs (one batched fleet.tick per run).
create table farm.machine_state (
  machine_id uuid primary key not null,
  ts timestamp with time zone not null,
  geom extensions.geometry(Point, 4326) not null,
  speed_mph double precision,
  heading double precision,
  activity text default 'idle' not null,
  current_field_id uuid,
  fuel_pct double precision,
  engine_on boolean,
  position_source text not null,
  updated_at timestamp with time zone default now() not null,
  constraint machine_state_activity_check check (activity in ('working', 'transport', 'idle', 'queued')),
  constraint machine_state_position_source_check check (
    position_source in ('eld', 'deere_working', 'cab_device', 'manual')
  )
);
--> statement-breakpoint
-- Raw position history, kept 90 days (D9).
create table farm.positions (
  machine_id uuid not null,
  ts timestamp with time zone not null,
  geom extensions.geometry(Point, 4326) not null,
  speed_mph double precision,
  heading double precision,
  engine_on boolean,
  source text not null,
  constraint positions_pkey primary key (machine_id, ts)
);
--> statement-breakpoint
create table farm.geofences (
  id uuid primary key default gen_random_uuid() not null,
  kind text not null,
  name text not null,
  party_id uuid,
  field_id uuid,
  geom extensions.geometry(Polygon, 4326) not null,
  active boolean default true not null,
  source text default 'app' not null,
  source_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint geofences_source_source_id_key unique (source, source_id),
  constraint geofences_kind_check check (kind in ('elevator', 'field_entrance', 'shop', 'bin_site', 'fuel'))
);
--> statement-breakpoint

-- ============================================================================================
-- ingest
-- ============================================================================================

create table ingest.external_refs (
  id uuid primary key default gen_random_uuid() not null,
  source text not null,
  kind text not null,
  external_id text not null,
  source_org text default '' not null,
  entity_id uuid not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint external_refs_source_kind_external_id_source_org_key unique (source, kind, external_id, source_org)
);
--> statement-breakpoint
create table ingest.sync_state (
  source text not null,
  stream text not null,
  mode text default 'sim' not null,
  cursor jsonb,
  lease_until timestamp with time zone,
  lease_token uuid,
  next_run_at timestamp with time zone,
  last_run_at timestamp with time zone,
  last_ok_at timestamp with time zone,
  last_error text,
  last_error_at timestamp with time zone,
  extra jsonb default '{}'::jsonb not null,
  updated_at timestamp with time zone default now() not null,
  constraint sync_state_pkey primary key (source, stream),
  constraint sync_state_mode_check check (mode in ('sim', 'replay', 'sandbox', 'live', 'off'))
);
--> statement-breakpoint
create table ingest.job_runs (
  id uuid primary key default gen_random_uuid() not null,
  job text not null,
  host text default 'app' not null,
  started_at timestamp with time zone default now() not null,
  finished_at timestamp with time zone,
  ok boolean,
  items integer,
  note text,
  error text,
  constraint job_runs_host_check check (host in ('app', 'pc'))
);
--> statement-breakpoint
create table ingest.raw_events (
  id uuid primary key default gen_random_uuid() not null,
  source text not null,
  stream text not null,
  external_id text not null,
  payload jsonb not null,
  sha256 text not null,
  fetched_at timestamp with time zone default now() not null,
  status text default 'pending' not null,
  attempts integer default 0 not null,
  last_error text,
  processed_at timestamp with time zone,
  constraint raw_events_source_stream_external_id_sha256_key unique (source, stream, external_id, sha256),
  constraint raw_events_status_check check (status in ('pending', 'processed', 'dead')),
  constraint raw_events_sha256_check check (sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
create table ingest.oauth_tokens (
  id uuid primary key default gen_random_uuid() not null,
  source text not null,
  org_external_id text default '' not null,
  ciphertext text not null,
  expires_at timestamp with time zone,
  refresh_expires_at timestamp with time zone,
  scopes text[] default '{}'::text[] not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint oauth_tokens_source_org_external_id_key unique (source, org_external_id)
);
--> statement-breakpoint

-- ============================================================================================
-- app
-- ============================================================================================

create table app.settings (
  key text primary key not null,
  value jsonb not null,
  updated_at timestamp with time zone default now() not null
);
--> statement-breakpoint
create table app.topic_seq (
  topic text primary key not null,
  seq bigint default 0 not null
);
--> statement-breakpoint

-- ============================================================================================
-- Foreign keys (named like drizzle-kit's)
-- ============================================================================================

alter table farm.parties
  add constraint parties_org_id_parties_id_fk foreign key (org_id) references farm.parties (id) on delete set null,
  add constraint parties_introduced_by_parties_id_fk foreign key (introduced_by) references farm.parties (id) on delete set null;
--> statement-breakpoint
alter table farm.farms
  add constraint farms_client_party_id_parties_id_fk foreign key (client_party_id) references farm.parties (id) on delete set null;
--> statement-breakpoint
alter table farm.fields
  add constraint fields_farm_id_farms_id_fk foreign key (farm_id) references farm.farms (id) on delete restrict,
  add constraint fields_landlord_party_id_parties_id_fk foreign key (landlord_party_id) references farm.parties (id) on delete set null;
--> statement-breakpoint
alter table farm.field_boundaries
  add constraint field_boundaries_field_id_fields_id_fk foreign key (field_id) references farm.fields (id) on delete cascade;
--> statement-breakpoint
alter table farm.field_seasons
  add constraint field_seasons_field_id_fields_id_fk foreign key (field_id) references farm.fields (id) on delete cascade;
--> statement-breakpoint
alter table farm.machine_state
  add constraint machine_state_machine_id_machines_id_fk foreign key (machine_id) references farm.machines (id) on delete cascade,
  add constraint machine_state_current_field_id_fields_id_fk foreign key (current_field_id) references farm.fields (id) on delete set null;
--> statement-breakpoint
alter table farm.positions
  add constraint positions_machine_id_machines_id_fk foreign key (machine_id) references farm.machines (id) on delete cascade;
--> statement-breakpoint
alter table farm.geofences
  add constraint geofences_party_id_parties_id_fk foreign key (party_id) references farm.parties (id) on delete set null,
  add constraint geofences_field_id_fields_id_fk foreign key (field_id) references farm.fields (id) on delete cascade;
--> statement-breakpoint

-- ============================================================================================
-- Indexes (GiST on every geometry column; BRIN on positions.ts)
-- ============================================================================================

create index parties_org_id_idx on farm.parties using btree (org_id);
--> statement-breakpoint
create index fields_farm_id_idx on farm.fields using btree (farm_id);
--> statement-breakpoint
create index field_boundaries_geom_gist on farm.field_boundaries using gist (geom);
--> statement-breakpoint
create index machine_state_geom_gist on farm.machine_state using gist (geom);
--> statement-breakpoint
create index positions_ts_brin on farm.positions using brin (ts);
--> statement-breakpoint
create index positions_geom_gist on farm.positions using gist (geom);
--> statement-breakpoint
create index geofences_geom_gist on farm.geofences using gist (geom);
--> statement-breakpoint
create index external_refs_entity_id_idx on ingest.external_refs using btree (entity_id);
--> statement-breakpoint
create index job_runs_job_started_at_idx on ingest.job_runs using btree (job, started_at desc nulls last);
--> statement-breakpoint
create index raw_events_pending_idx on ingest.raw_events using btree (source, stream, fetched_at)
  where status = 'pending';
--> statement-breakpoint

-- ============================================================================================
-- Acreage trigger: acres always follow the geometry (geodesic area on the WGS84 spheroid).
-- ============================================================================================

create function farm.field_boundaries_set_acres() returns trigger
language plpgsql
set search_path = extensions, pg_catalog, pg_temp
as $$
begin
  new.acres := round((ST_Area(new.geom::geography) / 4046.86)::numeric, 4);
  return new;
end
$$;
--> statement-breakpoint
create trigger field_boundaries_set_acres
  before insert or update on farm.field_boundaries
  for each row execute function farm.field_boundaries_set_acres();
--> statement-breakpoint

-- ============================================================================================
-- Current boundaries: the version whose validity contains now() (at most one per field).
-- ============================================================================================

create view farm.current_boundaries with (security_invoker = true) as
select b.id, b.field_id, b.geom, b.acres, b.valid, b.source, b.source_id, b.source_ref,
       b.derived_stale, b.created_at
  from farm.field_boundaries b
 where b.valid @> now();
--> statement-breakpoint

-- ============================================================================================
-- Documentation
-- ============================================================================================

comment on table farm.parties is 'People and organizations: owner, crew, landlords, customers, elevators, vendors, neighbors.';
--> statement-breakpoint
comment on table farm.farms is 'Operations Center style farms; client_party_id null = your own operation.';
--> statement-breakpoint
comment on table farm.fields is 'Field identity (no geometry); boundaries are versioned in farm.field_boundaries.';
--> statement-breakpoint
comment on table farm.field_boundaries is 'Boundary versions. Non-overlapping validity per field (EXCLUDE); acres set by trigger; source deere is read-only in the app.';
--> statement-breakpoint
comment on table farm.machine_state is 'Latest known state per machine; positions are wall-clock timestamps also in sim mode.';
--> statement-breakpoint
comment on table farm.positions is 'Raw position history; PK (machine_id, ts); BRIN on ts; 90-day retention (D9).';
--> statement-breakpoint
comment on table ingest.sync_state is 'Per (source, stream): mode, cursor, lease. Claim with app.claim_due().';
--> statement-breakpoint
comment on table ingest.raw_events is 'Raw landing zone and webhook inbox: pending -> processed | dead (after 5 attempts).';
--> statement-breakpoint
comment on table app.settings is 'Runtime settings (jsonb). Keys: clock.paused (boolean).';
