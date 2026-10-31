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
--   fleet-faults  farm.machine_faults (fault code history, one model for J1939, OBD-II and OEM
--                 codes); farm.machine_state.fault_codes / faults_at (current summary + time
--                 guard), stats_at (fuel time guard), position_vendor (per-machine vendor badge),
--                 position_kind (live trail point or last-known snapshot)
--   1f.2          multi-vendor telematics (docs/contracts-1f.md part B, amended in place while
--                 0007 is unmerged): position_vendor takes any vendor id of a fixed format (the
--                 code registry src/connectors/vendors.ts labels it, no migration per vendor);
--                 farm.machines gains telematics_via (ford_pro, stellantis, gateway, …) and
--                 kind_set_by (a kind set on /admin wins over a vendor tag), and the kinds
--                 service_truck and loader
--   sync-health   ingest.api_calls_daily (vendor calls per source, stream, mode and UTC day:
--                 decision 4), ingest.connector_orgs (org approval status per mode: decision 5)
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
-- jsonb shaped by src/domain/operations.ts. geom = the coverage, simplified. operator_name = the
-- operator as the vendor names them (operator_party_id stays null until a party-matching rule
-- exists).
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
  operator_name text,
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
-- 1f.2: telematics vehicles (kind from a vendor tag or /admin; how the data reaches the vendor)
-- ============================================================================================

-- Not every telematics vehicle is a semi: pickups and service trucks (and the yard's loaders)
-- are kinds of their own. Drop and re-add, so a re-run converges.
alter table farm.machines drop constraint if exists machines_kind_check;
--> statement-breakpoint
alter table farm.machines add constraint machines_kind_check check (
  kind in ('combine', 'tractor', 'sprayer', 'planter', 'grain_cart', 'semi', 'trailer', 'drone',
           'pickup', 'service_truck', 'loader'));
--> statement-breakpoint
-- telematics_via: how the vendor gets the vehicle's data, where it says (ford_pro, stellantis:
-- carmaker clouds; gateway: an asset gateway; obd_device). Any id of the vendor-id format.
alter table farm.machines add column if not exists telematics_via text;
--> statement-breakpoint
-- kind_set_by: who set kind last. 'admin' (set on /admin) wins: a vendor tag never changes it.
alter table farm.machines add column if not exists kind_set_by text default 'default' not null;
--> statement-breakpoint
alter table farm.machines drop constraint if exists machines_telematics_via_check;
--> statement-breakpoint
alter table farm.machines add constraint machines_telematics_via_check
  check (telematics_via is null or telematics_via ~ '^[a-z][a-z0-9_]{1,30}$');
--> statement-breakpoint
alter table farm.machines drop constraint if exists machines_kind_set_by_check;
--> statement-breakpoint
alter table farm.machines add constraint machines_kind_set_by_check
  check (kind_set_by in ('default', 'vendor', 'admin'));
--> statement-breakpoint

-- ============================================================================================
-- fleet-faults: fault code history and the current summary on machine_state
-- ============================================================================================

-- One OPEN row (cleared_at null) per machine, source and code; a code seen again after it
-- cleared opens a new row. One model for every code system (1f.2, src/domain/fault-codes.ts):
-- system 'j1939' (spn + fmi, the controller's source address and occurrence count when sent),
-- 'obd2' (the DTC is `code`; dtc_state confirmed / pending / permanent) or 'oem' (a maker's
-- caution or fault code: oem_class); lamps = the lamp states as reported (redStop,
-- amberWarning, protect, malfunction); vendor_severity = the vendor's own label, verbatim.
-- Severity policy: decision 1f-2, extended per system (faultSeverity).
create table if not exists farm.machine_faults (
  id uuid primary key default gen_random_uuid() not null,
  machine_id uuid not null,
  source text not null,
  code text not null,
  system text not null,
  spn integer,
  fmi integer,
  source_address integer,
  occurrence_count integer,
  dtc_state text,
  oem_class text,
  lamps jsonb,
  severity text not null,
  vendor_severity text,
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
-- 1f.2 columns for a database that ran the first cut of 0007 (re-runnable).
alter table farm.machine_faults add column if not exists system text;
--> statement-breakpoint
alter table farm.machine_faults add column if not exists spn integer;
--> statement-breakpoint
alter table farm.machine_faults add column if not exists fmi integer;
--> statement-breakpoint
-- A first-cut row's system from its key (faultCodeKey): 'J1939 SPN <spn> FMI <fmi>' within the
-- 19/5-bit ranges is j1939 with spn and fmi filled (the system CHECK needs both); an OBD-II DTC is
-- obd2; anything else (an unparseable J1939 key included) is an oem code under the same key.
update farm.machine_faults f set
  system = case when p.spn is not null then 'j1939'
                when f.code ~ '^[PBCU][0-9A-F]{4}$' then 'obd2' else 'oem' end,
  spn = p.spn,
  fmi = p.fmi
  from (select id,
               case when m[1]::bigint <= 524287 and m[2]::int <= 31 then m[1]::int end as spn,
               case when m[1]::bigint <= 524287 and m[2]::int <= 31 then m[2]::int end as fmi
          from (select id, regexp_match(code, '^J1939 SPN ([0-9]{1,7}) FMI ([0-9]{1,3})$') as m
                  from farm.machine_faults where system is null) parsed) p
 where f.id = p.id;
--> statement-breakpoint
alter table farm.machine_faults alter column system set not null;
--> statement-breakpoint
alter table farm.machine_faults add column if not exists source_address integer;
--> statement-breakpoint
alter table farm.machine_faults add column if not exists occurrence_count integer;
--> statement-breakpoint
alter table farm.machine_faults add column if not exists dtc_state text;
--> statement-breakpoint
alter table farm.machine_faults add column if not exists oem_class text;
--> statement-breakpoint
alter table farm.machine_faults add column if not exists lamps jsonb;
--> statement-breakpoint
alter table farm.machine_faults add column if not exists vendor_severity text;
--> statement-breakpoint
-- The system's own fields only on that system's rows; J1939 SPN 19 bits, FMI 5 bits.
alter table farm.machine_faults drop constraint if exists machine_faults_system_check;
--> statement-breakpoint
alter table farm.machine_faults add constraint machine_faults_system_check check (
  system in ('j1939', 'obd2', 'oem')
  and (system = 'j1939') = (spn is not null and fmi is not null)
  and (spn is null or spn between 0 and 524287)
  and (fmi is null or fmi between 0 and 31)
  and (source_address is null or (system = 'j1939' and source_address between 0 and 255))
  and (occurrence_count is null or occurrence_count >= 0)
  and (dtc_state is null or (system = 'obd2' and dtc_state in ('confirmed', 'pending', 'permanent')))
  and (oem_class is null or (system = 'oem' and oem_class in ('caution', 'fault')))
  and (lamps is null or jsonb_typeof(lamps) = 'object'));
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
-- 1f.2: diesel exhaust fluid level (0-100) from the latest stat, guarded by stats_at like fuel_pct.
alter table farm.machine_state add column if not exists def_pct double precision;
--> statement-breakpoint
-- 1f.2: 'live' = a trail point (also in farm.positions); 'last_known' = a vendor snapshot of where
-- the machine was last seen (AEMP, Terminal's latest location): machine_state only, its own
-- stale threshold.
alter table farm.machine_state add column if not exists position_kind text default 'live' not null;
--> statement-breakpoint
alter table farm.machine_state drop constraint if exists machine_state_position_kind_check;
--> statement-breakpoint
alter table farm.machine_state add constraint machine_state_position_kind_check
  check (position_kind in ('live', 'last_known'));
--> statement-breakpoint
-- position_vendor: any vendor id of the format (1f.2: a registry id such as samsara, geotab, cnh,
-- or <route>_<provider> such as aemp_kubota; src/domain/fleet.ts POSITION_VENDOR_PATTERN), so a
-- new vendor needs no migration; fault_codes must be an array (the panel parses it). Drop and
-- re-add, so a re-run converges.
alter table farm.machine_state drop constraint if exists machine_state_position_vendor_check;
--> statement-breakpoint
alter table farm.machine_state add constraint machine_state_position_vendor_check
  check (position_vendor is null or position_vendor ~ '^[a-z][a-z0-9_]{1,30}$');
--> statement-breakpoint
alter table farm.machine_state drop constraint if exists machine_state_fault_codes_check;
--> statement-breakpoint
alter table farm.machine_state add constraint machine_state_fault_codes_check
  check (jsonb_typeof(fault_codes) = 'array');
--> statement-breakpoint

-- ============================================================================================
-- sync-health: vendor call counts and org approval status
-- ============================================================================================

-- Vendor API calls per source, stream, connector mode and UTC day (decision 4). Every HTTP
-- attempt counts (retries too); errors = non-2xx other than 429 plus attempts that got no
-- answer; rate_limited = 429s. stream '' = calls outside a sync step (OAuth callback); the CLIs
-- count under 'backfill' and 'record'. mode = the connector mode the calls went through, so sim
-- and replay calls never count against a real budget (the budget reads sandbox/live rows only).
-- Upserted with `calls = calls + excluded.calls`.
create table if not exists ingest.api_calls_daily (
  source text not null,
  stream text default '' not null,
  mode text not null,
  day date not null,
  calls integer default 0 not null,
  errors integer default 0 not null,
  rate_limited integer default 0 not null,
  updated_at timestamp with time zone default now() not null,
  constraint api_calls_daily_pkey primary key (source, stream, mode, day),
  constraint api_calls_daily_mode_check check (mode in ('sim', 'replay', 'sandbox', 'live')),
  constraint api_calls_daily_counts_check check (calls >= 0 and errors >= 0 and rate_limited >= 0)
);
--> statement-breakpoint

-- The vendor orgs a connection sees (decision 5): a Deere org whose listing carries a
-- `connections` link, or that answers 403, is needs_approval (skipped by every sync, shown on
-- /admin/connectors with its approval link); else connected. Per connector mode: the page shows
-- the current mode's rows, and each successful org listing deletes that source and mode's rows
-- it no longer lists (so sim's orgs never show as connected after a switch to sandbox).
create table if not exists ingest.connector_orgs (
  source text not null,
  mode text not null,
  org_external_id text not null,
  name text,
  status text not null,
  approval_url text,
  detail text,
  first_seen_at timestamp with time zone default now() not null,
  last_seen_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint connector_orgs_pkey primary key (source, mode, org_external_id),
  constraint connector_orgs_mode_check check (mode in ('sim', 'replay', 'sandbox', 'live')),
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
comment on table farm.machine_faults is 'Fault code history in one model (1f.2: J1939 SPN/FMI with lamps, OBD-II DTCs, OEM caution/fault codes); one open row per machine, source and code.';
--> statement-breakpoint
comment on column farm.machine_state.fault_codes is 'Active fault codes (ActiveFaultCode[], worst first); updated only by a fault event newer than faults_at; the first position insert seeds it from the open machine_faults rows.';
--> statement-breakpoint
comment on column farm.machine_state.position_vendor is 'Vendor id of the latest fix (samsara, motive, geotab, deere, cnh, aemp_<provider>, …; labelled by src/connectors/vendors.ts); null for manual fixes and rows older than 0007.';
--> statement-breakpoint
comment on column farm.machine_state.position_kind is 'live = a trail point; last_known = a vendor snapshot (AEMP, Terminal latest location), machine_state only (1f.2).';
--> statement-breakpoint
comment on column farm.machine_state.def_pct is 'Diesel exhaust fluid level 0-100 from the latest stat (1f.2); like fuel_pct, only a stat newer than stats_at moves it.';
--> statement-breakpoint
comment on column farm.machines.telematics_via is 'How the telematics vendor gets the data: ford_pro, stellantis (carmaker clouds), gateway, obd_device; null = the vendor does not say (1f.2).';
--> statement-breakpoint
comment on column farm.machines.kind_set_by is 'Who set kind last: default (seed or sync on create), vendor (a vendor tag, VEHICLE_KIND_TAGS) or admin (/admin; wins over vendor tags) (1f.2).';
--> statement-breakpoint
comment on table ingest.api_calls_daily is 'Vendor API calls per source, stream, connector mode and UTC day: calls, errors, rate-limited (1f, decision 4).';
--> statement-breakpoint
comment on table ingest.connector_orgs is 'Vendor orgs a connection sees (per connector mode) and whether each is connected or needs approval (1f, decision 5).';
