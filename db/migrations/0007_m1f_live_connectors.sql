-- Slice 1f "Live connectors + sync health": every table and column the four parallel 1f builders
-- need, in one migration (plan §4 rows farm.operations, farm.pins, farm.machine_hours /
-- farm.machine_faults; docs/contracts-1f.md §3). Mirrored by src/db/schema/{farm,ingest}.ts
-- (snapshot meta/0007_snapshot.json); constraint and index names follow drizzle-kit's
-- conventions, like 0001 and 0003.
--
-- Same rules as 0000-0006: runs as `postgres` (NOSUPERUSER on Supabase and locally), no
-- extensions, no pg_cron/pg_net, no passwords. Re-runnable: every statement is `if not exists`,
-- `create or replace` or guarded, so a database that already has part of it converges instead
-- of failing. EPSG:4326 with a GiST index on every geometry column. Outside rows carry
-- source + source_id (unique together) and a deterministic id (src/domain/ids.ts).
--
--   deere-ops     farm.operations (field operations with products, measurements, coverage)
--   deere-data    farm.pins (Deere flags, read-only), farm.machine_hours (engine hours);
--                 farm.fields.tenure gains 'unknown' (a field the Deere sync created, tenure not
--                 set by hand yet: decision 7)
--   fleet-faults  farm.machine_faults (fault code history); farm.machine_state.fault_codes /
--                 faults_at (current summary + time guard), stats_at (fuel time guard),
--                 position_vendor (per-machine vendor badge)
--   sync-health   ingest.api_calls_daily (vendor calls per source, stream and UTC day: decision
--                 4), ingest.connector_orgs (org approval status: decision 5)
--
-- No new ingest.external_refs kinds: operations and pins carry their own source_id.
-- Slice 1e (the PC's lidar and crop history, db/pending/pc-1e.sql) takes the next free number
-- when it merges.

-- ============================================================================================
-- deere-ops: field operations
-- ============================================================================================

-- What a machine did on a field, as Operations Center reports it. Synced rows: id =
-- deterministicId('deere', <Deere operation id>), source 'deere', source_id = that id,
-- source_org = the Deere org it was read from. field_id is null when the operation's field
-- isn't mapped (plan §7 dq: "operations with no field"). products / measurements / weather are
-- jsonb shaped by src/domain/operations.ts. geom = the coverage, simplified.
create table if not exists farm.operations (
  id uuid primary key default gen_random_uuid() not null,
  kind text not null,
  field_id uuid,
  crop_year integer not null,
  crop text,
  started_at timestamp with time zone not null,
  ended_at timestamp with time zone,
  area_reported_ac numeric(12, 4),
  area_clipped_ac numeric(12, 4),
  products jsonb default '[]'::jsonb not null,
  measurements jsonb default '{}'::jsonb not null,
  machine_ids uuid[] default '{}'::uuid[] not null,
  operator_party_id uuid,
  weather jsonb,
  status text default 'provisional' not null,
  geom extensions.geometry(MultiPolygon, 4326),
  source text not null,
  source_id text,
  source_org text,
  source_modified_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint operations_source_source_id_key unique (source, source_id),
  constraint operations_kind_check check (kind in ('seeding', 'application', 'harvest', 'tillage')),
  constraint operations_status_check check (status in ('provisional', 'final')),
  constraint operations_crop_year_check check (crop_year between 1950 and 2100),
  constraint operations_ended_at_check check (ended_at is null or ended_at >= started_at),
  constraint operations_area_check check (
    (area_reported_ac is null or area_reported_ac >= 0)
    and (area_clipped_ac is null or area_clipped_ac >= 0))
);
--> statement-breakpoint
create index if not exists operations_field_id_crop_year_started_at_idx
  on farm.operations using btree (field_id, crop_year, started_at desc nulls last);
--> statement-breakpoint
create index if not exists operations_geom_gist on farm.operations using gist (geom);
--> statement-breakpoint

-- ============================================================================================
-- deere-data: pins (Deere flags) and machine hours; tenure 'unknown'
-- ============================================================================================

-- Pins on the map. 1f: Deere flags, read-only (source 'deere_flag', read_only true, id =
-- deterministicId('deere_flag', <Deere flag id>); D19: never pushed back). 2c adds pins drawn on
-- a phone (source 'app', photo_keys, client_id = the phone's offline dedupe key).
create table if not exists farm.pins (
  id uuid primary key default gen_random_uuid() not null,
  kind text default 'note' not null,
  field_id uuid,
  geom extensions.geometry(Geometry, 4326) not null,
  note text,
  category text,
  photo_keys text[] default '{}'::text[] not null,
  created_by uuid,
  resolved_at timestamp with time zone,
  client_id uuid,
  read_only boolean default false not null,
  source text default 'app' not null,
  source_id text,
  source_org text,
  source_modified_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint pins_source_source_id_key unique (source, source_id),
  constraint pins_kind_check check (
    kind in ('wet_hole', 'rock', 'tile_blowout', 'washout', 'hazard', 'note')),
  constraint pins_geom_type_check check (
    extensions.ST_GeometryType(geom) in ('ST_Point', 'ST_LineString', 'ST_Polygon'))
);
--> statement-breakpoint
create unique index if not exists pins_client_id_key on farm.pins using btree (client_id)
  where client_id is not null;
--> statement-breakpoint
create index if not exists pins_field_id_idx on farm.pins using btree (field_id);
--> statement-breakpoint
create index if not exists pins_geom_gist on farm.pins using gist (geom);
--> statement-breakpoint

-- Engine hours / odometer readings over time (Deere machine hours in 1f). The latest also lands
-- on farm.machines.engine_hours, which never decreases (src/db/queries/fleet.ts).
create table if not exists farm.machine_hours (
  machine_id uuid not null,
  ts timestamp with time zone not null,
  engine_hours numeric(10, 1),
  odometer_mi numeric(10, 1),
  source text not null,
  created_at timestamp with time zone default now() not null,
  constraint machine_hours_pkey primary key (machine_id, source, ts),
  constraint machine_hours_reading_check check (engine_hours is not null or odometer_mi is not null),
  constraint machine_hours_values_check check (
    (engine_hours is null or engine_hours >= 0) and (odometer_mi is null or odometer_mi >= 0))
);
--> statement-breakpoint
create index if not exists machine_hours_machine_id_ts_idx
  on farm.machine_hours using btree (machine_id, ts desc nulls last);
--> statement-breakpoint

-- A field the Deere sync creates has no tenure until someone sets it by hand (decision 7):
-- 'unknown' joins the allowed values. Drop and re-add, so a re-run converges.
alter table farm.fields drop constraint if exists fields_tenure_check;
--> statement-breakpoint
alter table farm.fields add constraint fields_tenure_check
  check (tenure in ('owned', 'cash_rent', 'share', 'custom', 'unknown'));
--> statement-breakpoint

-- ============================================================================================
-- fleet-faults: fault code history and the current summary on machine_state
-- ============================================================================================

-- One OPEN row (cleared_at null) per machine, source and code; a code seen again after it
-- cleared opens a new row. Severity policy: decision 2 (src/domain/fault-codes.ts).
create table if not exists farm.machine_faults (
  id uuid primary key default gen_random_uuid() not null,
  machine_id uuid not null,
  source text not null,
  code text not null,
  severity text not null,
  description text,
  first_seen_at timestamp with time zone not null,
  last_seen_at timestamp with time zone not null,
  cleared_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint machine_faults_severity_check check (severity in ('info', 'warning', 'critical')),
  constraint machine_faults_seen_check check (last_seen_at >= first_seen_at),
  constraint machine_faults_cleared_check check (cleared_at is null or cleared_at >= first_seen_at)
);
--> statement-breakpoint
create unique index if not exists machine_faults_open_key
  on farm.machine_faults using btree (machine_id, source, code) where cleared_at is null;
--> statement-breakpoint
create index if not exists machine_faults_machine_id_first_seen_at_idx
  on farm.machine_faults using btree (machine_id, first_seen_at desc nulls last);
--> statement-breakpoint

-- machine_state: the connector source of the latest fix (the per-machine "Samsara · sim"
-- badge), the active fault codes (ActiveFaultCode[], worst first) with the vendor time of the
-- event they reflect (an older page never brings a cleared fault back), and the vendor time of
-- the stat fuel_pct came from (the time guard contracts.md listed as open).
alter table farm.machine_state add column if not exists position_vendor text;
--> statement-breakpoint
alter table farm.machine_state add column if not exists fault_codes jsonb default '[]'::jsonb not null;
--> statement-breakpoint
alter table farm.machine_state add column if not exists faults_at timestamp with time zone;
--> statement-breakpoint
alter table farm.machine_state add column if not exists stats_at timestamp with time zone;
--> statement-breakpoint

-- ============================================================================================
-- sync-health: vendor call counts and org approval status
-- ============================================================================================

-- Vendor API calls per source, stream and UTC day (decision 4). Every HTTP attempt counts
-- (retries too); errors = non-2xx other than 429 plus attempts that got no answer;
-- rate_limited = 429s. stream '' = calls outside a sync step (OAuth callback, CLIs). Upserted
-- with `calls = calls + excluded.calls`.
create table if not exists ingest.api_calls_daily (
  source text not null,
  stream text default '' not null,
  day date not null,
  calls integer default 0 not null,
  errors integer default 0 not null,
  rate_limited integer default 0 not null,
  updated_at timestamp with time zone default now() not null,
  constraint api_calls_daily_pkey primary key (source, stream, day),
  constraint api_calls_daily_counts_check check (calls >= 0 and errors >= 0 and rate_limited >= 0)
);
--> statement-breakpoint

-- The vendor orgs a connection sees (decision 5): a Deere org whose listing carries a
-- `connections` link, or that answers 403, is needs_approval (skipped by every sync, shown on
-- /admin/connectors with its approval link); else connected.
create table if not exists ingest.connector_orgs (
  source text not null,
  org_external_id text not null,
  name text,
  status text not null,
  approval_url text,
  detail text,
  first_seen_at timestamp with time zone default now() not null,
  last_seen_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint connector_orgs_pkey primary key (source, org_external_id),
  constraint connector_orgs_status_check check (status in ('connected', 'needs_approval'))
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
      ('farm.operations', 'operations_field_id_fields_id_fk',
       'foreign key (field_id) references farm.fields (id) on delete set null'),
      ('farm.operations', 'operations_operator_party_id_parties_id_fk',
       'foreign key (operator_party_id) references farm.parties (id) on delete set null'),
      ('farm.pins', 'pins_field_id_fields_id_fk',
       'foreign key (field_id) references farm.fields (id) on delete set null'),
      ('farm.pins', 'pins_created_by_app_users_id_fk',
       'foreign key (created_by) references farm.app_users (id) on delete set null'),
      ('farm.machine_hours', 'machine_hours_machine_id_machines_id_fk',
       'foreign key (machine_id) references farm.machines (id) on delete cascade'),
      ('farm.machine_faults', 'machine_faults_machine_id_machines_id_fk',
       'foreign key (machine_id) references farm.machines (id) on delete cascade')
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

-- Grants: default privileges (0000) already cover new tables; repeated so a database created
-- before them converges too.
grant select, insert, update, delete on all tables in schema farm, ingest to farm_app;
--> statement-breakpoint

comment on table farm.operations is 'Field operations (seeding, application, harvest, tillage) from Operations Center with products, measurements and simplified coverage (1f).';
--> statement-breakpoint
comment on table farm.pins is 'Pins on the map: Deere flags read-only (1f, source deere_flag); drawn on phones with photos in 2c.';
--> statement-breakpoint
comment on table farm.machine_hours is 'Engine hours and odometer readings over time (1f: Deere machine hours).';
--> statement-breakpoint
comment on table farm.machine_faults is 'Vehicle fault code history (1f: Samsara); one open row per machine, source and code.';
--> statement-breakpoint
comment on column farm.machine_state.fault_codes is 'Active fault codes (ActiveFaultCode[], worst first); updated only by a fault event newer than faults_at.';
--> statement-breakpoint
comment on column farm.machine_state.position_vendor is 'Connector source of the latest fix (samsara, motive, deere); null for manual fixes and rows older than 0007.';
--> statement-breakpoint
comment on table ingest.api_calls_daily is 'Vendor API calls per source, stream and UTC day: calls, errors, rate-limited (1f, decision 4).';
--> statement-breakpoint
comment on table ingest.connector_orgs is 'Vendor orgs a connection sees and whether each is connected or needs approval (1f, decision 5).';
