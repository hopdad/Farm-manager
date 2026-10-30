-- Forecast staleness counts from the last NWS check. Same rules as 0000-0005: runs as
-- `postgres` (NOSUPERUSER on Supabase and locally), no extensions, no pg_cron/pg_net, every
-- statement re-runnable.
--
--   1b  farm.weather_grids.forecast_checked_at: when the weather.nws job last fetched the cell's
--       forecast from NWS successfully (a new issue or the same one again). Spray go/no-go
--       counted staleness from the issue time (NWS `updateTime`), which on live NWS is routinely
--       hours old right after a good fetch, so every hour said `forecast_stale`. Now a forecast
--       is current as of the later of the two (src/domain/spray.ts `forecastStaleness`). Null:
--       never recorded (cells cached before this migration): staleness falls back to the issue
--       time until the job's next good run.
--       farm.weather_grids.forecast_checked_issue: the issue (issued_at) NWS served at that check.
--       The check vouches only for that issue: a spray row still built from an older, replaced
--       issue (the spray pass failed after a newer issue landed) counts from its own issue time.
--       Both mirrored in src/db/schema/farm.ts (weatherGrids). farm_app's table grants (0000
--       default privileges, 0003) cover the new columns.

alter table farm.weather_grids add column if not exists forecast_checked_at timestamp with time zone;
--> statement-breakpoint
alter table farm.weather_grids add column if not exists forecast_checked_issue timestamp with time zone;
--> statement-breakpoint
comment on column farm.weather_grids.forecast_checked_at is
  'Last successful NWS fetch of this cell''s forecast by weather.nws (new issue or the same again); forecast staleness counts from the later of this and the issue time, for the issue in forecast_checked_issue only. Null: never recorded.';
--> statement-breakpoint
comment on column farm.weather_grids.forecast_checked_issue is
  'The forecast issue (issued_at) NWS served at forecast_checked_at: the one issue that check vouches for.';
