/**
 * pnpm deere:backfill --seasons=2022-2026 [--replace] [--dry-run]   (slice 1f; owner: deere-ops)
 *
 * To build (docs/contracts-1f.md §9): pull past seeding and harvest operations by crop season
 * from every connected Deere org (sim, replay or sandbox: CONNECTOR_DEERE), store them in
 * farm.operations and derive farm.field_seasons rows (crop, variety, planted_on, harvested_on,
 * yield_bu_ac; source 'deere') with decision 1: a season is written when the field has none for
 * that crop year or the existing row's source is 'demo' or 'deere'; 'import' and 'app' rows are
 * kept unless --replace, and every skipped conflict is listed in the report. The mapping lives in
 * src/connectors/deere/ops/ and the crop normalization in src/domain/crops.ts, shared with the
 * deere.ops job (heavy work is CLI-only: plan §1).
 *
 * Foundation stub: prints "not built yet" and exits 0.
 */
console.log('deere:backfill: not built yet (slice 1f, deere-ops builder)');
