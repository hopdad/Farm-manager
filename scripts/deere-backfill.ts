/**
 * pnpm deere:backfill --seasons=2022-2026 [--replace] [--dry-run]   (DEFERRED; see below)
 *
 * DEFERRED (Derrick, Oct 31, 2026: "defer it but don't scrap it"; docs/contracts-1f.md
 * "Deferred: Deere season backfill", decision D22): not built in slice 1f. It will pull past
 * seeding and harvest operations by crop season from every connected Deere org (sim, replay or
 * sandbox: CONNECTOR_DEERE), store them in farm.operations and derive farm.field_seasons rows
 * (crop, variety, planted_on, harvested_on, yield_bu_ac; source 'deere') with decision 1f-1: a
 * season is written when the field has none for that crop year or the existing row's source is
 * 'demo' or 'deere'; 'import' and 'app' rows are kept unless --replace, and every skipped conflict
 * is listed in the report. It runs its work inside `withCallStream('backfill', …)`
 * (src/connectors/http.ts), so its calls count under the `backfill` stream. It reuses deere-ops'
 * operations mapping (src/connectors/deere/ops/) and src/domain/crops.ts (heavy work is CLI-only:
 * plan §1).
 *
 * Until then it prints that it is deferred and exits 0.
 */
console.log(
  'deere:backfill: deferred (not built in slice 1f; docs/contracts-1f.md "Deferred: Deere season backfill")',
);
