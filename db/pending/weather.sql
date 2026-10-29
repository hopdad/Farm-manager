-- weather (M1 1b, docs/contracts-m1.md §13): the index the weather.nws job's forecast retention
-- needs. Pruning deletes farm.weather_forecasts rows of old issues EXCEPT those a stored
-- assessment used:
--   not exists (select 1 from farm.spray_assessments s
--                where s.grid_id = f.grid_id and s.forecast_issued_at = f.issued_at
--                  and s.for_hour = f.valid_at)
-- Without an index on those three columns the anti-join sorts every assessment (about 4.5
-- million rows at 500 fields and 30 days of detail) for each 5 000-row batch; with it, each
-- candidate forecast row is one index-only probe. EXPLAIN ANALYZE on a 500-field fixture (Oct 29,
-- 475k assessments, 200k forecast rows): 26 ms (nested loop anti join, index only scan) with the
-- index, 341 ms and an 18 MB on-disk sort (merge anti join over a seq scan) without.
-- The assessment retention needs nothing new: its semi-join uses spray_assessments_field_id_for_hour_idx.
-- Drizzle mirror (src/db/schema/farm.ts, sprayAssessments):
--   index('spray_assessments_grid_id_forecast_issued_at_for_hour_idx')
--     .on(t.gridId, t.forecastIssuedAt, t.forHour)
create index if not exists spray_assessments_grid_id_forecast_issued_at_for_hour_idx
  on farm.spray_assessments using btree (grid_id, forecast_issued_at, for_hour);
