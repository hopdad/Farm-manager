-- Slice 2a "Job board + drag-to-assign": every table and column the four parallel 2a builders
-- need, in one migration (plan §4 rows farm.products, farm.jobs, farm.job_assignments /
-- farm.job_products, farm.data_rights_agreements, app.usage_events; docs/contracts-2a.md §3).
-- Mirrored by src/db/schema/{farm,app}.ts (snapshot meta/0008_snapshot.json); constraint and
-- index names follow drizzle-kit's conventions, like 0001, 0003 and 0007. The allowed values of
-- every CHECK come from src/domain/work-jobs.ts.
--
-- Same rules as 0000-0007: runs as `postgres` (NOSUPERUSER on Supabase and locally), no
-- extensions, no pg_cron/pg_net, no passwords. Re-runnable: every statement is `if not exists`,
-- `create or replace` or guarded, so a database that already has part of it converges instead
-- of failing. No geometry columns. Outside and demo rows carry source + source_id (unique
-- together) and a deterministic id (src/domain/ids.ts); rows with source demo or sim are never
-- exported.
--
--   jobs-api      farm.jobs (with `version` for optimistic concurrency, decision 2a-7),
--                 farm.job_assignments, farm.job_products. The jobs publish triggers (decision
--                 2a-8) are NOT here: jobs-api writes them in db/pending/jobs-api.sql and the
--                 integrator folds them into the next migration.
--   job-forms     farm.products (decision 2a-12), farm.job_request_links (decision 2a-9)
--   rights-usage  farm.data_rights_agreements (D17, decision 2a-10), app.usage_events
--                 (decision 2a-11; the first FKs from `app` into `farm`)
--
-- Columns beyond plan §4 (contracts-2a §3): farm.jobs.planned_window is the plan's `window`
-- (a reserved word in SQL); status_changed_at; title, notes, crop_year, planned_acres_by_hand,
-- request_channel, requested_by_party_id, requester_name, requester_phone, request_link_id,
-- cancelled_reason, created_by, updated_by, source, source_id. farm.job_assignments gets id,
-- assigned_by and created_at; planned_for is a tstzrange (null = the job's whole window).
--
-- Slice 1e (the PC's lidar and crop history, db/pending/pc-1e.sql) takes the next free number
-- after 0008 when it merges.

-- ============================================================================================
-- job-forms: products and request links
-- ============================================================================================

-- Seed, chemicals, fertilizer and fuel (plan §4). label_rules = 2b's go/no-go input ('{}' until
-- then). Retired with active = false, never deleted while a job names it (job_products
-- restricts).
create table if not exists farm.products (
  id uuid primary key default gen_random_uuid() not null,
  kind text not null,
  name text not null,
  epa_reg_no text,
  restricted_use boolean default false not null,
  unit text not null,
  label_rules jsonb default '{}'::jsonb not null,
  active boolean default true not null,
  source text default 'app' not null,
  source_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint products_source_source_id_key unique (source, source_id),
  constraint products_kind_check check (kind in ('seed', 'chemical', 'fertilizer', 'fuel')),
  constraint products_unit_check check (
    unit in ('gal', 'qt', 'pt', 'floz', 'lb', 'oz', 'ton', 'bag', 'unit', 'kseed')),
  constraint products_name_check check (length(btrim(name)) between 1 and 120),
  constraint products_label_rules_check check (jsonb_typeof(label_rules) = 'object')
);
--> statement-breakpoint

-- A customer's revocable request link, /r/<token> (decision 2a-9; reaches customers only after
-- MD). Only the token's HMAC (SESSION_SECRET) is stored; revoked_at ends it.
create table if not exists farm.job_request_links (
  id uuid primary key default gen_random_uuid() not null,
  party_id uuid not null,
  token_hash text not null,
  label text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  revoked_at timestamp with time zone,
  last_used_at timestamp with time zone,
  constraint job_request_links_token_hash_key unique (token_hash)
);
--> statement-breakpoint
create index if not exists job_request_links_party_id_idx
  on farm.job_request_links using btree (party_id);
--> statement-breakpoint

-- ============================================================================================
-- jobs-api: jobs, assignments, products on a job
-- ============================================================================================

-- A piece of farm work on the board. version: every job write (this row or a child row)
-- compares and bumps it in one transaction (decision 2a-7). planned_acres: the field's current
-- boundary acres when the field is set, unless typed by hand (planned_acres_by_hand, decision
-- 2a-5). crop_year: set with the field (decision 2a-6). The text limits match
-- src/domain/work-jobs.ts (MAX_*_CHARS).
create table if not exists farm.jobs (
  id uuid primary key default gen_random_uuid() not null,
  kind text not null,
  business_line text not null,
  status text default 'planned' not null,
  status_changed_at timestamp with time zone default now() not null,
  title text,
  customer_party_id uuid,
  field_id uuid,
  planned_window tstzrange,
  crop_year integer,
  planned_acres numeric(12, 4),
  planned_acres_by_hand boolean default false not null,
  planned_qty numeric(12, 2),
  planned_unit text,
  priority integer default 3 not null,
  sort_key double precision default 0 not null,
  version integer default 1 not null,
  deere_work_plan_id text,
  notes text,
  request_channel text,
  requested_by_party_id uuid,
  requester_name text,
  requester_phone text,
  request_link_id uuid,
  cancelled_reason text,
  created_by uuid,
  updated_by uuid,
  source text default 'app' not null,
  source_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint jobs_source_source_id_key unique (source, source_id),
  constraint jobs_kind_check check (
    kind in ('plant', 'spray', 'harvest', 'haul', 'tillage', 'fertilize', 'scout', 'tile',
             'repair', 'other')),
  constraint jobs_business_line_check check (
    business_line in ('spraying', 'grain', 'trucking', 'store')),
  constraint jobs_status_check check (
    status in ('requested', 'planned', 'assigned', 'pushed', 'in_progress', 'done', 'invoiced',
               'cancelled')),
  constraint jobs_planned_unit_check check (
    planned_unit is null or planned_unit in ('loads', 'bu', 'hours', 'tons', 'gal')),
  constraint jobs_request_channel_check check (
    request_channel is null or request_channel in ('text', 'phone', 'in_person', 'web_form')),
  constraint jobs_priority_check check (priority between 1 and 4),
  constraint jobs_version_check check (version >= 1),
  constraint jobs_crop_year_check check (crop_year is null or crop_year between 1950 and 2100),
  constraint jobs_planned_check check (
    (planned_acres is null or planned_acres >= 0) and (planned_qty is null or planned_qty >= 0)),
  constraint jobs_planned_window_check check (
    planned_window is null or not isempty(planned_window)),
  constraint jobs_text_check check (
    (title is null or length(title) <= 80)
    and (notes is null or length(notes) <= 4000)
    and (cancelled_reason is null or length(cancelled_reason) <= 500)
    and (requester_name is null or length(requester_name) <= 120)
    and (requester_phone is null or length(requester_phone) <= 40))
);
--> statement-breakpoint
-- The board snapshot: open jobs by lane, in lane order (decision 2a-1).
create index if not exists jobs_board_idx
  on farm.jobs using btree (business_line, priority, sort_key)
  where status not in ('done', 'invoiced', 'cancelled');
--> statement-breakpoint
create index if not exists jobs_field_id_idx on farm.jobs using btree (field_id);
--> statement-breakpoint
create index if not exists jobs_customer_party_id_idx on farm.jobs using btree (customer_party_id);
--> statement-breakpoint
create index if not exists jobs_requested_by_party_id_idx
  on farm.jobs using btree (requested_by_party_id);
--> statement-breakpoint
-- A request link's requests per farm day (REQUEST_LINK_MAX_PER_DAY).
create index if not exists jobs_request_link_id_created_at_idx
  on farm.jobs using btree (request_link_id, created_at);
--> statement-breakpoint

-- Who and what is on a job: a person (party_id: a crew party; app_users is one-to-one with
-- party), a machine, or both on one row ("SP2 run by Dale", decision 2a-4). One row per person
-- and one per machine on a job (partial unique indexes).
create table if not exists farm.job_assignments (
  id uuid primary key default gen_random_uuid() not null,
  job_id uuid not null,
  party_id uuid,
  machine_id uuid,
  role text default 'crew' not null,
  planned_for tstzrange,
  assigned_by uuid,
  created_at timestamp with time zone default now() not null,
  constraint job_assignments_who_check check (party_id is not null or machine_id is not null),
  constraint job_assignments_role_check check (role in ('operator', 'crew')),
  constraint job_assignments_planned_for_check check (
    planned_for is null or not isempty(planned_for))
);
--> statement-breakpoint
create unique index if not exists job_assignments_job_id_party_id_key
  on farm.job_assignments using btree (job_id, party_id) where party_id is not null;
--> statement-breakpoint
create unique index if not exists job_assignments_job_id_machine_id_key
  on farm.job_assignments using btree (job_id, machine_id) where machine_id is not null;
--> statement-breakpoint
create index if not exists job_assignments_party_id_idx
  on farm.job_assignments using btree (party_id);
--> statement-breakpoint
create index if not exists job_assignments_machine_id_idx
  on farm.job_assignments using btree (machine_id);
--> statement-breakpoint

-- Products on a job with their rate (a rate per acre, *_ac, or a total).
create table if not exists farm.job_products (
  id uuid primary key default gen_random_uuid() not null,
  job_id uuid not null,
  product_id uuid not null,
  rate numeric(12, 4),
  unit text,
  supplied_by text default 'us' not null,
  created_at timestamp with time zone default now() not null,
  constraint job_products_job_id_product_id_key unique (job_id, product_id),
  constraint job_products_rate_check check (rate is null or rate >= 0),
  constraint job_products_unit_check check (
    unit is null or unit in ('gal_ac', 'qt_ac', 'pt_ac', 'floz_ac', 'lb_ac', 'oz_ac', 'ton_ac',
                             'unit_ac', 'kseed_ac', 'gal', 'lb', 'ton', 'unit')),
  constraint job_products_supplied_by_check check (supplied_by in ('us', 'customer'))
);
--> statement-breakpoint
create index if not exists job_products_product_id_idx
  on farm.job_products using btree (product_id);
--> statement-breakpoint

-- ============================================================================================
-- rights-usage: data-rights agreements and usage events
-- ============================================================================================

-- A customer's signed data-rights agreement (D17). party_id = the customer ORG party (the one
-- customerOrgParty resolves for a Deere org). document_key = a key in the private uploads
-- bucket. Counts while revoked_on is null.
create table if not exists farm.data_rights_agreements (
  id uuid primary key default gen_random_uuid() not null,
  party_id uuid not null,
  signed_on date not null,
  document_key text,
  permitted_uses text[] default '{}'::text[] not null,
  revoked_on date,
  notes text,
  created_by uuid,
  source text default 'app' not null,
  source_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint data_rights_agreements_source_source_id_key unique (source, source_id),
  constraint data_rights_agreements_permitted_uses_check check (
    permitted_uses <@ array['billing', 'agronomy', 'prospecting', 'landlord_sharing']::text[]),
  constraint data_rights_agreements_revoked_on_check check (
    revoked_on is null or revoked_on >= signed_on)
);
--> statement-breakpoint
create index if not exists data_rights_agreements_party_id_idx
  on farm.data_rights_agreements using btree (party_id);
--> statement-breakpoint

-- Who used the app when, for the Phase 2 gate report (/admin/usage). At most one row per device
-- + person + kind + route per 5 minutes: the writer inserts `on conflict (actor_key, kind,
-- route, bucket_at) do nothing`. actor_key = '<device id or ->:<app user id or ->' at write
-- time, so a person or device deleted later (set null below) never collides with another row.
-- farm_day = the America/Detroit date of `at`; bucket_at = `at` floored to 5 minutes.
create table if not exists app.usage_events (
  id uuid primary key default gen_random_uuid() not null,
  at timestamp with time zone default now() not null,
  farm_day date not null,
  kind text not null,
  route text default '' not null,
  app_user_id uuid,
  device_id uuid,
  actor_key text not null,
  bucket_at timestamp with time zone not null,
  constraint usage_events_bucket_key unique (actor_key, kind, route, bucket_at),
  constraint usage_events_kind_check check (
    kind in ('page_view', 'board_heartbeat', 'pin_sign_in', 'job_action', 'morning_run')),
  constraint usage_events_route_check check (length(route) <= 200),
  constraint usage_events_actor_key_check check (
    actor_key ~ '^([0-9a-f-]{36}|-):([0-9a-f-]{36}|-)$'),
  constraint usage_events_bucket_at_check check (bucket_at <= at)
);
--> statement-breakpoint
create index if not exists usage_events_farm_day_idx on app.usage_events using btree (farm_day);
--> statement-breakpoint
create index if not exists usage_events_app_user_id_idx
  on app.usage_events using btree (app_user_id);
--> statement-breakpoint
create index if not exists usage_events_device_id_idx on app.usage_events using btree (device_id);
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
      ('farm.job_request_links', 'job_request_links_party_id_parties_id_fk',
       'foreign key (party_id) references farm.parties (id) on delete restrict'),
      ('farm.job_request_links', 'job_request_links_created_by_app_users_id_fk',
       'foreign key (created_by) references farm.app_users (id) on delete set null'),
      ('farm.jobs', 'jobs_customer_party_id_parties_id_fk',
       'foreign key (customer_party_id) references farm.parties (id) on delete restrict'),
      ('farm.jobs', 'jobs_field_id_fields_id_fk',
       'foreign key (field_id) references farm.fields (id) on delete set null'),
      ('farm.jobs', 'jobs_requested_by_party_id_parties_id_fk',
       'foreign key (requested_by_party_id) references farm.parties (id) on delete restrict'),
      ('farm.jobs', 'jobs_request_link_id_job_request_links_id_fk',
       'foreign key (request_link_id) references farm.job_request_links (id) on delete set null'),
      ('farm.jobs', 'jobs_created_by_app_users_id_fk',
       'foreign key (created_by) references farm.app_users (id) on delete set null'),
      ('farm.jobs', 'jobs_updated_by_app_users_id_fk',
       'foreign key (updated_by) references farm.app_users (id) on delete set null'),
      ('farm.job_assignments', 'job_assignments_job_id_jobs_id_fk',
       'foreign key (job_id) references farm.jobs (id) on delete cascade'),
      ('farm.job_assignments', 'job_assignments_party_id_parties_id_fk',
       'foreign key (party_id) references farm.parties (id) on delete restrict'),
      ('farm.job_assignments', 'job_assignments_machine_id_machines_id_fk',
       'foreign key (machine_id) references farm.machines (id) on delete restrict'),
      ('farm.job_assignments', 'job_assignments_assigned_by_app_users_id_fk',
       'foreign key (assigned_by) references farm.app_users (id) on delete set null'),
      ('farm.job_products', 'job_products_job_id_jobs_id_fk',
       'foreign key (job_id) references farm.jobs (id) on delete cascade'),
      ('farm.job_products', 'job_products_product_id_products_id_fk',
       'foreign key (product_id) references farm.products (id) on delete restrict'),
      ('farm.data_rights_agreements', 'data_rights_agreements_party_id_parties_id_fk',
       'foreign key (party_id) references farm.parties (id) on delete restrict'),
      ('farm.data_rights_agreements', 'data_rights_agreements_created_by_app_users_id_fk',
       'foreign key (created_by) references farm.app_users (id) on delete set null'),
      ('app.usage_events', 'usage_events_app_user_id_app_users_id_fk',
       'foreign key (app_user_id) references farm.app_users (id) on delete set null'),
      ('app.usage_events', 'usage_events_device_id_devices_id_fk',
       'foreign key (device_id) references farm.devices (id) on delete set null')
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
grant select, insert, update, delete on all tables in schema farm, app to farm_app;
--> statement-breakpoint

comment on table farm.products is 'Seed, chemicals, fertilizer and fuel put on fields (2a); label_rules feeds 2b go/no-go. Retired with active = false.';
--> statement-breakpoint
comment on table farm.jobs is 'Farm work on the job board (2a): kind, business line (lane), status machine, field, window, planned acres/qty, priority; version = optimistic concurrency counter bumped by every write to the job or its child rows.';
--> statement-breakpoint
comment on column farm.jobs.planned_window is 'When the work should happen, [from, to) (plan §4 calls it window, a reserved word in SQL); null = not scheduled.';
--> statement-breakpoint
comment on column farm.jobs.version is 'Optimistic concurrency: every write to the job or its assignments/products is a compare-and-set on this value, in the same transaction (decision 2a-7).';
--> statement-breakpoint
comment on column farm.jobs.planned_acres is 'Snapshot of the field''s current boundary acres when the field is set, unless planned_acres_by_hand (decision 2a-5).';
--> statement-breakpoint
comment on column farm.jobs.crop_year is 'The crop season the work belongs to: set with the field from its growing year, else the calendar year (decision 2a-6, D23).';
--> statement-breakpoint
comment on table farm.job_assignments is 'Who and what is on a job (2a): a crew party, a machine, or both on one row (operator of that machine).';
--> statement-breakpoint
comment on table farm.job_products is 'Products on a job with their rate and who supplies them (2a).';
--> statement-breakpoint
comment on table farm.job_request_links is 'Revocable per-customer request links /r/<token> (2a stretch; LAN-only until MD); only the token HMAC is stored.';
--> statement-breakpoint
comment on table farm.data_rights_agreements is 'Signed data-rights agreements per customer org party (D17, 2a); a Deere customer org is read in sandbox/live only while its party has an unrevoked one.';
--> statement-breakpoint
comment on table app.usage_events is 'Who used the app when (2a, Phase 2 gate report): at most one row per device + person + kind + route per 5 minutes; kept 400 days.';
