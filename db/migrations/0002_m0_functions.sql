-- M0 migration 3 of 3: shared SQL functions (plan §1 "The seams", §4 "Key SQL objects") and
-- explicit grants. Identical on the PC and on Supabase.

-- Realtime publish: one function, correct in both places. Supabase has realtime.send (private
-- Broadcast channels); the local image doesn't, so it falls back to pg_notify('app_events'),
-- which the local SSE route LISTENs on. Every message carries a per-topic `seq`.
-- Payloads stay under ~8 KB (pg_notify's limit); the TS wrapper sends `invalidate` instead.
create or replace function app.publish(p_topic text, p_event text, p_payload jsonb)
returns void language plpgsql as $$
declare v_seq bigint;
begin
  insert into app.topic_seq as t (topic, seq) values (p_topic, 1)
  on conflict (topic) do update set seq = t.seq + 1
  returning t.seq into v_seq;
  p_payload := p_payload || jsonb_build_object('seq', v_seq);
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    execute 'select realtime.send($1,$2,$3,true)' using p_payload, p_event, p_topic;  -- Supabase
  else
    perform pg_notify('app_events',
      json_build_object('topic',p_topic,'event',p_event,'payload',p_payload)::text); -- your PC
  end if;
end $$;
--> statement-breakpoint
comment on function app.publish(text, text, jsonb) is
  'Publish {topic, event, payload+seq}: realtime.send on Supabase, pg_notify(''app_events'') locally.';
--> statement-breakpoint

-- Create or update the sync_state row for a stream (job registration / mode change).
create or replace function app.ensure_stream(p_source text, p_stream text, p_mode text default 'sim')
returns void
language sql
volatile
set search_path = pg_catalog, pg_temp
as $$
  insert into ingest.sync_state (source, stream, mode)
  values (p_source, p_stream, p_mode)
  on conflict (source, stream) do update
    set mode = excluded.mode, updated_at = now()
    where ingest.sync_state.mode is distinct from excluded.mode;
$$;
--> statement-breakpoint

-- Claim a stream's lease with a single UPDATE ... RETURNING. Returns the row (with a fresh
-- lease_token) when the stream is not 'off', no unexpired lease is held and next_run_at has
-- passed; otherwise no row. Concurrent callers serialize on the row lock and re-check the
-- WHERE clause, so exactly one wins.
create or replace function app.claim_due(p_source text, p_stream text, p_lease_seconds integer)
returns setof ingest.sync_state
language sql
volatile
set search_path = pg_catalog, pg_temp
as $$
  update ingest.sync_state s
     set lease_until = now() + make_interval(secs => p_lease_seconds),
         lease_token = gen_random_uuid(),
         last_run_at = now(),
         updated_at = now()
   where s.source = p_source
     and s.stream = p_stream
     and p_lease_seconds > 0
     and s.mode <> 'off'
     and (s.lease_until is null or s.lease_until <= now())
     and (s.next_run_at is null or s.next_run_at <= now())
  returning s.*;
$$;
--> statement-breakpoint

-- Release a lease held with `p_lease_token`, recording the outcome. Returns false when the
-- token no longer matches (the lease expired and someone else claimed it).
create or replace function app.release_lease(
  p_source text,
  p_stream text,
  p_lease_token uuid,
  p_ok boolean,
  p_error text default null,
  p_next_run_at timestamptz default null
)
returns boolean
language sql
volatile
set search_path = pg_catalog, pg_temp
as $$
  with released as (
    update ingest.sync_state s
       set lease_until = null,
           lease_token = null,
           next_run_at = p_next_run_at,
           last_ok_at = case when p_ok then now() else s.last_ok_at end,
           last_error = case when p_ok then s.last_error else p_error end,
           last_error_at = case when p_ok then s.last_error_at else now() end,
           updated_at = now()
     where s.source = p_source
       and s.stream = p_stream
       and s.lease_token = p_lease_token
    returning 1
  )
  select exists (select 1 from released);
$$;
--> statement-breakpoint

-- Field boundaries as a Mapbox Vector Tile (layer 'fields'), for /api/tiles/fields/{z}/{x}/{y}.
-- Properties: id, name, acres, tenure, farm_id. Returns '' (empty tile) when nothing intersects.
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
           f.farm_id::text as farm_id
      from farm.current_boundaries b
      join farm.fields f on f.id = b.field_id
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
  'MVT tile of current field boundaries, layer ''fields'' (id, name, acres, tenure, farm_id).';
--> statement-breakpoint

-- Explicit grants (default privileges from migration 0000 already cover these; repeated so the
-- intent is visible and objects created before the defaults are covered too).
grant select, insert, update, delete on all tables in schema farm, gis, ingest, app to farm_app;
--> statement-breakpoint
grant usage, select, update on all sequences in schema farm, gis, ingest, app to farm_app;
--> statement-breakpoint
grant execute on all functions in schema app to farm_app;
