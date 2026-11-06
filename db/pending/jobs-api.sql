-- Slice 2a, jobs-api: the jobs publish triggers (decision 2a-8; docs/contracts-2a.md §6).
-- Waiting here until the integrator folds it into the next migration (0009_m2a_triggers or the
-- next free number). Idempotent: functions are `create or replace`, triggers `drop if exists` +
-- `create`, so `pnpm db:pending` and every test clone may apply it again (db/pending/README.md).
--
-- Every change to farm.jobs, farm.job_assignments or farm.job_products publishes ONE realtime
-- message per statement per event on topic `jobs` (never one per row, never `fleet` or
-- `fields`), through app.publish, delivered on commit (nothing on rollback):
--
--   jobs/updated     { jobIds, fieldIds, machineIds, partyIds }: ids only, each list sorted and
--                    deduplicated. fieldIds: the old AND new field of every changed job (a card
--                    leaving a field updates that field too) and, for a child row, its job's
--                    current field. machineIds / partyIds: from the changed assignment rows (old
--                    and new); a job or product row names none.
--   jobs/invalidate  { event: 'updated', reason: 'too_large' } instead, when the payload's jsonb
--                    text would pass 7,000 bytes (JOBS_TRIGGER_MAX_PAYLOAD_BYTES,
--                    src/domain/work-jobs.ts: room under MAX_PAYLOAD_BYTES 7,500 for the seq and
--                    the NOTIFY wrapper; pg_notify refuses 8,000).
--
-- Nine statement-level AFTER triggers, one per event per table (Postgres refuses transition
-- tables on a trigger with more than one event), all calling app.publish_jobs_changes(), which
-- branches on TG_TABLE_NAME and TG_OP and reads only the transition tables its event declares
-- (PL/pgSQL plans a statement the first time it runs, so the other branches' names are fine). A
-- statement that changes no row publishes nothing. One statement can still send more than one
-- message: an `insert … on conflict do update` fires its insert and its update triggers (each
-- sees only its own rows), and a job delete cascades to the children's delete triggers (up to
-- three messages). Subscribers coalesce refetches, so that costs nothing visible.
--
-- Quiet while `app.jobs_publish` = 'off' (data:import sets it for its transaction and publishes
-- one jobs/invalidate { reason: 'changed' } at the end).
--
-- Lock order (contracts-2a §4.7): app.publish upserts the app.topic_seq('jobs') row, which stays
-- locked until commit, so every job writer queues on it from its first job statement. Writers
-- take the job row first (the CAS update, or `select … for update` in id order for several
-- jobs), then the topic row through these triggers.
--
-- Functions live in schema app, are SECURITY INVOKER (app.publish is the SECURITY DEFINER one)
-- and pin search_path; farm_app gets EXECUTE on the callable ones.

-- The payload: sorted, deduplicated, non-null ids (pure).
create or replace function app.publish_jobs_payload(
  p_job_ids uuid[], p_field_ids uuid[], p_machine_ids uuid[], p_party_ids uuid[])
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'jobIds', coalesce((select jsonb_agg(x order by x)
                          from (select distinct x from unnest(p_job_ids) x where x is not null) d),
                       '[]'::jsonb),
    'fieldIds', coalesce((select jsonb_agg(x order by x)
                            from (select distinct x from unnest(p_field_ids) x where x is not null) d),
                         '[]'::jsonb),
    'machineIds', coalesce((select jsonb_agg(x order by x)
                              from (select distinct x from unnest(p_machine_ids) x
                                     where x is not null) d),
                           '[]'::jsonb),
    'partyIds', coalesce((select jsonb_agg(x order by x)
                            from (select distinct x from unnest(p_party_ids) x where x is not null) d),
                         '[]'::jsonb))
$$;
--> statement-breakpoint
revoke execute on function app.publish_jobs_payload(uuid[], uuid[], uuid[], uuid[]) from public;
--> statement-breakpoint
grant execute on function app.publish_jobs_payload(uuid[], uuid[], uuid[], uuid[]) to farm_app;
--> statement-breakpoint
comment on function app.publish_jobs_payload(uuid[], uuid[], uuid[], uuid[]) is
  'The jobs/updated payload {jobIds, fieldIds, machineIds, partyIds}: sorted, deduplicated, non-null ids (2a, decision 2a-8).';
--> statement-breakpoint

-- One jobs/updated with these ids, or jobs/invalidate {event: updated, reason: too_large} when
-- the payload text would pass 7,000 bytes (JOBS_TRIGGER_MAX_PAYLOAD_BYTES).
create or replace function app.publish_jobs_updated(
  p_job_ids uuid[], p_field_ids uuid[], p_machine_ids uuid[], p_party_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_payload jsonb := app.publish_jobs_payload(p_job_ids, p_field_ids, p_machine_ids, p_party_ids);
begin
  if octet_length(v_payload::text) > 7000 then
    perform app.publish('jobs', 'invalidate',
                        jsonb_build_object('event', 'updated', 'reason', 'too_large'));
  else
    perform app.publish('jobs', 'updated', v_payload);
  end if;
end
$$;
--> statement-breakpoint
revoke execute on function app.publish_jobs_updated(uuid[], uuid[], uuid[], uuid[]) from public;
--> statement-breakpoint
grant execute on function app.publish_jobs_updated(uuid[], uuid[], uuid[], uuid[]) to farm_app;
--> statement-breakpoint
comment on function app.publish_jobs_updated(uuid[], uuid[], uuid[], uuid[]) is
  'Publish jobs/updated with these ids, or jobs/invalidate {event: updated, reason: too_large} over 7,000 bytes (2a, decision 2a-8).';
--> statement-breakpoint

-- The one trigger function of the nine triggers below.
create or replace function app.publish_jobs_changes()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_jobs uuid[];
  v_fields uuid[];
  v_machines uuid[];
  v_parties uuid[];
begin
  if current_setting('app.jobs_publish', true) = 'off' then
    return null;
  end if;

  if TG_TABLE_NAME = 'jobs' then
    if TG_OP = 'INSERT' then
      select array_agg(r.id), array_agg(r.field_id) into v_jobs, v_fields from new_rows r;
    elsif TG_OP = 'UPDATE' then
      select array_agg(r.id), array_agg(r.field_id) into v_jobs, v_fields
        from (select n.id, n.field_id from new_rows n
              union all
              select o.id, o.field_id from old_rows o) r;
    else
      select array_agg(r.id), array_agg(r.field_id) into v_jobs, v_fields from old_rows r;
    end if;
  elsif TG_TABLE_NAME = 'job_assignments' then
    if TG_OP = 'INSERT' then
      select array_agg(r.job_id), array_agg(r.machine_id), array_agg(r.party_id)
        into v_jobs, v_machines, v_parties
        from new_rows r;
    elsif TG_OP = 'UPDATE' then
      select array_agg(r.job_id), array_agg(r.machine_id), array_agg(r.party_id)
        into v_jobs, v_machines, v_parties
        from (select n.job_id, n.machine_id, n.party_id from new_rows n
              union all
              select o.job_id, o.machine_id, o.party_id from old_rows o) r;
    else
      select array_agg(r.job_id), array_agg(r.machine_id), array_agg(r.party_id)
        into v_jobs, v_machines, v_parties
        from old_rows r;
    end if;
  elsif TG_TABLE_NAME = 'job_products' then
    if TG_OP = 'INSERT' then
      select array_agg(r.job_id) into v_jobs from new_rows r;
    elsif TG_OP = 'UPDATE' then
      select array_agg(r.job_id) into v_jobs
        from (select n.job_id from new_rows n union all select o.job_id from old_rows o) r;
    else
      select array_agg(r.job_id) into v_jobs from old_rows r;
    end if;
  else
    raise exception 'app.publish_jobs_changes: unexpected table %', TG_TABLE_NAME;
  end if;

  -- An empty transition table: the statement changed nothing, so nothing is published.
  if v_jobs is null then
    return null;
  end if;
  if TG_TABLE_NAME <> 'jobs' then
    -- A child row's card lives on its job's field (gone already when the job itself was deleted:
    -- the jobs delete trigger names that field).
    select array_agg(j.field_id) into v_fields from farm.jobs j where j.id = any(v_jobs);
  end if;

  perform app.publish_jobs_updated(v_jobs, v_fields, v_machines, v_parties);
  return null;
end
$$;
--> statement-breakpoint
comment on function app.publish_jobs_changes() is
  'Statement-level AFTER trigger of farm.jobs, farm.job_assignments and farm.job_products: one jobs/updated (or invalidate) per statement per event; quiet while app.jobs_publish = off (2a, decision 2a-8).';
--> statement-breakpoint

drop trigger if exists jobs_publish_insert on farm.jobs;
--> statement-breakpoint
create trigger jobs_publish_insert
  after insert on farm.jobs
  referencing new table as new_rows
  for each statement execute function app.publish_jobs_changes();
--> statement-breakpoint
drop trigger if exists jobs_publish_update on farm.jobs;
--> statement-breakpoint
create trigger jobs_publish_update
  after update on farm.jobs
  referencing old table as old_rows new table as new_rows
  for each statement execute function app.publish_jobs_changes();
--> statement-breakpoint
drop trigger if exists jobs_publish_delete on farm.jobs;
--> statement-breakpoint
create trigger jobs_publish_delete
  after delete on farm.jobs
  referencing old table as old_rows
  for each statement execute function app.publish_jobs_changes();
--> statement-breakpoint

drop trigger if exists job_assignments_publish_insert on farm.job_assignments;
--> statement-breakpoint
create trigger job_assignments_publish_insert
  after insert on farm.job_assignments
  referencing new table as new_rows
  for each statement execute function app.publish_jobs_changes();
--> statement-breakpoint
drop trigger if exists job_assignments_publish_update on farm.job_assignments;
--> statement-breakpoint
create trigger job_assignments_publish_update
  after update on farm.job_assignments
  referencing old table as old_rows new table as new_rows
  for each statement execute function app.publish_jobs_changes();
--> statement-breakpoint
drop trigger if exists job_assignments_publish_delete on farm.job_assignments;
--> statement-breakpoint
create trigger job_assignments_publish_delete
  after delete on farm.job_assignments
  referencing old table as old_rows
  for each statement execute function app.publish_jobs_changes();
--> statement-breakpoint

drop trigger if exists job_products_publish_insert on farm.job_products;
--> statement-breakpoint
create trigger job_products_publish_insert
  after insert on farm.job_products
  referencing new table as new_rows
  for each statement execute function app.publish_jobs_changes();
--> statement-breakpoint
drop trigger if exists job_products_publish_update on farm.job_products;
--> statement-breakpoint
create trigger job_products_publish_update
  after update on farm.job_products
  referencing old table as old_rows new table as new_rows
  for each statement execute function app.publish_jobs_changes();
--> statement-breakpoint
drop trigger if exists job_products_publish_delete on farm.job_products;
--> statement-breakpoint
create trigger job_products_publish_delete
  after delete on farm.job_products
  referencing old table as old_rows
  for each statement execute function app.publish_jobs_changes();
