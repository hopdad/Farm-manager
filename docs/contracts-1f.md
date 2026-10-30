# Contracts for slice 1f "Live connectors + sync health" (parallel builders)

Oct 30, 2026 · written by the 1f foundation stage, amended the same day after two contract
reviews (33 items, all accepted), then amended again for **multi-vendor telematics** (part B:
slice 1f.2, three more builders; the 1f part below says where vendor-neutrality changed it,
marked **1f.2**) · companion to `docs/build-plan.md` (§4 rows
`farm.operations`, `farm.pins`, `farm.machine_hours` / `farm.machine_faults`; §5 Deere and trucks
rows, ports, sync step, replay, stand-in; §6 1f; §8 D3, D6, D9, D19), `docs/contracts.md` (M0)
and `docs/contracts-m1.md` (M1). Both are **still binding** except where this page says
otherwise.

Four builders (part A, §1-§12) and then three more (part B, §B.1-§B.11) work in parallel, each in
its own git worktree off `claude/m1-1f`. This page is the only agreement between them: who owns which paths, the ports and databases, the rules for
shared files, and every contract (the TypeScript files in `src/` plus the SQL of migration
`0007_m1f_live_connectors`). If a contract doesn't fit, **don't change it in place**: work around
it and say exactly what you need in your report. The integrator merges, resolves the one-line
conflicts, wires the shared pieces and owns the final layout.

**The target (cloud side).** Without a Deere app, the whole Deere flow runs in `replay` (OAuth
skipped) and in `sim` (the stand-in): fields and boundaries, machines with engine hours, flags as
read-only pins, operations with coverage, and backfilled seasons 2022-2026, all on the board and
the field panel. Trucks stay simulated; Samsara fault codes reach the fleet panel.
`/admin/connectors` shows per-source call counts, the budget, the Deere connection and
org-approval status, dead letters you can requeue, and the doc-derived list. The sandbox and live
code paths exist and are unit and contract tested against the stand-in; they run for real only on
Derrick's PC once he has a Deere app.

**Out of scope for part A (don't build):** MD and production (Supabase adapters, the production
redirect, production webhooks, write-back on), M2 (Work Plans, outbox, `job_operations`, pin
drawing and photos, customer-org field matching), 1g (`tracks_daily`, raw retention), every vendor
other than Deere and Samsara (part B's builders), anything in `tools/gis/**` or the `gis` schema
(slice 1e is being built on the PC).

---

## 1. Who owns what

| Key | Builds (brief, plan §6 1f) | Owns (may create and edit) | Next / stand-in | Dev database |
|---|---|---|---|---|
| **deere-data** | `deere.fields` job (hourly; 45 s demo cadence in sim/replay), per connected org (§5.4): farms (doc-derived; customer orgs' farms get that org's party, decision 8), fields (match order and the columns the sync owns, §5.7), boundaries (the **Deere boundary writer**, §5.7, decision 7), flags → `farm.pins` (read-only, `source = 'deere_flag'`), equipment → `farm.machines` rows for unmapped Deere machines **of the home org only** (decision 8; unmappable kinds listed once, §5.7), engine hours → `machines.engine_hours` + `farm.machine_hours` (source `deere`, in its own query, §5.0). Stand-in routes (the `fields` module, §7.1) for farms, fields (shadowing the core's minimal listing), boundaries, flags and engine hours, consistent with the demo seed so sim mode matches the seeded fields through external refs, never duplicates them, plus one Deere-only field the seed doesn't have (the creation path); sim world flags. Replay fixtures for what's missing. `GET /api/pins` (viewer), a read-only "Deere flags" map layer in the rail (§5.2), the pin popup on the board and the phone through the map's tap seam (§5.2), publishing `pins`/`updated` | `src/jobs/deere-fields*.ts`, `src/connectors/deere/fields/**`, `src/db/queries/{deere-fields,pins,machine-hours}*.ts`, `src/sim/vendors/deere/fields-*.ts`, `src/sim/farm/flags*.ts` (new pure module, §7.4), `src/app/api/pins/**`, `src/ui/pins/**`, `src/ui/map/layers/pins*.ts`, `e2e/deere-fields*.spec.ts`; **plus (assigned, §1.2, §1.3)** the 1a Deere fixture builder `src/connectors/deere/fixtures/{build,write,fixtures.test}.ts` with the 1a `fixtures/doc-derived/*/01-*.json`, new fixture files numbered `20`-`29` (§8), and `src/connectors/deere/replay.contract.test.ts` | 3111 / 4021 | `farm_dev_deere_data` |
| **deere-ops** | `farm.operations` writer, `deere.ops` job (15 min; 20 s demo cadence): this crop season's operations per field with measurements, products and coverage (simplified MultiPolygon), at most the per-run field cap under a budget (§5.5, the fields checked longest ago first). Stand-in operations (the `ops` module, §7.1) from the demo world's day reports (a finished field emits an operation) and, for past seasons, from `src/sim/seasons.ts`. Historical replay fixtures for seeding and harvest 2022-2026 on the demo fields, with the replay **no-shift** option (§8). `deere:backfill --seasons=2022-2026` (decision 1, season ids §5.1; mapping shared from `src/connectors/deere/ops/`; crop normalization moved to `src/domain/crops.ts` so jobs and the CLI share it). Field panel: this season's operations in the History tab, backfilled seasons shown with their source | `src/jobs/deere-ops*.ts`, `src/connectors/deere/ops/**`, `src/db/queries/{operations,deere-seasons}*.ts`, `src/domain/crops*.ts`, `scripts/deere-backfill*.ts`, `src/sim/vendors/deere/ops-*.ts`, `src/app/api/fields/[id]/operations/**`, `src/ui/fields/tabs/history*.tsx`, `src/ui/fields/operations*.ts(x)`, `e2e/deere-ops*.spec.ts`, new fixture files numbered `30`-`39` (§8); **plus (assigned, §1.2)** in `src/connectors/replay.ts` the `noShift` option only, and in `tools/import/seasons-csv.ts` replacing `normalizeCrop` with a re-export from `src/domain/crops.ts` only | 3112 / 4022 | `farm_dev_deere_ops` |
| **fleet-faults** | Samsara fault codes end to end: schemas, client, its own `faults` stream, mapper with decision 2, `farm.machine_faults` history plus the current summary on `machine_state` with a time guard, the stand-in `faultCodes` feed type, a breakdown-scenario semi fault and a control knob, a doc-derived replay fixture; `fleet`/`invalidate` reason `faults`. **1f.2:** the fault writer takes the one fault model (§5.3: J1939, OBD-II and OEM codes; `snapshot` and `delta` reports), so part B's vendors land through it unchanged. Fleet panel: fault badge, the critical-fault mark-down prompt, a per-machine vendor + mode badge from the vendor registry (`vendorLabel(position.vendor)` · the mode of `connectionOf(vendor)`: "Samsara · sim", "Kubota (AEMP) · sim"; any vendor id, §5.3), and Deere-only machines that stopped working show "Last working position, N min ago" instead of a stale alarm (the panel only; §5.3); engine hours, odometer and fuel on each row through `formatVehicleStat` (§5.3: "not reported" where the route doesn't report it). The `stats_at` time guard for fuel (contracts.md open item). Samsara engine hours and odometer readings → `farm.machine_hours` (source `samsara`) in `upsertVehicleStat` | `src/connectors/samsara/**` (except `replay-recorded.ts`, and part B's `equipment*.ts`, `vehicles*.ts`), `src/sim/vendors/samsara/**` (except `modules.ts` and part B's `equipment-routes*.ts`, `vehicles-routes*.ts`), `src/jobs/fleet.ts` (Samsara only since 1f.2), `src/jobs/fleet-shared.ts`, `src/db/queries/fleet*.ts`, `src/db/queries/machine-faults*.ts`, `src/ui/fleet/**` except `contract.ts`, `src/app/api/machines/**`, `e2e/fleet-panel*.spec.ts`, `e2e/fleet-faults*.spec.ts`; **plus (assigned, §1.2, §1.3)** the `samsara` line of `WEBHOOK_NUDGES` in `src/connectors/webhooks.ts` (add `'faults'`), and the `fleet.trucks` parts of `src/connectors/fleet-jobs.db.test.ts` and `src/connectors/deere/replay-fleet.db.test.ts` | 3113 / 4023 | `farm_dev_fleet_faults` |
| **sync-health** | Call counting in `vendorFetch` (calls, errors, rate-limited, per source, stream and **mode**) into `ingest.api_calls_daily`; decision 4 pacing of `fleet.deere` through `SyncStepSpec.minIntervalSeconds` with the shared split (`src/connectors/deere/call-shares.ts`, §5.5); `/admin/connectors`: calls today/yesterday and the budget per source with the split and its warning, the "Runs" column label fix (it counts job runs), dead-letter requeue and discard (manager) with the total count, the `DOC_DERIVED` list, **1f.2:** every connection's mode, its capability matrix (`capabilityMatrix(cfg)`, src/connectors/vendors.ts: positions live/last-known, stats fields, fault systems, field operations, webhooks, with the provider rows behind AEMP) and the deprecated-key warning (`cfg.connectorAliasNotes`; the foundation shows a plain version in the Configuration card that sync-health replaces), Deere OAuth status (connected, expiry, scopes, a Connect link outside sim), org approval status per mode (decision 5, with a stand-in knob that makes an org need approval), the home org (decision 8) and unmappable Deere equipment (§5.7); after sign-in the callback page lists the orgs that need approval (§5.6); per-org isolation of the Deere locations poll; decision 6 (`DEERE_REDIRECT_URI` + the forwarder template); `connectors:record` (decision 3) with the scrubber and a conformance test (§8: doc-derived fixtures and in-test sim recordings vs stand-in shapes, runnable against sim in CI); the `test:live` suites (by hand only) | `src/connectors/{http,sync-step,endpoints,doc-derived}.ts` (endpoints.ts: except the `replay` lines part B assigns), `src/connectors/oauth/**`, `src/connectors/deere/{client,oauth}.ts` (keeping the §5.0 seam signatures), `src/connectors/deere/connections*.ts`, `src/connectors/{deere,samsara}/replay-recorded.ts` (empty in 1f, §8), `src/connectors/**/*.live.test.ts`, `src/connectors/{call-budget,conformance}*.ts`, `src/jobs/fleet-deere.ts`, `src/db/queries/{api-calls,connector-orgs}*.ts`, `src/sim/vendors/deere/connections-*.ts`, `src/app/admin/connectors/**`, `src/app/api/oauth/**` (except part B's `cnh/**`), `scripts/connectors-record*.ts`, `tools/record/**`, `docs/deere-callback.html`, `e2e/sync-health*.spec.ts`; **plus (assigned, §1.3)** the `fleet.deere` parts of `src/connectors/fleet-jobs.db.test.ts` and `src/connectors/deere/replay-fleet.db.test.ts` | 3114 / 4024 | `farm_dev_sync_health` |

Existing test files follow the code they test, **except the ones §1.3 assigns** (that list wins).
A test of a file you don't own that your change breaks means you changed a contract: don't edit
that test, report it.

### 1.1 Integrator-owned (shared) files

Builders don't edit these; they list what to add in their report. The exceptions are the
**one-line registries and minimal mounts** of §1.2.

Everything not listed in §1 stays untouched, notably: `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `vitest.config.ts`, `db/migrations/**`, `src/db/schema/**`, `src/db/geo.ts`,
`src/config.ts`, `src/jobs/registry.ts` (and its test, which checks only what stays true when the
stubs are replaced: registration, connector, schedules, `typeof run === 'function'`),
`src/ui/board/**`, `src/app/board/**`, `src/app/m/**`, `src/ui/map/*.ts(x)` (`WarRoomMap.tsx` and
its tap seam `tap.ts` included), `src/sim/**` (except the files §1 gives out), `tools/seed/**`,
`tools/vendor-sim/**`, `src/db/queries/{boundaries,boundaries-sql,seasons,fields}*.ts`,
`tools/import/**` (except the one line §1 gives deere-ops), the M0/M1 e2e specs and
`e2e/support/**`, `README.md`, `docs/**` (except `docs/deere-callback.html`), `.github/**`, and
**every contract file**:

`src/connectors/types.ts`, `src/connectors/replay.ts` (deere-ops: `noShift` only),
`src/connectors/deere/{schemas,mapper,replay,orgs,call-shares}.ts`,
`src/domain/{operations,pins,fault-codes,fields,farm,fleet,ids}.ts`,
`src/platform/realtime/types.ts`, `src/ui/fleet/contract.ts`, `src/ui/map/layers/{types,builtin}.ts`,
`src/sim/types.ts`, `src/sim/vendors/{context,server,http,state,stub-world}.ts`,
`src/sim/vendors/deere/{routes,platform,modules}.ts`, the empty modules' shapes in
`src/sim/vendors/deere/*-routes.ts` (each builder fills its own), this file; **1f.2:**
`src/connectors/{vendors,sync-models}.ts`, `src/domain/vehicles.ts`,
`src/sim/vendors/samsara/modules.ts`, `src/sim/farm/fleet.ts` (the mixed fleet) and the shapes of
part B's stubs (§B.1).

New Deere schemas go in the builder's own directory (`src/connectors/deere/fields/schemas.ts`,
`src/connectors/deere/ops/schemas.ts`), built with `deereCollectionSchema` from the shared
`schemas.ts`. The 1a mapper helpers (`deereBoundaryToMultiPolygon`, `areaAcres`, `deereLinkId`,
`deereFlagGeometry`) are read-only; new mappers live with their builder.

### 1.2 One-line registries, minimal mounts, assigned lines

- `src/ui/map/layers/registry.ts`: deere-data adds exactly its import line and its `pins` entry.
- `src/ui/board/BoardScreen.tsx`: deere-data may add one import line, one element for the pin
  popup (taking `onOpen={closeField}`, as `TileLineDrawTool` does, so an open field panel closes)
  and the two props `tapLayers={…}` / `onFeatureTap={drawing ? undefined : …}` on the
  `WarRoomMap` element (§5.2: **while the tile-line draw tool is drawing, no pin popup opens**,
  exactly as `onFieldTap={drawing ? undefined : setFieldId}`; WarRoomMap queries tap layers only
  when `onFeatureTap` is set);
  fleet-faults one import and one element for an optional fault tag on the phone's machine card
  (contracts-m1 §12 rule: no layout or style changes; say so in the report).
- deere-ops: the `noShift` option in `src/connectors/replay.ts` (§8) and the `normalizeCrop`
  re-export in `tools/import/seasons-csv.ts`.
- fleet-faults: `'faults'` in `WEBHOOK_NUDGES.samsara` (`src/connectors/webhooks.ts`).
- deere-data owns the 1a Deere fixture builder; deere-ops may **import** helpers from it
  (`OPERATIONS_ANCHOR`, `fixtureFarm`) but never edits it.

### 1.3 Tests assigned by part

These files hold tests of more than one builder's code. Each part belongs to the builder named
here, whatever code it touches ("tests follow the code" gives way to this list). Shared setup in
a split file (`beforeAll`, helpers) stays as it is; a builder that needs another setup adds its
own `describe` block at the end of the file.

| File | Part | Owner |
|---|---|---|
| `src/connectors/fleet-jobs.db.test.ts` | `describe('fleet.trucks (Samsara, sim)')` | fleet-faults |
| | `describe('fleet.deere (sim)')`, `describe('fleet.deere keeps sim and real grants apart')` | sync-health |
| `src/connectors/deere/replay-fleet.db.test.ts` (one `describe('replay mode on the board')`) | the tests `fleet.trucks: …` (its `{ items: 4 + 12 }` grows with the replay `faults` fixture) and `the trucks move run after run …` | fleet-faults |
| | the test `fleet.deere: …` | sync-health |
| `src/connectors/deere/replay.contract.test.ts` | all (it asserts the 1a fixtures' contents: flags, machines, customer-org flags) | deere-data |
| `src/connectors/deere/fixtures/fixtures.test.ts` | all (with the fixture builder) | deere-data |
| `src/connectors/samsara/fixtures/fixtures.test.ts` | all | fleet-faults |
| `src/jobs/registry.test.ts` | all | integrator (green whatever the run functions do) |

---

## 2. Working rules

contracts-m1 §2 holds, with the 1f base, branches, ports and databases:

- **Start from this commit** of `claude/m1-1f`. Make your worktree:
  `git worktree add ../fm-<key> -b m1f/<key> claude/m1-1f`, then in it `pnpm install`
  (offline from the store is fine), copy `.env` and `.env.local` from `/home/user/Farm-manager`,
  and copy `.data/storage` (the synthetic basemap) so your board has a basemap.
- **Your own ports and database** (§1): put the same four lines in **both**
  `.env.development.local` and `.env.production.local` of your worktree (contracts §2 explains
  why both):
  ```
  DATABASE_URL=postgres://farm_app:<FARM_APP_PASSWORD>@127.0.0.1:15432/farm_dev_<key>
  DATABASE_URL_MIGRATE=postgres://postgres:<DB_PASSWORD>@127.0.0.1:15432/farm_dev_<key>
  PUBLIC_URL=http://localhost:311x
  VENDOR_SIM_URL=http://127.0.0.1:402x
  ```
  (`<key>` with underscores: `farm_dev_deere_data`, `farm_dev_deere_ops`, `farm_dev_fleet_faults`,
  `farm_dev_sync_health`), then `pnpm db:migrate` (creates `farm_dev_<key>`, applies 0000-0007),
  `pnpm db:configure local`, `pnpm db:reset` (seeds the demo farm), `pnpm db:pending` (if you
  have a `db/pending/<key>.sql`). `db:reset` drops every app schema and re-migrates without
  `db/pending`, so **re-run `pnpm db:pending` after every `db:reset`**. `pnpm test:e2e` then
  builds and starts `pnpm pilot` on your port. DB tests need none of this: every test file gets
  its own clone of `farm_test_template` (already rebuilt for 0007).
- **The shared container:** never `db:nuke`, `db:down`, `env:init`, `docker compose down`, never
  delete volumes, never `db:reset` or `db:migrate` the `postgres` database (only this stage and
  the integrator migrate it). `pnpm db:up` is allowed if the container stopped (it only starts
  it). If `docker info` fails, start the daemon (`(setsid nohup dockerd >
  /tmp/claude-0/dockerd.log 2>&1 &)`), wait, then `pnpm db:up`. Node 24:
  `export PATH=/opt/node24/bin:$PATH` in every shell (the default node is 22).
- **Schema:** never edit `db/migrations/**` or `src/db/schema/**`. Migration 0007 (§3) should hold
  everything; extra schema goes in `db/pending/<key>.sql` (idempotent, `db/pending/README.md`);
  tests apply it to every clone, `pnpm db:pending` to your dev database. Name its Drizzle mirror
  in your report and say why 0007 wasn't enough.
- **Dependencies:** never edit `package.json` or the lockfile. Nothing was added for 1f. Need a
  package? Name, exact version (`npm view`), why.
- **Never edit another builder's paths.** Need something from one? Use its contract; if the
  contract lacks it, ask in your report.
- **Authorization:** every mutation (route handler or server action) and every private read calls
  `requireRole(min)` FIRST, on the server. `/admin/*` uses `requireRole(ROLE_FOR.admin)`
  (manager; dead-letter requeue and discard included); `GET /api/pins` and
  `GET /api/fields/<id>/operations` use `requireRole(ROLE_FOR.viewPrivate)`; marking down from the
  critical-fault prompt goes through the existing `POST /api/machines/<id>/status`
  (`ROLE_FOR.markMachineDown`, driver). The browser's claims count for nothing.
- **E2E sessions:** every spec you write gets its session from
  `signInAs(context, role = 'viewer', baseURL?)` (`e2e/support/auth.ts`, real LocalAuth sessions
  since M1) before its first navigation: `'viewer'` for reads, the role the action needs
  (`ROLE_FOR`) for writes, and the origin when a context opens another host. Never call
  `unlockAdmin` directly (only M0's specs do).
- **Windows is the target:** no bash in anything a user runs, no inline `FOO=bar`, `node:path`,
  spawn `process.execPath` + a JS entry (`src/lib/proc.ts`), never `.cmd` shims, LF endings, no
  POSIX-only signals. Windows CI runs unit tests under heavy parallelism with a 30 s timeout:
  assert invariants, not exact counts at an instant.
- **Vendor hosts are blocked from the build machine** (checked Oct 30: `api.deere.com`,
  `developer.deere.com`, `sandboxapi.deere.com`, `api.samsara.com` answer 403 at the proxy, and
  so do the Motive, Geotab, CNH and Terminal doc hosts; the npm registry works, and
  `@samsarahq/samsara` 14.11's types are a usable Samsara reference).
  Build against small, faithful fixtures taken from the vendor's published API reference, mark
  them `// doc-derived, confirm`, list them in your builder's doc-derived list (§8), cite the
  doc URL, and make the real path the default for Derrick's PC. Never invent endpoints: confirm
  them (WebSearch/WebFetch/Context7, published OpenAPI mirrors) and cite them.
- **Real farm data is never committed** (decision 3, plan §3): `data/raw/` and `.data/` are
  gitignored; fixtures are doc-derived or scrubbed recordings.
- **Quality:** production TypeScript in the existing style (read neighbouring files), tests for
  everything, `pnpm lint`, `typecheck`, `test`, `test:db`, `build` and your e2e green, and the M0
  demo (`e2e/m0-demo.spec.ts`), `e2e/fleet-panel.spec.ts` and `e2e/weather.spec.ts` still passing.
  Commit on your branch with the attribution lines from the task; don't push.
- **Report:** what you built, files, how to run your demo (sim and replay), what the integrator
  must add (registry lines, mounts, pending SQL, dependencies, doc rows), open questions.

---

## 3. Database: migration `0007_m1f_live_connectors`

`db/migrations/0007_m1f_live_connectors.sql` (custom SQL, mirrored by
`src/db/schema/{farm,ingest}.ts`; snapshot `meta/0007_snapshot.json`; `pnpm exec drizzle-kit
generate` says "No schema changes"), applied to `postgres` and to `farm_test_template`. Every
statement is re-runnable. Conventions as in M0/M1: uuid PKs, `timestamptz` UTC, EPSG:4326 +
GiST on every geometry, `source` + `source_id` unique for outside rows, **id =
`deterministicId(source, source_id)`** (`src/domain/ids.ts`; plan §4). farm_app has
SELECT/INSERT/UPDATE/DELETE on all of it. Checked by `src/db/m1f-schema.db.test.ts`.

### 3.1 Tables and columns

| Table | Columns (beyond id / created_at / updated_at) | Keys, indexes, checks | Owner |
|---|---|---|---|
| `farm.operations` | `kind` text (`OPERATION_KINDS`: seeding, application, harvest, tillage), `field_id` → fields (set null; null = unmapped field, a dq row), `crop_year` int, `crop` text null (normalized, `src/domain/crops.ts`), `started_at`, `ended_at` null, `area_reported_ac` / `area_clipped_ac` numeric(12,4) null, `products` jsonb `OperationProduct[]` default `[]`, `measurements` jsonb `OperationMeasurements` default `{}`, `machine_ids` uuid[] default `{}`, `operator_party_id` → parties (set null; stays null in 1f: no party-matching rule yet), `operator_name` text null (the operator as the vendor names them: `NormalizedOperation.operatorName` → `OperationView.operatorName`), `weather` jsonb `OperationWeather` null (2b), `status` (provisional, final; default provisional), `geom` MultiPolygon null (coverage, simplified), `source`, `source_id`, `source_org` (Deere org id), `source_modified_at` (Deere `modifiedTime`) | unique (`source`, `source_id`); btree (`field_id`, `crop_year`, `started_at` desc); GiST `geom`; CHECKs kind, status, crop_year 1950-2100, `ended_at >= started_at`, areas ≥ 0 | deere-ops |
| `farm.pins` | `kind` (`PIN_KINDS`: wet_hole, rock, tile_blowout, washout, hazard, note; default note), `field_id` → fields (set null), `geom` Geometry (CHECK: Point, LineString or Polygon), `note`, `category` (the vendor's category or label), `photo_keys` text[] (2c), `created_by` → app_users (set null), `resolved_at` (a Deere flag archived = resolved), `client_id` uuid null (offline dedupe, 2c), `read_only` bool default false, `source` default `'app'` (`deere_flag` for flags), `source_id`, `source_org`, `source_modified_at` | unique (`source`, `source_id`); unique `client_id` where not null; btree `field_id`; GiST `geom` | deere-data |
| `farm.machine_hours` | `machine_id` → machines (cascade), `ts` (vendor time), `engine_hours` / `odometer_mi` numeric(10,1) null (at least one), `source` | PK (`machine_id`, `source`, `ts`); btree (`machine_id`, `ts` desc); CHECKs one value, values ≥ 0. Append with `on conflict do nothing` | deere-data (source `deere`, its own query), fleet-faults (source `samsara`, in `upsertVehicleStat`); both keep `machines.engine_hours` / `odometer_mi` never decreasing (`greatest()`, §5.3) |
| `farm.machine_faults` | `machine_id` → machines (cascade), `source`, `code` (`faultCodeKey()`), **1f.2 one fault model:** `system` (`FAULT_SYSTEMS`: j1939, obd2, oem), `spn` / `fmi` / `source_address` / `occurrence_count` (j1939), `dtc_state` (obd2: confirmed, pending, permanent), `oem_class` (oem: caution, fault), `lamps` jsonb `FaultLamps` null (redStop, amberWarning, protect, malfunction), `vendor_severity` (the vendor's label, verbatim); `severity` (`FAULT_SEVERITIES`: info, warning, critical), `description`, `first_seen_at`, `last_seen_at`, `cleared_at` null (= open) | unique (`machine_id`, `source`, `code`) **where `cleared_at` is null** (one open row; a code seen again after clearing opens a new row); btree (`machine_id`, `first_seen_at` desc); CHECKs severity, `last_seen_at >= first_seen_at`, `cleared_at >= first_seen_at`, and `machine_faults_system_check` (each system's fields only on its rows; spn and fmi exactly on j1939 rows, SPN ≤ 524287, FMI ≤ 31, address ≤ 255, lamps an object) | fleet-faults |
| `farm.machine_state` + | `fault_codes` jsonb `ActiveFaultCode[]` default `[]` (worst first; 1f.2: the system fields optional), `faults_at` (vendor time of the fault event it reflects: **an older event never overwrites a newer one**), `stats_at` (vendor time of the stat `fuel_pct` came from: the same guard for fuel), `position_vendor` text null (**1f.2: any vendor id**, `positionVendorId(source, provider)`: `samsara`, `geotab`, `cnh`, `aemp_kubota`, …; labelled by the registry, src/connectors/vendors.ts), **1f.2** `position_kind` (`POSITION_KINDS`: live, last_known; default live) | CHECK `position_vendor` null or `~ '^[a-z][a-z0-9_]{1,30}$'` (a format, so a new vendor needs no migration); CHECK `position_kind`; CHECK `jsonb_typeof(fault_codes) = 'array'` | fleet-faults (the foundation's `upsertPosition` already writes `position_vendor` and `position_kind`) |
| `farm.machines` + (**1f.2**) | `telematics_via` text null (how the vendor gets the data: `ford_pro`, `stellantis`, `gateway`, `obd_device`; any id of the vendor-id format), `kind_set_by` (`KIND_SET_BY`: default, vendor, admin; default `default`); `kind` gains **`service_truck`** and **`loader`** | CHECKs `machines_telematics_via_check` (format), `machines_kind_set_by_check`, `machines_kind_check` (re-added with the two kinds) | terminal-pickups (`src/db/queries/vehicles.ts`, §B.4.5; the seed writes `telematics_via` and never overwrites a kind set by a vendor or on /admin) |
| `farm.fields` (tenure) | CHECK `fields_tenure_check` now allows **`unknown`** (`TENURES`): a field the Deere sync created, until someone sets it (decision 7; the map draws it grey, legends unchanged) | — | (deere-data writes it) |
| `ingest.api_calls_daily` | `source`, `stream` (default `''`: calls outside a sync step and outside `withCallStream`; names in §9), `mode` (required; `COUNTED_MODES`: sim, replay, sandbox, live: the connector mode the calls went through), `day` date (**UTC**), `calls` (every HTTP attempt, retries included), `errors` (non-2xx other than 429, and attempts with no answer), `rate_limited` (429s), `updated_at` | PK (`source`, `stream`, `mode`, `day`); CHECKs mode, counts ≥ 0. Upsert `on conflict (source, stream, mode, day) do update set calls = api_calls_daily.calls + excluded.calls, …`. **Budget math reads sandbox/live rows only** (§5.5): a day of sim never counts against a real budget | sync-health |
| `ingest.connector_orgs` | `source`, `mode` (required; `COUNTED_MODES`), `org_external_id`, `name`, `status` (connected, needs_approval), `approval_url`, `detail` (short reason, no secrets), `first_seen_at`, `last_seen_at`, `updated_at` | PK (`source`, `mode`, `org_external_id`); CHECKs mode, status. `/admin/connectors` shows the current mode's rows only; after each **successful** org listing the writer deletes that source and mode's rows the listing no longer has (so after a switch from sim to sandbox, sim's orgs never show as connected) | sync-health |

**Ids of synced rows** (all `source = 'deere'` unless said; `source_id` = the vendor's raw id
unless said; id = `deterministicId(source, source_id)`): operations (`<operation id>`); pins
(`source = 'deere_flag'`, `<flag id>`); **Deere boundary versions** `source_id = '<boundary
id>@<sha8>'` (and `#<n>` for a return to an earlier geometry) with `source_ref` = the Deere
boundary name: the writer rule of §5.7; fields the sync creates (`<field id of the org that owns
it>`); farms (`deere_farm_id` set too), parties (Deere clients) and machines the same way; the
party of a customer org (decision 8) `source_id = 'org:<org id>'`; seasons from operations
`source_id = 'season:<field id>:<crop year>'` (§5.1). **No new `ingest.external_refs` kinds**:
fields, farms, boundaries, machines and parties use the existing ones (contracts §4 tuples; a
customer org's party is `('deere', 'party', <org id>, <org id>)`); operations and pins carry their
own `source_id`. `ingest.sync_state.extra` holds per-stream values; **writers merge their own keys
(`extra = coalesce(extra, '{}') || jsonb_build_object(…)`, the weather job's pattern) and never
replace the object**: sync-health's measured `callsPerRun`, deere-ops' `fieldsPerRun`, deere-data's
`unmappedKinds` (§5.7); `/admin/connectors` already shows numeric keys (one level deep) as
counters.

### 3.2 Not exported

`data:export` doesn't list the 1f tables: they are synced (or derived) and come back by
re-syncing; their ids are deterministic, so hand-entered rows that point at them survive
`data:export → db:reset → re-sync → data:import`. Fields with tenure `unknown` export like any
field.

Two existing `data:import` rules contradict decisions 1 and 7, so **the integrator changes
`tools/import/data-transfer.ts` after the merge** and adds both cases to the round-trip DB test
(which it re-runs):

- `makeRoomForSeason` also deletes `deere` rows (today only `demo`/`sim`): an exported `app` or
  `import` season wins over a re-synced Deere one (decision 1), instead of being refused.
- `makeRoomForBoundary`: for a field whose current version is a Deere one (re-synced after the
  reset, starting at the sync time), an imported version that was current when exported is
  inserted **closed at the Deere version's start** (`valid = [its start, deere start)`), so it is
  kept as history (decision 7) instead of tripping the EXCLUDE constraint.

---

## 4. Configuration (`src/config.ts`, documented in `docs/contracts.md` §3)

| Key | Default | Meaning |
|---|---|---|
| `DEERE_REDIRECT_URI` | unset (http(s) URL; **https in production**) | decision 6: the Deere OAuth callback when it isn't `${PUBLIC_URL}/api/oauth/deere` |
| `DEERE_DAILY_CALL_BUDGET` | unset (integer ≥ 1) | decision 4: Deere API calls a day (sandbox/live); unset = "limit unknown", the jobs keep their cron; set = the split of §5.5 |
| `DEERE_HOME_ORG_ID` | unset (a Deere org id) | decision 8: your own Deere organization (§5.4). Unset: sim = `SIM_DEERE_HOME_ORG`, replay = the fixtures' home org (`DEERE_REPLAY_HOME_ORG`), sandbox/live = the only org you are a member of when there is exactly one, else none and `/admin/connectors` asks for it |

**1f.2:** one mode key per telematics connection (`CONNECTOR_SAMSARA`, `CONNECTOR_MOTIVE`,
`CONNECTOR_GEOTAB`, `CONNECTOR_AEMP`, `CONNECTOR_CNH`, `CONNECTOR_TERMINAL`), the deprecated
`CONNECTOR_ELD` / `ELD_VENDOR` alias, every vendor's credentials and `VEHICLE_KIND_TAGS`,
`FLEET_STALE_SECONDS_LAST_KNOWN`: §B.3. Part A's code reads `CONNECTOR_SAMSARA` wherever it read
`CONNECTOR_ELD` (fleet.trucks, the webhook route, the panel's `modes`).

`FleetConfig` (`src/jobs/fleet-shared.ts`) already picks `DEERE_DAILY_CALL_BUDGET`; sync-health
adds `DEERE_REDIRECT_URI` to `ConnectorConfig` (`src/connectors/endpoints.ts`, its file);
deere-data and sync-health read `DEERE_HOME_ORG_ID` through `getConfig()` into their own job
options (deere-ops picks `DEERE_DAILY_CALL_BUDGET` the same way). Nothing reads `process.env`
outside `src/config.ts`.

---

## 5. Domain contracts and connector ports

### 5.0 Ports, normalized types and the Deere client seam

`src/connectors/types.ts` (plan §5 "Common shape"):

```ts
interface FieldSource     { listFields(): Promise<NormalizedField[]> }          // with its active boundary
interface FlagSource      { flagsSince(cursor): Promise<PollResult<NormalizedFlag>> }
interface OperationSource { operationsSince(cursor): Promise<PollResult<NormalizedOperation>> }
interface MachineSource   { listMachines(): Promise<NormalizedMachine[]> }      // Deere equipment
NormalizedRef { externalId, name }                                              // a Deere farm or client
NormalizedField { source, sourceOrg, externalId, name, farm, client, archived, boundary, modifiedAt }
NormalizedBoundary { source, sourceOrg, externalId, fieldExternalId, name, geom: MultiPolygon, areaAc, active, archived, modifiedAt }
NormalizedFlag { source, sourceOrg, externalId, fieldExternalId, geometry: PinGeometry, note, category, archived, createdAt, modifiedAt }
NormalizedOperation { source, sourceOrg, externalId, fieldExternalId, kind, cropYear, crop, startedAt, endedAt, areaAc,
                      products, measurements, machineExternalIds, operatorName, coverage: MultiPolygon | null, modifiedAt }
NormalizedMachine { source, sourceOrg, externalId, name, kind: MachineKind | null, make, model, year, vin }  // kind from equipmentType (§5.7)
NormalizedVehicleStat.faultCodes?: NormalizedFault[]       // 1f.2: the one fault model (§5.3); [] = cleared in a snapshot
NormalizedVehicleStat.faultReport?: 'snapshot' | 'delta'   // 1f.2: default snapshot (Samsara); delta = per-fault state
NormalizedVehicleStat { …, defPct?, engineOn?, readings?: { [field]: StatReading } }   // 1f.2: raw value, unit, adjusted flag
NormalizedPosition { …, positionKind?: 'live' | 'last_known', provider? }               // 1f.2 (§B.4.1)
SyncStepSpec.minIntervalSeconds?: number | null                                        // decision 4, §5.5
```

**1f.2:** the vehicle telematics port (`VehicleTelematicsSource`, `NormalizedVehicle`,
`VEHICLE_STAT_FIELDS`, `StatReading`, `normalizeStat`) is in the same file; part B §B.4.1.

Engine hours travel as `NormalizedVehicleStat` (`engineHours`). Sync steps keep the M0 shape:
`poll` never writes, raw items land in `ingest.raw_events`, `map` is pure, `upsert` runs in the
per-event transaction.

**The Deere client seam** (`src/connectors/deere/client.ts`): `client.apiUrl(...segments)`
(each segment encoded below `apiBase`), `client.getOne(schema, url)` and
`client.getPaged(collectionSchema, url)` (bearer token, one refresh-and-retry on 401, `nextPage`
paging up to 50 pages, every page validated). deere-data and deere-ops add their calls in their
own files with these; the existing `fields`, `orgBoundaries`, `fieldBoundaries`,
`fieldOperations`, `fieldOperationMeasurements`, `fieldOperationCoverage`, `flags`, `fieldFlags`
stay as they are. sync-health owns `client.ts` but keeps these signatures.

**Frozen exports.** Builder-owned exports the other builders compile against in parallel. Their
owners may only make **additive** changes (new optional parameters and fields, new exports);
never rename, remove, narrow or change what an existing one means:

| Owner | File | Exports |
|---|---|---|
| sync-health | `src/connectors/http.ts` | `VendorHttpOptions`, `VendorHttpError`, `vendorJson` (and the §5.5 hook types), **`withCallStream(stream, fn)`**, `currentCallStream()` (1f fix: the CLIs' streams, §5.5) |
| | `src/connectors/sync-step.ts` | `runSyncStep` |
| | `src/connectors/endpoints.ts` | `ConnectorConfig`, `deereEndpoints`, `samsaraEndpoint` |
| | `src/connectors/oauth/**` | `OAuthTokenStore`, `userGrantOrg`, `tokenKey`, `MemoryTokenStore` |
| | `src/connectors/deere/client.ts` | `DeereClient`'s constructor, `forReplay`, `organizations()`, `machines()`, and the seam above |
| | `src/connectors/doc-derived.ts` | `DocDerivedItem` (every per-builder list imports it) |
| | `src/jobs/fleet-deere.ts` | `createFleetDeereJob`, `DEERE_STREAM`, `runFleetDeere` (re-exported by `fleet.ts`) |
| fleet-faults | `src/jobs/fleet-shared.ts` | `httpFor`, `machineResolver`, `positionsUpsert`, `tickAfterRun`, `publishSyncStatus`, `FleetConfig`, `FleetJobOptions` |
| | `src/jobs/fleet.ts` | `statsUpsert`, `combineStepResults` (1f.2: part B's jobs reuse them) |
| | `src/db/queries/fleet.ts` | `upsertPosition` (1f.2: `positionKind` / `provider`, below), `upsertVehicleStat` (1f.2: the unified `faultCodes`, both report kinds, §5.3) |

deere-data writes Deere engine hours in **its own** machine-hours query
(`src/db/queries/machine-hours*.ts`: append `farm.machine_hours`, then `machines.engine_hours`
with the same `greatest()` rule), never through `upsertVehicleStat`, which fleet-faults changes in
parallel.

**Other shared pieces the foundation added** (contract files): `deereHomeOrg`,
`deereMayCreateRows` and `DEERE_REPLAY_HOME_ORG` in `src/connectors/deere/orgs.ts` (decision 8,
§5.4); the budget split in `src/connectors/deere/call-shares.ts` (§5.5); `COUNTED_MODES`
(`src/connectors/types.ts`); the map's tap seam `src/ui/map/tap.ts` (§5.2). **1f.2:**
`POSITION_VENDORS` became `POSITION_VENDOR_PATTERN` / `positionVendorId` / `isPositionVendor`
and `POSITION_KINDS` (`src/domain/fleet.ts`); the vendor registry and capability matrix
(`src/connectors/vendors.ts`), the two sync models (`src/connectors/sync-models.ts`), vehicle kinds
(`src/domain/vehicles.ts`), the kind/via writer (`src/db/queries/vehicles.ts`), the stat formatter
(`src/ui/vehicles/stats.ts`). **The foundation's `upsertPosition`** writes `position_vendor` and
`position_kind`, and stores a `last_known` fix in machine_state only (when newer), never in
farm.positions (so never `inserted`, never geofence detection); fleet-faults keeps that behaviour
when it adds the fault seeding.

### 5.1 Operations (`src/domain/operations.ts`; deere-ops)

`OPERATION_KINDS`, `operationKindOf(fieldOperationType)` (case-insensitive, null for others),
`OPERATION_STATUSES`, the stored jsonb shapes `OperationProduct` (+ zod), `OperationMeasurements`
(+ zod: `areaAc`, `yieldBuAc`, `totalBu`, `moisturePct`, `avgSpeedMph`, all optional, US units),
`OperationWeather` (2b), the view `OperationView` and `FieldOperationsResponse`, and
`fieldOperationsUrl(fieldId, cropYear?)`.

- `GET /api/fields/<id>/operations[?cropYear=YYYY]` (viewer; `no-store`; through `limitedJson`)
  → `FieldOperationsResponse`, the crop year defaulting to the current one (America/Detroit),
  oldest first. The History tab fetches it and refetches on `fields`/`updated` with part
  `operations` (and in `onResync`).
- Coverage is stored simplified (`ST_SimplifyPreserveTopology`, tolerance chosen and tested by
  deere-ops); `area_clipped_ac` = the geodesic area of coverage ∩ **the field's boundary version
  valid at `started_at`** (falling back to the current one when none was), so a 2023 operation
  is clipped by the 2023 boundary even after a split, merge or re-draw.
- `operator_name` = `NormalizedOperation.operatorName`; `operator_party_id` stays null in 1f.
- `status`: deere-ops picks the provisional → final rule and states it in its report (suggested
  default: final once ended and unchanged for 24 h).
- Seasons from operations (backfill, decision 1): crop from `cropName` (normalized), variety from
  the seeding products, `planted_on` = the seeding start and `harvested_on` = the harvest end as
  America/Detroit dates, `yield_bu_ac` from `HarvestYieldResult.averageYield` (`bu1ac-1`),
  `source = 'deere'`, `source_id = 'season:<field id>:<crop year>'` (the app's field uuid), **id =
  `deterministicId('deere', source_id)`**, so ids survive `db:reset` + re-backfill. `--replace`
  deletes the existing row for that field and year (whatever its source and id) and inserts this
  id; anything that pointed at the old row's id is the report's to list. Publish `fields`/`updated`
  with part `seasons` per field written.
- **Per-run field cap** (decision 4, §5.5): with a budget set (sandbox/live), one run checks at
  most `operationsFieldCap(…)` fields, those checked longest ago first (deere-ops keeps each
  field's last-checked time in its stream's cursor or `sync_state.extra`); unset or unmeasured =
  every field every run.

### 5.2 Pins (`src/domain/pins.ts`; deere-data)

`PIN_KINDS`, `PIN_SOURCES` (app, deere_flag), `PinGeometry` (Point | LineString | Polygon),
`PinView` / `PinsResponse` (+ zod), `PINS_URL`.

- `GET /api/pins[?fieldId=<uuid>][&resolved=1]` (viewer; `no-store`; `limitedJson`) →
  `PinsResponse`: open pins unless `resolved=1`.
- Deere flags: `read_only = true`, `kind` from the flag's category when it names one of
  `PIN_KINDS` (deere-data's mapping, tested), else `note`; an archived flag gets `resolved_at`;
  geometry as Deere sends it (`deereFlagGeometry`).
- Map layer (`src/ui/map/layers/pins*.ts`, a `MapLibreLayerDef`): key `pins`, group `fields`,
  label "Deere flags", `render: 'maplibre'`, `kind: 'vector'`, `anchor: 'top'`, `order: 30`
  (fields 10, spray 20), `minzoom: 10`, `maxzoom: 24`, `requiresRow: false`, `cachePolicy:
  'private'`, `offline: true`, `defaultVisible: true`. `spec()` stays pure: one GeoJSON source
  `layer:pins` with an empty FeatureCollection and layers `layer:pins:<…>` (polygons, lines,
  points); every feature carries `properties.id` = the pin's uuid (a string).
- **Refetching** is done by deere-data's mounted pins component (`src/ui/pins/**`, the
  `SprayFieldState` pattern: it gets the shared `map` and needs no `apply.ts` change): it fetches
  `GET /api/pins` and calls `map.getSource('layer:pins').setData(…)` on mount, on
  `pins`/`updated`, in `onResync`, and again when `applyLayers` re-adds the source (`styledata`).
- **Pin taps** go through WarRoomMap's tap seam (`src/ui/map/tap.ts`, added by the foundation):
  BoardScreen passes `tapLayers={['layer:pins:*']}` and `onFeatureTap={drawing ? undefined : …}`
  (deere-data's lines, §1.2: the tile-line draw tool's taps never open a pin popup). The precedence is **machine > pin > field**: a tap that hits a pin calls `onFeatureTap`
  with the topmost pin feature (`FeatureTap`: layer id, `properties.id`, the tap's lng/lat) and
  does not call `onFieldTap`, so no field panel or bottom sheet opens under the popup; the popup
  element takes `onOpen={closeField}` so an already open field panel closes. The popup shows
  category, note, the field and "From Operations Center (read-only)", on `/board` and `/m`.
- Publish `pins`/`updated` (§6) in the writer's transaction, **at most once per run** (batched:
  1f's writes are bulk, one sync run at a time; plan §4 names a trigger, decision table §10
  records the deviation). 2c, which draws single pins on phones, adds a trigger or a shared
  `publishPinsUpdated` helper.

### 5.3 Fleet panel and fault codes (`src/domain/fault-codes.ts`, `src/ui/fleet/contract.ts`; fleet-faults)

`FAULT_SEVERITIES` (info < warning < critical), `FaultCode`, `ActiveFaultCode` (+ `since`),
`severityRank`, `worstSeverity`, `sortFaultCodes` (worst first, then code).

**1f.2, one fault model** (the foundation wrote it; fleet-faults' writer stores it, part B's
vendors produce it):

- `FAULT_SYSTEMS` (j1939, obd2, oem), `OBD_DTC_STATES` (confirmed, pending, permanent),
  `OEM_FAULT_CLASSES` (caution, fault), `FaultLamps`, `NormalizedFault` (+ zod): the system's
  identity (SPN/FMI and source address; the DTC; the OEM code and class), lamps, the vendor's own
  severity label, `state` (open/closed) and the vendor's first/last-seen/closed times when it sends
  them. `faultCodeKey()` builds `code` (the history key): `J1939 SPN 110 FMI 0`, `P0217`,
  `OEM caution 1234`. `faultSeverity()` is decision 1f-2 extended per system (§10);
  `normalizedFault()` fills the key and severity; `toFaultCode()` gives the panel's view.
- `NormalizedVehicleStat.faultReport`: **`snapshot`** (default; Samsara's `faultCodes` stat: the
  complete active set at `ts`, a code it no longer lists has cleared, `[]` = cleared) or
  **`delta`** (Motive, Geotab, AEMP, Terminal: each named fault carries its own `state` and times;
  codes it doesn't name are unchanged). The guard below applies per report: for a snapshot the
  machine's `faults_at`; for a delta per fault, an item older than its open row's `last_seen_at`
  only extends nothing and never clears; a `closed` item newer than the row sets `cleared_at`
  (= its `closedAt` or `ts`); an `open` item opens or refreshes the row (`first_seen_at` = its
  `firstSeenAt` when the vendor sends one). Both kinds then refresh `machine_state.fault_codes`
  from the open rows (`sortFaultCodes`) and `faults_at` = the newest event time.
- Rows store the system columns of §3.1 (`system`, `spn`, `fmi`, `source_address`,
  `occurrence_count`, `dtc_state`, `oem_class`, `lamps`, `vendor_severity`);
  `machine_state.fault_codes` items carry `system`, `spn`/`fmi`, `dtcState`, `oemClass`, `lamps`
  when known (all optional in `ActiveFaultCode`).

- The panel contract gains **optional** fields (1a code keeps compiling): `faults?:
  ActiveFaultCode[]` per machine (from `machine_state.fault_codes`), `position.vendor?: string |
  null` (from `machine_state.position_vendor`; 1f.2: any vendor id), and `engineHours?`,
  `odometerMi?`, `fuelPct?` (`number | null`; from `machines.engine_hours`,
  `machines.odometer_mi` and `machine_state.fuel_pct`); **1f.2:** `position.positionKind?`
  (`machine_state.position_kind`), `via?` (`machines.telematics_via`), `kindSetBy?`
  (`machines.kind_set_by`) and `notReported?` (`statsNotReported(position_vendor,
  telematics_via)`, src/connectors/vendors.ts). fleet-faults selects them in
  `fleetPanelMachines` and shows the stats in the row text with `formatVehicleStat`
  (`src/ui/vehicles/stats.ts`: "4,312 h", and "not reported" for a stat the route doesn't report,
  never 0): engine hours reach the screen through the panel, whoever wrote them. The badge text is
  `<vendorLabel(position.vendor)> · <mode>` with the mode `FleetPanelData.modes[connectionOf(
  vendor)]` (**1f.2: `modes` has one entry per connection**, `{ deere, samsara, motive, geotab,
  aemp, cnh, terminal }`, from `connectionModes(cfg)`): "Samsara · sim", "John Deere · replay",
  "Kubota (AEMP) · sim"; an id the registry doesn't know shows as is. Faults never ride on the
  tick; the tick gains only `positionKind` (present for `last_known` fixes alone).
- Severity (decision 2, per system: `faultSeverity`) is applied by the mapper; in a `snapshot`
  report `faultCodes: []` (no codes, no lamps) clears the machine. In the per-event transaction, with the **guard time** = `machine_state.
  faults_at`, or while the machine has no `machine_state` row yet the newest `last_seen_at` /
  `cleared_at` of its `machine_faults` rows:
  - an event **newer** than the guard updates `machine_faults` (open new codes, refresh
    `last_seen_at`, clear the codes it no longer lists) and then `machine_state.fault_codes` /
    `faults_at` (when the row exists); when the active set or its worst severity changed, publish
    `fleet`/`invalidate` `{ event: 'machine', reason: 'faults' }`;
  - an event **older** than the guard only extends `last_seen_at` (`greatest()`) of the open rows
    it names: it never opens, clears or reopens a code, and never touches `machine_state`;
  - a machine with no fix yet (no `machine_state` row) still gets its `machine_faults` rows; the
    **first position insert** (`upsertPosition` creating the row) seeds `fault_codes` from the
    open `machine_faults` rows (`sortFaultCodes`, `since` = `first_seen_at`) and `faults_at` from
    the guard time, so the panel never misses faults `machine_faults` has open.
- Samsara engine hours and odometer: `upsertVehicleStat` also appends the reading to
  `farm.machine_hours` (source `samsara`, `ts` = the stat's vendor time, `on conflict do
  nothing`). Both writers keep `machines.engine_hours` and `odometer_mi` **never decreasing** with
  the `greatest()` rule `upsertVehicleStat` already uses (deere-data copies it in its own query).
- A machine whose worst code is critical, not down, with `canMarkDown`: the row offers
  "Critical fault: mark down?"; it opens the existing `StatusSheet` with the reason pre-filled
  from the code (within `MAX_DOWN_REASON_CHARS`). Never automatic. Viewers and the wall see the
  badge only.
- A Deere-only machine (latest fix `positionSource = 'deere_working'`) that stopped working (no
  new breadcrumb for a while: Deere records positions only while working) shows "Last working
  position, N min ago" instead of a stale alarm; fleet-faults picks and tests the threshold. A
  failing Deere stream still shows as failing (the panel's mode notice, `/admin/connectors`).
  **fleet-faults covers the fleet panel only**: `MachineView.stale` (`src/domain/fleet.ts`), the
  map markers' stale ring (`src/ui/map/fleet/**`) and the board's machine card (`src/ui/board/**`)
  are integrator-owned and stay as they are; fleet-faults reports what they need (e.g. a "last
  working position" state on `MachineView`) and the integrator changes them after the merge.
- Motive, Geotab, AEMP, Terminal: their faults arrive as `delta` reports from part B's builders
  (§B.4.2) through the same writer; the panel needs nothing per vendor.

### 5.4 Deere orgs (`src/connectors/deere/orgs.ts`; decisions 5 and 8)

`DEERE_CONNECTIONS_REL` (`'connections'`, doc-derived), `deereOrgAccess(org)` (a `connections`
link → `needs_approval` with that link as `approvalUrl`, else `connected`), `isDeereOrgDenied(err)`
(Deere 403), `deniedOrgAccess(org, err)`; `deereHomeOrg(mode, DEERE_HOME_ORG_ID, orgs)` →
`{ orgId | null, source: 'config' | 'sim' | 'replay' | 'only_member' | 'unknown' }`,
`DEERE_REPLAY_HOME_ORG`.

- **Every Deere sync** (locations, fields, operations, the backfill) lists orgs, skips the
  `needs_approval` ones (and any org that answers 403 mid-run), logs each skip, and never fails
  the other orgs for it.
- **Only sync-health writes `ingest.connector_orgs`**, from the `fleet.deere` locations step
  (which lists every org every run; poll keeps the statuses, `afterRun` writes them), with the
  connector mode; after a successful listing it deletes that mode's rows the listing no longer
  has (§3.1). After the merge the integrator may route the other syncs' 403s to the same writer.
- `/admin/connectors` shows each org of the current mode with its status and approval link and
  says that customer organizations are connected only after a data-rights agreement (plan 2a,
  D17); nothing blocks the home org.
- **The home org (decision 8).** `DEERE_HOME_ORG_ID` names it in any mode. Unset: sim =
  `SIM_DEERE_HOME_ORG`, replay = `DEERE_REPLAY_HOME_ORG` (the fixtures are built from the demo
  farm), sandbox/live = the only org the listing marks `member: true` when there is exactly one,
  else **no home org**: `/admin/connectors` shows which org is home and why, or asks for
  `DEERE_HOME_ORG_ID` (listing the org ids to pick from).
  - **Machines are created only from the home org** (deere-data, §5.7). A machine in another org
    that already maps through an external ref is still matched; an unmapped one there is
    skipped, so customers' equipment never lands on your fleet panel. No home org = no machine
    is created.
  - **No home org = nothing is created** (1f fix): until a home org is known
    (`deereMayCreateRows(home)`), the fields sync creates no farm, field or machine; rows that
    already map through their external refs are still updated, and `/admin/connectors` asks for
    `DEERE_HOME_ORG_ID`. So a farm in your own org never gets a customer party by mistake.
  - **Farms and fields read from any other org** belong to that org's customer: a farm the sync creates there gets `client_party_id` = the org's party,
    found by the ref `('deere', 'party', <org id>, <org id>)`, else the one client party every
    already-matched farm of that org shares (the seed's customers in sim: the ref is then
    written), else created (`kind 'org'`, roles `['customer']`, display name = the org's name,
    `source 'deere'`, `source_id 'org:<org id>'`, id deterministic) with the ref. Home-org farms
    keep `client_party_id` null (yours) unless Deere names a client.

### 5.5 Call counting and the budget (`src/connectors/http.ts`; decision 4; sync-health)

- `VendorHttpOptions.onCall?: VendorCallHook` (default `noopVendorCallHook`), called **once per
  attempt** with `VendorCall { vendor, method, path (no query), status | null, outcome: 'ok' |
  'rate_limited' | 'error', attempt, ms }`; a hook that throws is ignored. sync-health wires the
  counter (e.g. an ambient per-step counter set by `runSyncStep`, so no client or job changes)
  and flushes it into `ingest.api_calls_daily` (§3.1) **with the connector mode** (the step's
  `mode`; outside a step, the configured mode). **Outside a step** (1f fix) calls count under the
  `withCallStream(stream, fn)` label (`http.ts`, frozen: `VendorCall.stream`): `deere:backfill`
  wraps its work in `withCallStream('backfill', …)`, `connectors:record` in
  `withCallStream('record', …)`; sync-health's counter counts those under that stream and flushes
  when `fn` settles; with no label and no step, stream `''`. Sim and replay calls count too (they measure the
  per-run cost offline) but under their own mode, so they never count against a real budget.
  sync-health also records each stream's measured **`callsPerRun`** (mean of its recent runs) in
  that stream's `sync_state.extra` (merged, §3.1).
- `SyncStepSpec.minIntervalSeconds`: after a claimed run, `runSyncStep` releases with
  `next_run_at` = the later of (run start + this) and the Retry-After time. It never makes a stream
  run faster than its cron. Undefined or null = no minimum.
- **The budget split** (decision 4; pure helpers in `src/connectors/deere/call-shares.ts`, which
  both paced jobs and the page use). Only with `DEERE_DAILY_CALL_BUDGET` = B set **and** the Deere
  mode sandbox or live; D = the calls per Deere stream on the **last full UTC day**
  (`lastFullUtcDay`) from `ingest.api_calls_daily`, same mode:
  - `fleet.deere` (`locations`): share = `locationsShare(B, D)` = max(10 % B, 80 % B − Σ D[every
    other Deere stream]); `minIntervalSeconds = paceSeconds(callsPerRun, share)` = ceil(callsPerRun
    × 86 400 / share), never faster than its cron.
  - `deere.ops` (`operations`): share = `operationsShare(B, D, locationsPerDay)` = max(10 % B,
    80 % B − Σ D[streams other than locations and operations] − locations' calls a day at its
    cron (`callsPerDay(callsPerRun, cron interval)`)); fields per run = `operationsFieldCap(share,
    runs a day, callsPerField)` = max(1, floor(share / (runs a day × calls per field))), the
    fields checked longest ago first; calls per field = `callsPerRun` / `fieldsPerRun` (deere-ops
    records `fieldsPerRun` in its stream's `extra`). Locations come first (the live board), so
    the two paced streams never both plan on the same calls.
  - The unpaced streams (`fields`, `flags`, `equipment`, `hours`, the CLIs) keep their cron.
  - Unset budget, sim/replay, or nothing measured yet = no pacing and no cap; the page says
    "limit unknown" when unset.
  - `/admin/connectors` shows the split (`deereCallSplit`: last day per locations / operations /
    others, each paced stream's share) and **warns when the streams other than locations alone
    spent more than 80 % of the budget** (locations are then at their 10 % floor).
  Keep `FLEET_STALE_SECONDS_DEERE` above the resulting locations interval (say so on the page
  when it isn't). Webhook nudges (`next_run_at = now()`) only exist in sim today.

### 5.6 OAuth redirect (decision 6; sync-health)

`deereEndpoints(mode, cfg).redirectUri` = `DEERE_REDIRECT_URI ?? ${PUBLIC_URL}/api/oauth/deere`,
used by both the authorize URL and the code exchange. `docs/deere-callback.html` is a static
page (no scripts from other hosts) that forwards `code`, `state` (and `error`,
`error_description`) to `http://localhost:3000/api/oauth/deere`, so the state cookie (host-only,
localhost) still matches when the sign-in started on the PC. `/api/oauth` and `/api/webhooks`
still never answer 3xx.

**After the code exchange** the callback page (still a 200 page, never a redirect) lists the orgs
the new grant sees that need approval, each with an **"Approve in Deere Connections"** button: a
plain link to that org's `connections` URI with `redirect_uri` set (`URL.searchParams.set`) to
`${PUBLIC_URL}/admin/connectors`, so Deere sends the person back to the page that shows the
status (doc-derived, confirm the parameter name), plus a link to `/admin/connectors`. No org
needs approval: the page says "Connected" as today.

### 5.7 Deere fields, boundaries and equipment (deere-data)

**Field matching**, in this order, per field a connected org lists:

1. the external ref `('deere', 'field', <field id>, <org id>)` (the seed writes these for every
   demo field and its `sharedWith` copy);
2. else a field with `farm.fields.deere_field_id = <field id>` (`import:boundaries` sets it from
   an Ops Center export without writing a ref): match it and **write the ref**, so Derrick's
   imported fields are never duplicated on the PC;
3. else create it (id `deterministicId('deere', <field id of the owning org>)`, `source
   'deere'`, tenure `unknown`, `deere_field_id` set, in the farm of its Deere farm, else the
   default import farm "Home farm"). A field seen only from a customer org that is still
   unmatched is created too, in that org's farm (decision 8): the duplicate risk with the same
   ground in another org is accepted until M2's customer-org field matching.

**Columns the sync owns** on a matched field: `name`, `deere_field_id`, `active = false` when
Deere archives the field (it never sets `active = true`: un-archiving in Deere doesn't unhide a
field hidden by hand), and `farm_id` only on fields it created. **It never touches** the
hand-entered overlays, the same as `OVERLAYS` in `tools/import/data-transfer.ts`: `tenure`
(except `unknown` on create), `landlord_party_id`, `county_fips`, `notes`, `notes_updated_at`,
`notes_updated_by`, and a field hidden by hand.

**The owning org** of a field is the Deere org of its farm (the farm's `('deere', 'farm', …)`
ref; a farm without one, such as an imported one, belongs to the home org); for a field the sync
creates, the org it was read from. **Deere boundary writer** (decision 7; one transaction per
field):

1. Only the **owning org's active boundary** is written as a version. A boundary seen from a
   sharing org (`SimField.sharedWith`; the 1a fixtures' three `org-customer-2` boundaries) only
   gets its `('deere', 'boundary', <boundary id>, <that org>)` ref, pointing at the field's current
   version: it never becomes a version, so two orgs never take turns as the current one.
2. The Deere geometry is normalized as every boundary write is (`deereBoundaryToMultiPolygon`,
   then the `NORMALIZED_POLYGON` SQL of `src/db/queries/boundaries-sql.ts`). A new version is
   written **only when the source or the geometry changes**: if the field's current version
   (`upper_inf(valid)`) has `source = 'deere'` and `ST_Equals` with the normalized geometry,
   nothing is written (a different Deere boundary id with an equal geometry only gets its ref).
3. The new version: `source 'deere'`, `source_ref` = the Deere boundary name, `source_id =
   '<deereBoundaryId>@<sha8>'` with sha8 = the first 8 hex digits of the SHA-256 of the normalized
   geometry's WKB (`left(encode(sha256(ST_AsBinary(g)), 'hex'), 8)`), **id =
   `deterministicId('deere', source_id)`**, `valid = [now(), null)`. If a row with that
   `source_id` already exists (the field went back to an earlier geometry, A → B → A: the EXCLUDE
   constraint forbids reopening the old row), the new row's `source_id` is
   `'<deereBoundaryId>@<sha8>#<n>'`, n = the number of existing rows whose `source_id` is that base
   or starts with base + `#` (1 the first time back, 2 the second, …), and its id follows from it.
4. The previous current version, **whatever its source** (`demo`, `sim`, `import`, `drawn`, or an
   older `deere` version), is closed at `now()` in the same transaction (`valid = [its start,
   now())`): it stays as history, with lineage. These are `writeBoundaryVersion`'s steps
   (`src/db/queries/boundaries.ts`, integrator-owned); deere-data writes its own insert because it
   sets the id and `source_id`.
5. The `('deere', 'boundary', <deereBoundaryId>, <owning org>)` ref is **re-pointed** to the new
   version with `upsertExternalRef` in that transaction (in sim and replay it pointed at the seeded
   `demo` row), then `fields`/`updated` with part `boundary` is published.

After `db:reset` + re-sync the current geometry is written again under the same `source_id` and
id (a `#n` suffix drops: no earlier row exists after a reset); nothing else points at a boundary
version's id.

**Equipment** (`GET /platform/organizations/{org}/machines`, the core stand-in path, read with
deere-data's own looser schema: `equipmentType`, `equipmentMake`, `equipmentModel` names, which
the stand-in now sends from the simulated machine): `NormalizedMachine.kind` from the equipment
type name (deere-data's mapping, tested). Matched through the `('deere', 'machine', …)` ref, else
created **from the home org only**. A machine whose kind doesn't map (a Gator, a loader) is
skipped and **listed once**: `ingest.sync_state` row (`deere`, `equipment`) `extra.unmappedKinds =
{ "<equipment type name>": <machine count> }`, replaced each run (merged into `extra`), logged
only when the list changes; `/admin/connectors` shows it (its numeric keys already render as
counters; sync-health may list it more nicely). **Engine hours**: `GET
/platform/machines/{id}/engineHours` (doc-derived, served by the fields module), written through
deere-data's own machine-hours query (§5.0). If Deere's Equipment API host turns out to be the
only way (the `DOC_DERIVED` item names it), sync-health adds an `equipmentBase` to
`DeereEndpoints` and the router passes that prefix to the modules: a later change, not 1f's.

---

## 6. Realtime (`src/platform/realtime/types.ts`)

| Topic / event | Payload | Published by | Subscribers do |
|---|---|---|---|
| `pins` / `updated` (**new topic**) | `PinsUpdatedPayload { fieldIds, hasUnfielded }` | deere-data, in the writer's transaction, at most once per run (batched; 2c adds a trigger or a shared helper for single pins, §5.2) | the pins component refetches `GET /api/pins` into the layer's source; open popups refetch |
| `fleet` / `invalidate` | `InvalidatePayload` with **`reason: 'faults'`** (new value) and `event: 'machine'` | fleet-faults, when a machine's active codes or worst severity changed | the fleet panel refetches `GET /api/machines` (it already does on any invalidate) |
| `fields` / `updated` | `{ fieldId, parts }`; parts gain **`operations`** (`FIELD_PARTS`) | deere-ops (`operations` after a sync changed the field's operations; `seasons` after the backfill), deere-data (`boundary` / `identity` when a Deere field or boundary changed) | panels refetch; maps refetch field tiles on `boundary` / `identity` |
| `admin` / `sync.status` | M0 | every claimed step | `/admin/connectors` re-renders |
| every topic / `invalidate` | `InvalidatePayload` | `publish()` when a payload is too big | refetch (onResync) |

`TOPICS` lists `pins`. Payloads stay small (ids, never rows). A new topic or event goes through
your report.

---

## 7. Stand-in extension points (`src/sim/vendors`)

### 7.1 Deere route modules (`src/sim/vendors/deere/modules.ts`)

The core router (`routes.ts`) keeps OAuth, `GET /organizations`, `/organizations/{org}/machines`
(now with `equipmentType`, `equipmentMake` and `equipmentModel` names from the simulated machine;
doc-derived), a **minimal `/organizations/{org}/fields`** (paged; ids from `simDeereFields(farm)`
in `platform.ts`: each demo field under its owning unit's org with `SimField.deereFieldId`, plus
its `sharedWith` copy; `self`, `owningOrganization` and `fieldOperation` links), and
`/machines/{id}/breadcrumbs`. Every `GET /deere/platform/...` call goes to the modules in
`DEERE_ROUTE_MODULES` order **first**; the first non-null reply wins; then the core routes; else
404 "not simulated". So deere-ops lists fields in sim before deere-data's module lands, and that
module shadows the core listing with the full shape under the same ids.

```ts
interface DeerePlatformRequest { req: SimRequest; ctx: VendorContext; parts: string[] /* after /platform */; base: string }
interface DeereRouteModule {
  key: 'connections' | 'fields' | 'ops';
  route?(r): SimResponse | null | Promise<…>;                    // answer only your paths
  orgLinks?(org: { id, name }, r): DeereLink[];                    // extra links on GET /organizations
  control?(req, ctx: VendorControlContext): SimResponse | null | Promise<…>;  // /_control/vendor/deere/<key>/…
}
deereModuleState(ctx, key)   // the persisted knob bag state.vendors['deere.<key>'] (persist() after a change; reset clears it)
deereModuleWith(mods)        // a Deere stand-in with these modules (tests)
// helpers (./platform.ts): apiError, paging, collection, pagedReply, platformBase, simDeereOrgs,
//   simDeereFields(farm) → { orgId, deereFieldId, field, shared }[] (which org lists which demo field)
```

| Module (file) | Owner | Paths |
|---|---|---|
| `connections` (`connections-routes.ts`) | sync-health | refuses every org-scoped path (`/organizations/{org}/…`, core ones included) of an org its knob marks "needs approval" with Deere's 403 body; adds the `connections` link to that org; knob under `/_control/vendor/deere/connections/…` (types in a types-only `connections-control-types.ts` the admin page imports, NWS pattern) |
| `fields` (`fields-routes.ts`) | deere-data | `/organizations/{org}/farms`, `/clients`, `/fields` (shadowing the core listing; the same `simDeereFields` ids), `/fields/{f}`, `/boundaries`, `/fields/{f}/boundaries`, `/flags`, `/fields/{f}/flags`, and engine hours `/machines/{id}/engineHours` (1f is pinned to the `/platform` paths; equipment is the core machines listing, never shadowed); org links `fields`, `farms`, `boundaries`, `flags`. It may serve **one Deere-only field** in the home org that isn't in the seed (from a pure function of its own), so the creation path (a Deere field the app didn't know lands in its Deere farm with tenure `unknown`) shows in sim |
| `ops` (`ops-routes.ts`) | deere-ops | `/organizations/{org}/fields/{f}/fieldOperations` (honouring `cropSeason` and `fieldOperationType`), `/fieldOperations/{id}`, `/fieldOperations/{id}/measurementTypes`, `/fieldOperations/{id}/boundary`, and any org-wide operations listing deere-ops confirms. Sources: **this season's work** from the day reports (§7.2; harvest-day's 2026 seeding, which no day report plants, from the helper below); **past seasons** per field and crop season from `src/sim/seasons.ts`: seeding and harvest for `SEASON_YEARS` (`simFieldSeasons`: planted and harvested dates, variety, yield) and the `CURRENT_CROP_YEAR` planting (`cropFor` plus a planting date from deere-ops' own pure helper; `seasons.ts` stays as is), with the field boundary as coverage. It can emit a full-day sprayer coverage (the plan §5 full-size payload) |

Ids and shapes follow the demo seed (`simExternalRefs`; the field tuples are exactly
`simDeereFields`): sim mode must map onto the seeded rows, never create duplicates. Each module
is created empty by the foundation (it serves nothing).

### 7.2 Day reports (`ctx.days`)

`VendorContext.days` / `VendorControlContext.days`: `SimDayReports { dayIndexAt(simTime),
dayWindow(index), dayReport(index): SimDayReport }` (src/sim/world.ts: per day, `work` ranges
with machine, op, field, acres, first/last time, passes and implement width; `loads`; `events`),
or null for a world without them (the stub world). Days run 05:00-05:00 local; index 0 is the
scenario's first day; a day is planned on first use (tens of ms) and cached. A field's work range
that ended before sim-now is a finished operation. Contract tests that need it start the stand-in
with `createWorld: createSimWorld` (src/sim/index.ts); the stub world keeps `days = null`.

**Time base:** like breadcrumbs (contracts §9, the time rule in `src/sim/types.ts`), stand-in
operations from the day reports are stamped in **wall time**: a sim instant `s` is reported as
`wall_now − (sim_now − s) / speed`, the current clock segment's inverse of `wallToSim` (deere-ops
writes and tests that helper in its module, the paused clock included; `src/sim/vendors/clock.ts`
stays as is). So "this crop season" and the provisional → final rule (24 h) run on wall time, and
a field the sim finished a sim hour ago at 30x shows as finished two wall minutes ago. Past
seasons (`src/sim/seasons.ts`) are served with their dates as written.

### 7.3 Samsara (fleet-faults)

`faultCodes` is a stats feed type of its own call (Samsara allows at most 3 `types` per request
and `SAMSARA_STAT_TYPES` is full), served on `/fleet/vehicles/stats/feed?types=faultCodes`.
**1f.2:** the vehicle feeds serve `simTelematicsMachines(farm, 'samsara', { feed: 'vehicle' })`
(the four semis and the two pickups); a carmaker-cloud pickup reports positions on its own 30 s
grid and its stats feed leaves out what `statsNotReported('samsara', via)` lists; the
`faultCodes` type does the same for the pickups (Ford Pro: OBD-II only). The router asks
`SAMSARA_ROUTE_MODULES` (`./modules.ts`: part B's `equipment` and `vehicles`, created empty) first. A
stand-in-only schedule gives one semi in the `breakdown` scenario a red-stop-lamp code at a fixed
time (keyed on `world.scenario` and `world.startsAt`; the sim world is not changed); a knob at
`/_control/vendor/samsara/fault-codes` (types-only `control-types.ts`, NWS pattern) sets or clears
a code on any vehicle, which is how the contract tests drive the stub world. A `/admin/connectors`
toggle for the knob is the integrator's after merge.

### 7.4 Simulated flags (deere-data)

`src/sim/farm/flags.ts`: a pure function of the `SimFarm` (and a seeded rng) giving a few flags
per Deere field (Point, LineString, Polygon; categories such as Rock, Wet spot, Tile blowout).
Not imported by `src/sim/farm/build.ts`, so the sim's determinism hashes don't move.

### 7.5 Ground truth for counting

`GET /_control/stats` (`requests` per vendor) is the stand-in's own count: sync-health's tests
compare the app's counts against it.

---

## 8. Replay (`src/connectors/replay.ts`, contracts-m1 §10 still holds)

- **Lists and order** (first match wins): `deereReplayFixtures` = deere-ops
  (`deere/ops/replay.ts`) → deere-data (`deere/fields/replay.ts`) → the 1a doc-derived set
  (`deereDocDerived1aFixtures`). `samsaraReplayFixtures` = doc-derived
  (`samsaraDocDerivedFixtures`, fleet-faults adds its `faults` fixture there). **Recorded fixtures
  are a separate list** (1f fix): `deereRecordedFixtures` / `samsaraRecordedFixtures`
  (`<source>/replay-recorded.ts`, sync-health) are read only by the contract and conformance
  tests, never served in replay mode (the board), because their ids are hashed.
- **Files:** `src/connectors/<source>/fixtures/doc-derived/<stream>/<nn>-<name>.json`; Deere
  numbers `20`-`29` are deere-data's, `30`-`39` deere-ops's (1a's are `01`). Each builder's own
  test checks its files (committed JSON = its builder's output, live schemas,
  `replayFixtureSchema`, "no real farm data" in `reference`). A `20`-`29` fixture may serve one
  Deere-only field that isn't in the seed (the creation path, §7.1).
- **No two exchanges answer the same request** (method, path, query) across a source's list
  (`deere/fixtures/fixtures.test.ts`); shadow a 1a exchange only with a more specific `query`.
- **Recorded fixtures in 1f** (decision 3): `deereRecordedFixtures` and `samsaraRecordedFixtures`
  **stay empty**, and nothing is committed under `…/fixtures/recorded/`. `connectors:record
  --scrub` run against sim inside a test writes to a temp dir (`--out <dir>`) and is never
  committed. The **CI conformance test** (sync-health) compares the shapes of the doc-derived
  fixtures, and of those in-test sim recordings, against the stand-in's replies. The recorder
  **skips** every endpoint the stand-in answers 404 "not simulated" (it lists them as skipped).
  A real recording that lands later (Derrick's PC) joins the recorded list; the doc-derived
  fixtures keep serving the board (their ids are the seed's), and the uniqueness test checks each
  list on its own. Recordings drive contract and conformance tests, **not the demo board**.
- **Query parameters a fixture doesn't name are ignored**, so per-season exchanges carry
  `query: { cropSeason: 'YYYY' }` (and `fieldOperationType` where it matters); they come first by
  the order above.
- **No-shift (deere-ops adds it):** `ReplayFixture.noShift?: true` (+ `replayFixtureSchema`). With
  it every instant in the bodies is served as written (historical seasons 2022-2026 keep their
  dates), replays are byte-identical at any time, and `shiftStepSeconds` must be absent (the
  schema refuses both). Fixtures without it behave exactly as today.
- **OAuth is skipped** in replay (fixed token), as in 1a. A replay connection sees every fixture
  org as `connected` unless a fixture says otherwise; its home org is `DEERE_REPLAY_HOME_ORG`
  (decision 8).
- **CI:** the step "End-to-end in replay mode" (`CONNECTOR_DEERE=replay`,
  `CONNECTOR_SAMSARA=replay` since 1f.2) gains the slice spec `e2e/m1f-replay.spec.ts`
  (integrator, §11.5).

---

## 9. Scripts, dependencies, jobs

| Script | Entry | Owner | Today |
|---|---|---|---|
| `deere:backfill --seasons=2022-2026 [--replace] [--dry-run]` | `scripts/deere-backfill.ts` | deere-ops | stub: prints "not built yet", exits 0 |
| `connectors:record <source> [--scrub] [--out <dir>]` | `scripts/connectors-record.ts` | sync-health | stub: prints "not built yet", exits 0 |
| `test:live` | `vitest run --project live --passWithNoTests` (`**/*.live.test.ts`, one file at a time, 120 s timeouts; never in CI) | sync-health (the suites) | no suites yet: passes |

**Jobs** (`src/jobs/registry.ts`, registered by the foundation; the builders replace the stubs):

| Job | Schedule | Demo (sim/replay/off) | Run | Owner |
|---|---|---|---|---|
| `deere.fields` | `17 * * * *` (plan §1) | 45 s | `runDeereFields` in `src/jobs/deere-fields.ts` (stub `{ items: 0, note: 'not built yet' }`) | deere-data |
| `deere.ops` | `*/15 * * * *` | 20 s | `runDeereOps` in `src/jobs/deere-ops.ts` (stub) | deere-ops |
| `fleet.deere` | `*/2 * * * *`, paced by decision 4 | 15 s | `runFleetDeere`, moved to `src/jobs/fleet-deere.ts` | sync-health |
| `fleet.trucks` | every 30 s | 5 s | `runFleetTrucks` in `src/jobs/fleet.ts` (+ the `faults` stream); 1f.2: Samsara only (`CONNECTOR_SAMSARA`) | fleet-faults |
| `fleet.motive`, `fleet.geotab`, `fleet.equipment`, `fleet.aemp`, `fleet.cnh`, `fleet.terminal`, `fleet.vehicles` | §B.4.8 | §B.4.8 | part B's files (stubs, `fleet.motive` the 1a placeholder) | part B |

`src/jobs/fleet.ts` re-exports `createFleetDeereJob`, `DEERE_STREAM`, `runFleetDeere`,
`FleetConfig` and `FleetJobOptions`, so existing imports keep working; the shared pieces
(`machineResolver`, `positionsUpsert`, `tickAfterRun`, `publishSyncStatus`, `httpFor`) are in
`src/jobs/fleet-shared.ts` (all frozen, §5.0). Job code still imports nothing from `tools/**` or
`scripts/**` (heavy work, the backfill and recording, is CLI-only). **Dependencies:** none added.

**Stream names** (`ingest.sync_state.stream` and `ingest.api_calls_daily.stream`; sync-health's
per-stream counts and pacing, `WEBHOOK_NUDGES` and the `/admin/connectors` rows the integrator's
e2e reads all use these):

| Source | Stream | Written by | What |
|---|---|---|---|
| `deere` | `locations` | `fleet.deere` (sync-health) | machine breadcrumbs (M0; `DEERE_STREAM`); paced, §5.5 |
| `deere` | `fields` | `deere.fields` (deere-data) | farms, clients, fields and their active boundaries |
| `deere` | `flags` | `deere.fields` | flags → pins |
| `deere` | `equipment` | `deere.fields` | machines (`extra.unmappedKinds`, §5.7) |
| `deere` | `hours` | `deere.fields` | engine hours |
| `deere` | `operations` | `deere.ops` (deere-ops) | field operations; field cap, §5.5 (`DEERE_OPERATIONS_STREAM`) |
| `deere` | `backfill` | `deere:backfill` (calls only, no `sync_state` row) | the CLI's calls |
| any | `record` | `connectors:record` (calls only) | the recorder's calls |
| any | `''` | — (calls only) | calls outside a sync step (the OAuth callback) |
| `samsara` | `positions`, `stats` (M0), **`faults`** (fleet-faults) | `fleet.trucks` | `WEBHOOK_NUDGES.samsara` gains `'faults'`; `deere` stays `['locations']` |
| part B | §B.4.8 | part B's jobs | one stream per port method (`positions`, `stats`, `faults`, `vehicles`) per source |

---

## 10. Decisions (defaults in force; easy to change; rows in `docs/decisions.md`)

| # | Default | Where it lives |
|---|---|---|
| 1 Season precedence | `deere:backfill` writes a season when the field has none for that crop year, or the existing row's source is `demo` or `deere`; never replaces `import` or `app` rows unless `--replace`; each skipped conflict is listed in the run's report. `import:seasons` keeps `--replace-deere` | `scripts/deere-backfill.ts`, `src/db/queries/deere-seasons.ts` |
| 2 Fault severity (1f.2: every vendor, per code system: `faultSeverity`) | **J1939:** critical = red stop lamp (`stopIsOn`); warning = amber warning, protect or malfunction (emissions) lamp; info = an active code with no lamp. **OBD-II:** warning = MIL on, or a confirmed or permanent DTC; info = pending (never critical). **OEM:** the vendor's own label when it says high/critical/stop (critical), medium/warning/caution (warning) or low/info (info), else fault = warning, caution = info. In a snapshot, no codes and no lamps clears. A critical fault never marks a machine down: it offers "Critical fault: mark down?" to driver and above (the status sheet with the reason pre-filled) | `src/domain/fault-codes.ts` (`faultSeverity`, `oemSeverity`), each vendor's mapper |
| 3 Recorded fixtures | raw responses only under `data/raw/recorded/<source>/` (gitignored); `--scrub` writes an anonymized copy (to `src/connectors/<source>/fixtures/recorded/<stream>/`, or `--out <dir>`): names to stable pseudonyms, ids hashed, coordinates moved into the demo area, tokens and auth headers dropped, each file validated by the live schemas, plus a check that no original id or name survives. **In 1f nothing is committed there and the recorded lists stay empty** (§8): recordings drive contract and conformance tests, not the demo board | `scripts/connectors-record.ts`, `tools/record/**` |
| 4 Deere call budget | `DEERE_DAILY_CALL_BUDGET` optional, sandbox/live calls only (`api_calls_daily.mode`); unset: cron cadence, "limit unknown"; set: the Deere jobs plan on 80 % of it: `fleet.deere` gets 80 % minus every other Deere stream's calls on the last full UTC day (floor 10 %), never faster than its cron; `deere.ops` caps the fields per run from what is left after the unpaced streams and locations at full cadence (floor 10 %); the page shows the split and warns when the streams other than locations alone exceed 80 % | `src/config.ts`, `src/connectors/deere/call-shares.ts`, `src/jobs/fleet-deere.ts`, `src/jobs/deere-ops.ts`, `SyncStepSpec.minIntervalSeconds` |
| 5 Deere Connections | an org whose listing carries a `connections` link (doc-derived, confirm) or answers 403 is "needs approval": skipped (never fails the others), shown on `/admin/connectors` with the approval link (per connector mode; orgs no longer listed are dropped), and on the sign-in callback page with an "Approve in Deere Connections" button that comes back to `/admin/connectors`. Customer orgs only after a data-rights agreement (2a, D17); nothing blocks the home org | `src/connectors/deere/orgs.ts`, `ingest.connector_orgs` |
| 6 Public callback | optional `DEERE_REDIRECT_URI` overrides `${PUBLIC_URL}/api/oauth/deere`; `docs/deere-callback.html` forwards `code` and `state` to `http://localhost:3000/api/oauth/deere` | `src/config.ts`, `src/connectors/endpoints.ts`, `docs/deere-callback.html` |
| 7 D6 boundaries | the owning org's active Deere boundary becomes the field's current boundary (a new version, `source = 'deere'`, written only when the geometry or the source changes; id from `'<boundary id>@<sha8>'`, §5.7); the previous current version, whatever its source (demo, sim, import, drawn, an older Deere one), becomes history, with lineage (its closed version); a sharing org's boundary only gets an external ref. Fields match by external ref, then `deere_field_id`, else are created: in a farm per Deere farm when the farms call works, else in the default import farm ("Home farm"); tenure `unknown` until set by hand; the sync never touches the hand-entered overlays | `src/connectors/deere/fields/`, `src/db/queries/deere-fields.ts`, `TENURES` |
| 8 Deere home org | `DEERE_HOME_ORG_ID` optional; unset: sim and replay use their simulated home org, sandbox/live the only org you are a member of when there is exactly one, else none (the page asks for the setting). Machines are created only from the home org; farms and fields from any other org get that org's customer party (created with source `deere` when missing) | `src/config.ts`, `src/connectors/deere/orgs.ts` (`deereHomeOrg`) |

Foundation choices beyond the brief (also defaults): tenure `unknown` joined `TENURES` and the
CHECK (the allowed values had none; the legends list only the four real tenures);
`api_calls_daily.day` is the UTC day and every HTTP attempt counts as a call (retries included,
since vendors count them), per connector mode (sim and replay never count against a budget);
`connector_orgs` per connector mode too; `fleet.deere` moved to its own file so sync-health and
fleet-faults never edit the same job file; **`pins`/`updated` is published by the writer, at
most once per run**, not by a database trigger as plan §4 says for jobs, assignments and pins
(1f's pin writes are bulk sync runs; 2c adds a trigger or a shared `publishPinsUpdated` helper for
single pins drawn on phones); WarRoomMap gained a generic tap seam (`tapLayers` / `onFeatureTap`,
machine > pin > field) so the pin popup needs no map change; the core Deere stand-in serves a
minimal fields listing and the machines' equipment type, make and model, so the builders' sim
paths work before the merge; `machine_state` CHECKs the vendor and the fault list's type;
`farm.operations.operator_name`.

---

## 11. Done when

Every builder: §2 "Quality" green in its worktree, sim **and** replay paths tested, the report
written. Then, per builder:

### 11.1 deere-data

- `pnpm dev` (sim) and `CONNECTOR_DEERE=replay`: after `deere.fields` runs, the 40 demo fields
  keep their ids (matched through external refs: no duplicate field, farm or machine; an
  imported field with `deere_field_id` set is matched and gets its ref), each has its owning
  org's Deere boundary as the current version (`source = 'deere'`, the §5.7 writer: the seeded
  `demo` version is now history and the `boundary` ref points at the new one; the sharing org's
  boundaries only got refs); a second run writes no new version. The Deere-only field (stand-in
  or a `20`-`29` fixture) lands in its Deere farm with tenure `unknown`; the hand-entered
  overlays are untouched. Flags show as read-only pins (the "Deere flags" toggle in the rail, a
  popup on `/board` and `/m` that never opens the field panel under it). Every Deere machine **of
  a mappable kind** in the home org exists; other kinds are listed once on `/admin/connectors`
  (`extra.unmappedKinds`), not logged every run; no machine is created from a customer org; a
  farm created in a customer org gets that org's party. Engine hours land in
  `machines.engine_hours` + `farm.machine_hours` (the fleet panel shows them once fleet-faults'
  row text merges).
- A needs-approval org (sync-health's knob, or a 403 in your contract test) is skipped and the
  others sync.
- With no home org (sandbox/live with several member orgs and `DEERE_HOME_ORG_ID` unset, in a
  test) no farm, field or machine is created (`deereMayCreateRows`); rows with refs still update.
- Tests: contract tests per new call (sim and replay), mapper units (kind mapping, flag
  categories), DB tests (a second run changes nothing; ids survive `db:reset` + re-sync; D6
  versioning: same geometry = no version, an edit = a new version, A → B → A = a `#1` version,
  the ref re-pointed, a sharing org's boundary only a ref; field match order; overlays kept;
  the customer party), `e2e/deere-fields*.spec.ts` (pin popup on `/board` and `/m`).

### 11.2 deere-ops

- Sim: a field the simulation finishes shows its operation (kind, acres, products, coverage) in
  the History tab within about a minute at the demo cadence (wall-time stamps, §7.2); replay:
  the 2026 fixture operations land.
- `pnpm deere:backfill --seasons=2022-2026` in replay **and in sim** (the ops module's past
  seasons from `src/sim/seasons.ts` and the 2026 planting) writes the 2022-2026 seasons of the
  demo fields under decision 1 (its report lists skipped `import`/`app` rows; `--replace`
  replaces them under the deterministic season id; a second run changes nothing); the History
  tab shows each season's source.
- The ops module can emit a **full-day sprayer coverage** (plan §5's full-size payload), and a
  test asserts that map plus upsert of that one item takes **under 10 s** (prodlike timing).
- With a budget set, the per-run field cap (§5.5) holds and the fields checked longest ago go
  first (unit + DB test with seeded `api_calls_daily` and `sync_state` rows).
- `noShift` in `replay.ts` with its unit test; `normalizeCrop` shared from `src/domain/crops.ts`
  (`import:seasons` tests unchanged and green).
- `deere:backfill` runs its work inside `withCallStream('backfill', …)` (§5.5), so its calls count
  under `backfill` once sync-health's counter lands (a unit test sees `VendorCall.stream`).
- Tests: contract (sim with `createSimWorld`, replay), mapper and crop units, DB tests
  (idempotent upserts, clipping against the boundary valid at `started_at`, decision 1 cases,
  `operator_name`), `e2e/deere-ops*.spec.ts`.

### 11.3 fleet-faults

(1f.2) Also: the writer takes the one fault model: a `delta` report test (open, refresh, close,
an older item that changes nothing) and every system's columns stored (`m1f-schema.db.test.ts`
already checks the CHECK); the badge labels any vendor id through `vendorLabel` with its
connection's mode; `notReported` / `via` / `kindSetBy` / `positionKind` selected in
`fleetPanelMachines`; the row text through `formatVehicleStat` ("not reported" for the Ford
pickup's engine hours in sim).

- Sim, `breakdown` scenario: the semi's critical code shows a badge on the fleet panel within one
  `fleet.trucks` run; a driver sees "Critical fault: mark down?" which opens the sheet with the
  reason filled in; a viewer sees the badge only; clearing it with the knob clears the badge; an
  older page never brings it back, not in `machine_state` and not in `machine_faults`. Replay:
  the doc-derived `faults` fixture lands.
- Every machine row shows its vendor + mode badge and its engine hours, odometer and fuel when
  known; a Deere-only machine that stopped working shows "Last working position, N min ago" (the
  panel only, §5.3); fuel never moves back to an older reading; a fault seen before the
  machine's first fix shows once the fix arrives; Samsara hours and odometer land in
  `farm.machine_hours` and never move `machines.engine_hours` / `odometer_mi` back.
- Tests: mapper (every decision 2 case, cleared), contract (sim: type parameter, cursor; replay;
  fixture drift), DB (stored, cleared, out of order for both tables, first fix seeds the summary,
  machine_hours appended, invalidate published), `model.test.ts`, `e2e/fleet-panel*.spec.ts`
  green in sim and in replay.

### 11.4 sync-health

(1f.2) Also: `/admin/connectors` lists every connection with its mode key and mode, its capability
matrix from `capabilityMatrix(cfg)` (and the AEMP provider rows), says which clients aren't built
yet, and shows `cfg.connectorAliasNotes` while `CONNECTOR_ELD` / `ELD_VENDOR` are set (an e2e with
a deprecated key set shows the warning). `withCallStream` counts and flushes the CLIs' calls under
`backfill` / `record`.

- `/admin/connectors` (manager): calls today and yesterday per source and mode with the budget
  ("limit unknown" when unset) and the §5.5 split with its warning, the "Runs" label, dead
  letters with the total count plus requeue and discard (a viewer or driver gets 403), the
  doc-derived list, the Deere OAuth status (connected, expiry, scopes; a Connect link outside
  sim), each org's approval status for the current mode (sim's orgs gone after a switch), the
  home org and where it came from (or the request to set `DEERE_HOME_ORG_ID`), and the
  unmappable Deere equipment; the knob makes an org need approval and the other orgs' locations
  keep flowing.
- After sign-in the callback page lists the orgs that need approval with "Approve in Deere
  Connections" links that come back to `/admin/connectors` (`redirect_uri`, no 3xx).
- App call counts match the stand-in's `/_control/stats` for a run, under the run's mode; with a
  budget set (sandbox mode against the stand-in in a test), `fleet.deere`'s `next_run_at`
  follows the split (unit tests are `call-shares.test.ts`'s; add a DB test with seeded
  `api_calls_daily` rows, sim rows ignored).
- `DEERE_REDIRECT_URI` is used by the authorize URL and the exchange; the forwarder template
  exists and is linked from README's Deere section (integrator adds the link).
- `pnpm connectors:record deere --scrub --out <tmp>` against the stand-in (sim, in a test) writes
  raw files and scrubbed fixtures that pass the live schemas, with the "no original id or name
  survives" check, skipping (and listing) the endpoints the stand-in answers 404 "not simulated";
  nothing is committed (§8). The conformance test (doc-derived fixtures and in-test recordings vs
  stand-in shapes) runs in CI against sim; `pnpm test:live` suites exist and skip with a clear
  message without credentials.
- Tests and `e2e/sync-health*.spec.ts`.

### 11.5 The slice (integrator, after merging)

- All four branches merged into `claude/m1-1f`, the stubs gone, `pnpm lint`, `typecheck`, `test`,
  `test:db`, `build` and the full e2e suite green, the M0 and M1 demo specs included.
- **Replay e2e** `e2e/m1f-replay.spec.ts` (integrator), run in CI's replay step with
  `CONNECTOR_DEERE=replay` and `CONNECTOR_SAMSARA=replay` (it skips itself under the sim stack, like
  `fleet-panel-replay.spec.ts`): it runs `pnpm deere:backfill --seasons=2022-2026` against the
  app's database (process.execPath + tsx, `src/lib/proc.ts`), then on `/board`: Deere fields
  with no duplicates, flags as pins in the rail and a popup, Deere machines with engine hours, a
  field's History tab with this season's operations and the 2022-2026 seasons marked Deere, the
  Samsara fault badge on the fleet panel, and `/admin/connectors` with call counts, the
  doc-derived list and the org status. The same flow is checked by hand in sim (`pnpm dev`).
- The integrator's own changes after the merge: the two `data:import` rules of §3.2 with their
  round-trip cases; the map markers' and board card's "last working position" state from
  fleet-faults' report (§5.3); BoardScreen's pin lines (§1.2) checked; any `db/pending` folded
  into a migration.
- `docs/build-plan.md` 1f boxes ticked with an as-built note, `docs/decisions.md` rows current,
  `docs/status.md` entry, README (Deere sandbox on the PC, `DEERE_REDIRECT_URI`, the call budget,
  `pnpm deere:backfill`, `pnpm connectors:record`, `pnpm test:live`).

---

## 12. For Derrick's PC (not buildable here)

- Slice 1e's `db/pending/pc-1e.sql` takes the next free migration number when it merges (0007
  went to 1f).
- With a Deere app: `CONNECTOR_DEERE=sandbox`, `DEERE_CLIENT_ID` / `DEERE_CLIENT_SECRET`, sign in
  at `/api/oauth/deere` (or through the `DEERE_REDIRECT_URI` page), approve each org in Deere
  Connections (the callback page links them), set `DEERE_HOME_ORG_ID` if the page asks (more than
  one org), then `pnpm connectors:record deere --scrub` and `pnpm test:live`. A real recording
  that lands replaces the doc-derived exchange it overlaps (§8). Never point the PC at Derrick's
  production Deere organization without his say-so (PC-AGENT.md).
- **Farm-side action (plan §6 1f): submit the Deere production-access request by Feb 1.**

---
---

# Part B. Slice 1f.2 "Multi-vendor telematics" (three more builders)

Oct 30, 2026 · the foundation's amendment pass for Derrick's direction: **support the most popular
truck telematics and machine brands, and Ford and Ram pickups, not one vendor each.** Research:
`vendors-synthesis.md` (trucks and machines) and `layers-pickups-synthesis.md` §1 (pickups), Oct
30. Claims those label "snippet" or "unconfirmed" are not confirmed endpoints (§B.5). Part A
(§1-§12) still binds, amended where marked **1f.2**.

**What the foundation already did** (one amendment pass, before any builder starts; the commits
on `claude/m1-1f` this part was written with):

| Brief item | Where it landed |
|---|---|
| 1. Vendor-neutral vehicle telematics port | `src/connectors/types.ts`: `VehicleTelematicsSource` (positions, stats, faults, vehicles), `NormalizedPosition.positionKind` (`live` \| `last_known`) and `.provider`, `NormalizedVehicleStat` + `defPct`, `engineOn`, `readings` (`StatReading`: raw value, raw unit, `adjusted` flag, vendor field), `normalizeStat`, `VEHICLE_STAT_FIELDS`, `NormalizedVehicle`; `TELEMATICS_SOURCES`, `TRUCK_VENDORS`, sources `geotab`, `aemp`, `cnh`, `terminal`. `upsertPosition` stores `last_known` fixes in machine_state only; `FLEET_STALE_SECONDS_LAST_KNOWN` (3 h) |
| 2. One fault model | `src/domain/fault-codes.ts` (`NormalizedFault`, `faultCodeKey`, `faultSeverity`, `oemSeverity`, `normalizedFault`, `toFaultCode`; snapshot vs delta reports); `farm.machine_faults` system columns and CHECK (§3.1) |
| 3. Many connections at once | one mode key per vendor and every vendor's credentials (§B.3), the deprecated `CONNECTOR_ELD` / `ELD_VENDOR` alias with its warning (`resolveConnectorModes`, `cfg.connectorAliasNotes`, shown on `/admin/connectors` and by `pnpm dev`); per-vendor endpoint resolvers in `src/connectors/endpoints.ts`; one job per connection (§B.4.8) |
| 4. Vendor list without migrations | `machine_state.position_vendor` CHECK is a format; `src/connectors/vendors.ts` registry (`VENDORS`, `vendorLabel`, `connectionOf`) |
| 5. Capability matrix | `VendorCapabilities` per entry, `capabilityMatrix(cfg)`, `capabilitiesFor(vendor, via)`, `statsNotReported` (`src/connectors/vendors.ts`) |
| 6. Two sync models | `src/connectors/sync-models.ts`: `pollVersionFeed`, `pollSnapshotDiff` |
| 7. Mixed demo fleet | `src/sim/farm/fleet.ts` + `SimMachine.telematics` (`src/sim/types.ts`, `simTelematicsMachines`), seed refs and `telematics_via`, the Samsara stand-in serving the pickups, empty stand-ins for the new vendors (§B.7) |
| 8. The four minor fixes | `withCallStream` (§5.5), recorded fixtures in their own list (§8), draw mode disables `onFeatureTap` (§1.2, §5.2), nothing created without a home org (§5.4, `deereMayCreateRows`) |
| 9. Pickups | kinds `pickup` / `service_truck` / `loader`, `machines.telematics_via` and `kind_set_by` (§3.1), `src/domain/vehicles.ts` (`VEHICLE_KIND_TAGS` rules, `vehicleKindFromTags`, `nextVehicleKind`), the writer `src/db/queries/vehicles.ts`, "not reported" (`formatVehicleStat`, `src/ui/vehicles/stats.ts`), the pickups' 30 s cadence in the stand-in |

## B.1 Who owns what

The three builders' paths are disjoint from each other and from part A's four builders (part A's
§1 globs now exclude the files below). Everything else stays integrator-owned (§1.1), including
the contract files of this part: `src/connectors/{types,vendors,sync-models,endpoints}.ts`,
`src/domain/{fault-codes,fleet,vehicles}.ts`, `src/sim/types.ts`, `src/sim/farm/fleet.ts`,
`src/sim/vendors/samsara/modules.ts`, `src/jobs/registry.ts`, `src/config.ts`. A contract that
doesn't fit: work around it and say what you need in your report.

| Key | Builds (brief) | Owns (may create and edit) | Dev ports | Dev database |
|---|---|---|---|---|
| **trucks** | **Motive**: positions from `GET /v1/vehicle_locations` (v1, or v2 when it confirms; **v3 only for vehicles with a Motive Vehicle Gateway**, falling back to v1/v2 for the rest), stats from `true_engine_hours` / `true_odometer` (`readings.*.adjusted = true`; the raw `engine_hours` / `odometer` as `adjusted = false` when only those come), faults from `GET /v1/fault_codes` as `delta` reports (open/closed status), the host from `MOTIVE_API_BASE` (default `https://api.gomotive.com`), **no hard-coded webhook event names** (poll; sources disagree on `vehicle_location_updated` vs `vehicle.location_updated`), doc-derived replay fixtures (this lifts part A's "Motive has no replay fixtures"); the snapshot-diff sync model. **Geotab**: MyGeotab JSON-RPC over our own `vendorFetch` (**no new dependency**, not `mg-api-js`): `Authenticate` (the session reused across runs, kept in `ingest.oauth_tokens` through `OAuthTokenStore` with source `geotab`, re-authenticated on `InvalidUserException`; Authenticate at most 10/min), `GetFeed` for `LogRecord` (positions), `StatusData` (engine hours, odometer, fuel: `readings` with the Diagnostic id as `field`) and `FaultData` (J1939 through the Diagnostic lookup, OBD-II after the hex conversion; `delta`) with the stored `toVersion` (the cursor/version model, `pollVersionFeed`; GetFeed at most 60/min, ~30 s apart), `GEOTAB_SERVER` / the server Authenticate redirects to; sandbox = the free demo database. Each with its stand-in, contract tests and fixtures | `src/connectors/motive/**`, `src/connectors/geotab/**`, `src/sim/vendors/motive/**`, `src/sim/vendors/geotab/**`, `src/jobs/fleet-motive*.ts`, `src/jobs/fleet-geotab*.ts`, `e2e/trucks*.spec.ts` | 3115 / 4025 | `farm_dev_trucks` |
| **machines** | **The generic ISO 15143-3 (AEMP 2.0) client**: lenient zod with the standard's PascalCase keys, **every element optional**, JSON or XML (`format` per provider; `auto` = by Content-Type; parse XML with a small hand-written reader over the fixed element set, no new dependency unless named in the report), per-provider base URL and auth style (`AEMP_PROVIDERS`), `Fleet/{pageNumber}` pages → **last-known positions** (`positionKind: 'last_known'`, `provider` = the provider id, never breadcrumbs) and stats (cumulative operating hours, fuel remaining %, DEF remaining %, odometer, engine status; `readings` with the element name), the fault time series where a provider has it (`delta`); the snapshot-diff model; fixtures from the Samsara SDK types, Deere's `aemp.yaml` example and Trackunit's OpenAPI. **The AEMP stand-in** serving providers `cnh` (the Case IH combine and tractor until CNH's own shapes are confirmed), `kubota` (the loader) and `samsara` (Samsara's asset-gateway machines; Samsara's `/beta/aemp/Fleet/{pageNumber}` is the first live target). **Samsara equipment feeds**: `/fleet/equipment/locations/feed`, `/fleet/equipment/stats/feed` (gps, fuelPercents, gatewayJ1939EngineSeconds, synthetic engine seconds; `readings.engineHours.adjusted` true for synthetic or offset seconds) for the RoGator, in Samsara's equipment-feed stand-in module. **CNH FieldOps scaffolding only**: OAuth at the CNH identity server (`CNH_AUTH_BASE`, tokens through `OAuthTokenStore` source `cnh`, callback `/api/oauth/cnh`), the subscription-key header, and in its stand-in the EULA-403 (a machine whose owner hasn't accepted) and staging/production states (an app still in staging answering a production call); base URL and paths as config; **no fixtures for unconfirmed shapes** | `src/connectors/aemp/**`, `src/connectors/cnh/**`, `src/connectors/samsara/equipment*.ts`, `src/sim/vendors/aemp/**`, `src/sim/vendors/cnh/**`, `src/sim/vendors/samsara/equipment-routes*.ts`, `src/jobs/fleet-aemp*.ts`, `src/jobs/fleet-cnh*.ts`, `src/jobs/fleet-equipment*.ts`, `src/app/api/oauth/cnh/**`, `e2e/machines*.spec.ts` | 3116 / 4026 | `farm_dev_machines` |
| **terminal-pickups** | **Terminal**: the normalized API (`Authorization: Bearer <secret key>`, the `Connection-Token` header, sandbox base `https://api.sandbox.withterminal.com/tsp/v1`): `/providers` (what each linked provider can do: the capability matrix's Terminal row and per-provider rows), vehicles, latest vehicle locations (`last_known`) and historical ones (`live`), stats, fault code events (`delta`); `provider` = the TSP behind the connection (`terminal_<provider>` badge); **stand-in only until sandbox access**. **Pickups** (brief item 9): vehicle kind from a vendor tag (Samsara `GET /fleet/vehicles` tags through `VEHICLE_KIND_TAGS`, the `fleet.vehicles` job; written with `applyVendorVehicle`) or on `/admin/vehicles` (`setMachineKindByAdmin`, manager; wins over tags), `telematics_via` where the vendor reports it (`ford_pro`, `stellantis`, `gateway`), "not reported" for stats a carmaker feed doesn't report, the fleet panel and map styling for pickups and service trucks | `src/connectors/terminal/**`, `src/connectors/vehicles/**`, `src/connectors/samsara/vehicles*.ts`, `src/sim/vendors/terminal/**`, `src/sim/vendors/samsara/vehicles-routes*.ts`, `src/jobs/fleet-terminal*.ts`, `src/jobs/fleet-vehicles*.ts`, `src/db/queries/vehicles*.ts`, `src/ui/vehicles/**`, `src/app/admin/vehicles/**`, `src/ui/map/fleet/style*.ts`, `e2e/pickups*.spec.ts` | 3117 / 4027 | `farm_dev_terminal_pickups` |

Files the foundation created for you (stubs; fill them, keep the exported names):
`src/jobs/fleet-{motive,geotab,equipment,aemp,cnh,terminal,vehicles}.ts` (`fleet.motive` is the
1a placeholder, the rest return `{ items: 0, note: 'not built yet' }`),
`src/connectors/{motive,geotab,aemp,cnh,terminal,vehicles}/doc-derived.ts` and
`src/connectors/samsara/equipment-doc-derived.ts` (each `*_DOC_DERIVED`, already appended to
`DOC_DERIVED`), `src/connectors/{motive,geotab,aemp,terminal}/replay.ts` (each
`<source>ReplayFixtures`, already wired into `replayFetch`), the stand-ins
`src/sim/vendors/{geotab,aemp,cnh,terminal}/routes.ts` (404 "not simulated") and
`src/sim/vendors/samsara/{equipment,vehicles}-routes.ts` (answer null), `src/db/queries/vehicles.ts`
and `src/ui/vehicles/stats.ts` (working, tested; frozen exports, §B.4.5).

Integrator after the merge (each builder lists what it needs in its report): the admin nav link to
`/admin/vehicles`, mounting terminal-pickups' kind badge in the fleet panel row, the Geotab check
in `tools/vendor-sim/connect.ts`, the pickups in the Samsara replay fixtures (one filter line in
`src/connectors/samsara/fixtures/build.ts` and a regenerate), registry capability updates.

## B.2 Working rules

§2 holds, with these values:

- **Start from this commit** of `claude/m1-1f` (the foundation's 1f.2 commit; you may run in
  parallel with part A's builders: your paths never meet theirs). Worktree:
  `git worktree add ../fm-<key> -b m1f2/<key> claude/m1-1f`; `pnpm install`; copy `.env`,
  `.env.local` and `.data/storage`.
- **Ports and database**: trucks `3115` / `4025` / `farm_dev_trucks`; machines `3116` / `4026` /
  `farm_dev_machines`; terminal-pickups `3117` / `4027` / `farm_dev_terminal_pickups`; the four
  lines of §2 in both `.env.development.local` and `.env.production.local`; then `pnpm
  db:migrate`, `pnpm db:configure local`, `pnpm db:reset` (seeds the mixed fleet),
  `pnpm db:pending` if you have one.
- **Every connection runs at once.** Your stand-in serves only your vendor's machines
  (`simTelematicsMachines`); a test that needs one vendor alone sets the other keys `off` in its
  config, never removes machines from the world.
- **What you can't test before part A merges.** fleet-faults' fault writer (`upsertVehicleStat`
  storing `NormalizedFault`s) lands with part A: your faults are tested as mapper output
  (`normalizedFaultSchema`, the `delta` states and times) and, in DB tests, only through what is in
  the tree at this commit (positions, stats). The integrator runs the combined DB test after the
  merge (§B.8.4).
- **No new dependency** unless your report names it (exact version from `npm view`, why).

## B.3 Configuration (`src/config.ts`; documented in `docs/contracts.md` §3)

| Key | Default | Meaning |
|---|---|---|
| `CONNECTOR_SAMSARA` | `sim` (`off` in production) | Samsara (trucks, pickups via carmaker clouds, asset gateways); `sim\|replay\|sandbox\|live\|off` |
| `CONNECTOR_MOTIVE` | `sim` (`off` in production) | Motive |
| `CONNECTOR_GEOTAB` | `sim` (`off` in production) | Geotab |
| `CONNECTOR_AEMP` | `sim` (`off` in production) | the generic ISO 15143-3 client |
| `CONNECTOR_CNH` | `sim` (`off` in production) | CNH FieldOps (no replay mode) |
| `CONNECTOR_TERMINAL` | `sim` (`off` in production) | Terminal |
| `CONNECTOR_ELD`, `ELD_VENDOR` | unset | **deprecated alias**: `CONNECTOR_ELD=<mode>` sets the key of `ELD_VENDOR`'s vendor (`samsara` default, `motive`, `geotab`, `terminal`) unless that key is set itself. `cfg.connectorAliasNotes` carries the warning `/admin/connectors` and `pnpm dev` show ("write `CONNECTOR_SAMSARA=replay` instead"); the raw keys never reach `Config` |
| `MOTIVE_API_KEY`, `MOTIVE_API_BASE` | unset; `https://api.gomotive.com` | Motive company key (`X-Api-Key`) and host |
| `GEOTAB_SERVER`, `GEOTAB_DATABASE`, `GEOTAB_USERNAME`, `GEOTAB_PASSWORD` | unset; `my.geotab.com` | the MyGeotab service user (never a person's login) |
| `AEMP_PROVIDERS` | unset (sim/replay: `cnh`, `kubota`, `samsara`) | JSON array of `{ id, label?, baseUrl, auth, token?, username?, password?, clientId?, clientSecret?, tokenUrl?, scope?, subscriptionKey?, subscriptionKeyHeader?, format? }`; `auth` = `none\|bearer\|basic\|oauth2\|subscription_key` |
| `CNH_CLIENT_ID`, `CNH_CLIENT_SECRET`, `CNH_SUBSCRIPTION_KEY`, `CNH_API_BASE`, `CNH_AUTH_BASE`, `CNH_REDIRECT_URI` | unset; `https://api-data.cnh.com/v1`, `https://identity.cnhind.com`, `${PUBLIC_URL}/api/oauth/cnh` | CNH FieldOps (sandbox = CNH staging); the redirect https in production |
| `TERMINAL_SECRET_KEY`, `TERMINAL_CONNECTION_TOKEN`, `TERMINAL_API_BASE` | unset; sandbox / live hosts | Terminal |
| `VEHICLE_KIND_TAGS` | `semi:Semi,pickup:Pickup,service_truck:Service truck` | the pickups route's key: which vendor tags set a vehicle's kind. Pickups have **no mode key of their own**: they ride on their telematics vendor's feeds |
| `FLEET_STALE_SECONDS_LAST_KNOWN` | `10800` | stale threshold of `last_known` fixes |

Secrets are optional in sim and replay; the endpoint resolver refuses a sandbox/live run without
the ones the vendor needs (`ConnectorModeError` with the key's name). Production refuses `sim` and
`replay` per key (the alias included). Read config only through `getConfig()` into your job's
options (`FleetConfig` has the mode keys; add the credential keys your client needs to your own
`Pick<Config, …>`).

## B.4 Contracts you build against

### B.4.1 The port (`src/connectors/types.ts`)

Implement `VehicleTelematicsSource` for your connection, through `runSyncStep` (poll returns raw
items; `map` is pure and returns the normalized types; `upsert` writes):

- **positions** → `NormalizedPosition` (`positionSource: 'eld'` for every telematics device;
  `positionKind: 'last_known'` for a vendor snapshot, `provider` for an aggregator's provider),
  written with `positionsUpsert(machineResolver())` (`src/jobs/fleet-shared.ts`, frozen), which
  calls `upsertPosition` (vendor id and kind stored; a `last_known` fix moves machine_state only).
  Afterwards `tickAfterRun(staleThresholdsOf(cfg))`.
- **stats** → `NormalizedVehicleStat` with normalized units (`normalizeStat`: hours, miles,
  percent) **and** `readings` for every field you set (the vendor's number, unit, `adjusted`,
  field name); write with `statsUpsert(machineResolver())` (`src/jobs/fleet.ts`). A field the
  vendor didn't send is **absent**, never 0.
- **faults** → `NormalizedVehicleStat` items with `faultCodes: NormalizedFault[]` (built with
  `normalizedFault()`) and `faultReport: 'delta'` (or `'snapshot'` if your vendor answers the full
  active set), through the same `statsUpsert`.
- **vehicles** → `NormalizedVehicle` (tags, `kindFromTags = vehicleKindFromTags(tags,
  cfg.VEHICLE_KIND_TAGS)`, `via`), written with `applyVendorVehicle` (§B.4.5).
- External refs: resolve with `machineResolver` and the tuple of §3 / `src/connectors/types.ts`
  (AEMP: `source_org` = the provider; Terminal: the connection id); an unmapped vehicle is skipped
  and logged once, never created (vehicle creation from a vendor list is not in 1f.2).

### B.4.2 Faults (`src/domain/fault-codes.ts`)

§5.3's model. Your mapper sets `system` and its fields, `lamps` when the vendor reports them,
`vendorSeverity` verbatim, `state` / `firstSeenAt` / `lastSeenAt` / `closedAt` from the vendor,
and the severity from `faultSeverity()` (decision 1f-2 per system; never your own rule). Motive
`/v1/fault_codes`, Geotab `FaultData`, AEMP fault series and Terminal fault events are `delta`.

### B.4.3 The registry and capability matrix (`src/connectors/vendors.ts`)

`VENDORS` (connection, provider and via entries; `kind` truck \| machine \| pickup;
`build` built \| planned \| fallback), `vendorLabel`, `connectionOf`, `capabilitiesFor(vendor,
via)`, `statsNotReported`, `capabilityMatrix(cfg)`, `connectionModes(cfg)`. Support levels: `yes`
(SDK or spec), `doc` (docs or a search summary: confirm), `unknown`, `no`. When you confirm or
refute a capability, **say so in your report** (entry id, field, new level, source); the
integrator edits the registry. Your position vendor ids: `motive`, `geotab`, `samsara` (equipment
too), `aemp_<provider>`, `cnh`, `terminal_<provider>`.

### B.4.4 The sync models (`src/connectors/sync-models.ts`)

- `pollVersionFeed({ cursor, fetchPage(token), maxPages, deadline, signal })`: Geotab `GetFeed`
  (`fromVersion` = the stored cursor, `toVersion` the next one; a full page means more).
- `pollSnapshotDiff({ cursor, fetchSnapshot, keyOf, versionOf, mode })`: Motive lists (`newer`
  by `located_at` per vehicle), AEMP pages (`newer` by the snapshot's own time per serial, key
  `<provider>:<serial>`), Terminal latest locations, per-vehicle calls. The cursor keeps one entry
  per vehicle (at most 5 000). The Motive placeholder's own per-vehicle cursor
  (`{"<vehicle id>":"<iso>"}`) is not that shape: moving it to `pollSnapshotDiff` starts over
  once (`parseSnapshotCursor` ignores the old shape; each vehicle's latest location is re-emitted
  once, harmless).

### B.4.5 Vehicles (`src/domain/vehicles.ts`, `src/db/queries/vehicles.ts`, `src/ui/vehicles/stats.ts`)

`VEHICLE_KINDS` (semi, pickup, service_truck), `KIND_SET_BY` (default, vendor, admin),
`TELEMATICS_VIAS` (ford_pro, stellantis, gateway, obd_device; any id of the vendor-id format is
stored), `parseVehicleKindTags`, `vehicleKindFromTags`, `nextVehicleKind`. **Frozen exports**
(terminal-pickups owns the files; only additive changes): `applyVendorVehicle(ex, machineId, {
kindFromTags, via })` (an admin-set kind never changes; `via: null` leaves it; returns `{ row,
changed }`), `setMachineKindByAdmin(ex, machineId, kind)`, `formatVehicleStat(field, value,
notReported)` and `NOT_REPORTED`. The `/admin/vehicles` control (manager: `requireRole(ROLE_FOR.
admin)`) sets a kind with `setMachineKindByAdmin` and publishes `fleet`/`invalidate` `{ event:
'machine', reason: 'changed' }`.

### B.4.6 Endpoints (`src/connectors/endpoints.ts`; wired, don't edit)

`motiveEndpoint`, `geotabEndpoint`, `aempEndpoints` (one per provider), `cnhEndpoints`,
`terminalEndpoint`: sim → the stand-in (`${VENDOR_SIM_URL}/motive`, `/geotab/apiv1`,
`/aemp/<provider>`, `/cnh/api` + `/cnh/identity`, `/terminal/tsp/v1`) with `SIM_CREDENTIALS`;
replay → the replay origin with `REPLAY_CREDENTIAL` (attach `replayFetch('<source>')` in your
client's `forMode`, as `SamsaraClient` does; CNH has none); sandbox/live → config or the
doc-derived default plus the required secrets. `MOTIVE_DEFAULT_BASE`, `GEOTAB_DEFAULT_SERVER`,
`CNH_DEFAULT_API_BASE`, `CNH_DEFAULT_AUTH_BASE`, `TERMINAL_SANDBOX_BASE`, `TERMINAL_LIVE_BASE`.

### B.4.7 The panel and the map (read-only for you)

The fleet panel (fleet-faults, part A) shows the vendor badge (`vendorLabel` · the connection's
mode), `formatVehicleStat` per stat with `notReported`, and `positionKind`; the map's stale logic
uses `staleAfterFor(source, t, positionKind)`. terminal-pickups styles kinds in
`src/ui/map/fleet/style.ts` (`KIND_COLORS`, `KIND_LABELS`, the icon atlas; the foundation added
placeholder colours for `service_truck` and `loader`) and builds a kind badge in
`src/ui/vehicles/**` that the integrator mounts in the panel row.

### B.4.8 Jobs and streams (registered by the foundation; replace the stubs, leave `registry.ts`)

| Job | Schedule | Demo | Connector | Streams (`source` / `stream`) | Owner |
|---|---|---|---|---|---|
| `fleet.trucks` | every 30 s | 5 s | `CONNECTOR_SAMSARA` | samsara / positions, stats, faults | fleet-faults (part A) |
| `fleet.motive` | every 30 s (25 s budget) | 5 s | `CONNECTOR_MOTIVE` | motive / positions, stats, faults, vehicles | trucks |
| `fleet.geotab` | every 30 s (25 s budget) | 10 s | `CONNECTOR_GEOTAB` | geotab / positions (LogRecord), stats (StatusData), faults (FaultData), vehicles (Device) | trucks |
| `fleet.equipment` | `* * * * *` | 10 s | `CONNECTOR_SAMSARA` | samsara / equipment_positions, equipment_stats | machines |
| `fleet.aemp` | `*/15 * * * *` | 30 s | `CONNECTOR_AEMP` | aemp / fleet (positions and stats from one page set), faults | machines |
| `fleet.cnh` | `*/5 * * * *` | 30 s | `CONNECTOR_CNH` | cnh / (scaffolding: whatever confirms) | machines |
| `fleet.terminal` | `* * * * *` | 15 s | `CONNECTOR_TERMINAL` | terminal / positions, stats, faults, vehicles | terminal-pickups |
| `fleet.vehicles` | `41 * * * *` | 59 s | `CONNECTOR_SAMSARA` | samsara / vehicles | terminal-pickups |

Positions streams publish the batched `fleet`/`tick` (`tickAfterRun`); other streams
`publishSyncStatus`. A stream's calls count under its own name (sync-health's counter, §5.5).
Webhooks stay out (they need a public endpoint: MD).

## B.5 Doc-derived rules

- Every host and path that isn't confirmed from an SDK or a published spec is **config with a
  doc-derived default** (the `*_API_BASE` keys, AEMP base URLs) or a named constant in your own
  client, marked `// doc-derived, confirm` at the line, with the doc URL in the comment.
- **Lenient schemas**: zod objects that accept unknown keys and make everything optional that the
  spec doesn't promise; parse failures of one item drop that item (logged with its id, no secrets),
  never the page. AEMP keys are the standard's PascalCase names.
- Every such assumption gets a `DocDerivedItem` in **your** list (`src/connectors/<source>/
  doc-derived.ts`; already aggregated into `DOC_DERIVED`, so `/admin/connectors` shows it): what,
  what to confirm, the file. The foundation's entries are there already; add yours.
- **Never invent endpoints**: confirm them (WebSearch/WebFetch, Context7, published OpenAPI
  mirrors, official SDK packages from the npm registry, which works) and cite them; a claim the
  research marks "snippet" or "unconfirmed" stays doc-derived until then.
- No hard-coded webhook names (Motive); no vendor-specific code outside your directories.

## B.6 Fixtures

- Replay fixtures go in `src/connectors/<source>/fixtures/doc-derived/<stream>/<nn>-<name>.json`,
  built by your own `fixtures/build.ts` from the simulated world (seed 1) with shapes from the
  vendor's published types (Motive and Geotab docs/SDK, Samsara SDK types, Deere `aemp.yaml`,
  Trackunit's OpenAPI, Terminal's CLI), listed in your `replay.ts`, and checked by your
  `fixtures/fixtures.test.ts`: committed JSON = the builder's output, every body valid under your
  live schemas and `replayFixtureSchema`, "no real farm data" in `reference`, every vehicle one
  the seed maps (`simExternalRefs`), no two exchanges answer the same request.
- **No fixtures for unconfirmed shapes** (CNH). Recorded fixtures never go in the replay lists
  (§8). Real farm data is never committed.
- Replay ids are the seed's (`SimMachine.telematics.id`), so replay mode drives the board.

## B.7 Stand-in extension points

- `simTelematicsMachines(farm, vendor, { feed?, provider? })` (`src/sim/types.ts`) lists the
  machines your stand-in serves; sample them with `ctx.world.machineAt(id, ctx.simAt(wall))`
  stamped with `wall` (the time rule). `SimTelematics` carries `id`, `provider`, `feed`, `via`,
  `reportEverySeconds`, `tags`.
- New vendor modules (`src/sim/vendors/{geotab,aemp,cnh,terminal}/routes.ts`) are registered in
  `server.ts` and answer 404 "not simulated" until you fill them; auth with `SIM_CREDENTIALS`;
  knobs under `/_control/vendor/<vendor>/…` through the module's `control()` (types in a types-only
  file, the NWS pattern). The AEMP module serves `/aemp/<provider>/…` for `SIM_AEMP_PROVIDERS`.
- Samsara: `src/sim/vendors/samsara/modules.ts` (`SAMSARA_ROUTE_MODULES`: `equipment` for
  machines, `vehicles` for terminal-pickups) answers before the core feeds.
- A vendor with no machine in the demo world (Terminal) adds its hired truck in a pure function of
  its own (never in `src/sim/farm/**`), as deere-data adds its Deere-only field.

**The mixed demo fleet** (`src/sim/farm/fleet.ts`; appended after the M0 machines, so their
motion, ids and the replay fixtures are unchanged; no scenario names the new machines, so they stay
parked in the shop yard, engines off):

| Unit | Machine | Kind | Connection (id source) | Via | Stand-in |
|---|---|---|---|---|---|
| C1, C2, GC1, GC2, SP1, P1 | John Deere | combine, grain_cart, sprayer, planter | deere | — | Deere (unchanged) |
| S1-S4 | Peterbilt, Kenworth, Freightliner | semi | samsara (vehicle feed) | — | Samsara (unchanged ids) |
| D1 | Hylio drone | drone | none | — | manual |
| C3 | Case IH Axial-Flow 8260 | combine | aemp, provider `cnh` | — | AEMP `/aemp/cnh` (machines) |
| T1 | Case IH Magnum 340 | tractor | aemp, provider `cnh` | — | AEMP `/aemp/cnh` (machines) |
| SP2 | RoGator RG1100C | sprayer | samsara (equipment feed) + aemp `samsara` | gateway | Samsara equipment module, AEMP `/aemp/samsara` (machines) |
| L1 | Kubota SVL97-2 track loader | loader | aemp, provider `kubota` | — | AEMP `/aemp/kubota` (machines) |
| H1 | hired Kenworth T880 | semi | motive | — | Motive (today's placeholder serves it) |
| H2 | hired Volvo VNL 760 | semi | geotab | — | Geotab (trucks) |
| PU1 | Ford F-250 Super Duty | pickup | samsara (vehicle feed), tag `Pickup` | ford_pro | Samsara (served today: 30 s positions, fuel only) |
| PU2 | Ram 2500 Tradesman | pickup | samsara (vehicle feed), tag `Pickup` | stellantis | Samsara (served today: 30 s positions, engine hours and fuel) |

## B.8 Done when

Every builder: §2 "Quality" green in its worktree (lint, typecheck, test, test:db, build, its own
e2e, and `e2e/m0-demo.spec.ts`, `e2e/fleet-panel.spec.ts` still passing), sim **and** replay
tested (CNH: sim), the report written (files, how to run the demo, registry updates, what the
integrator must add, open questions).

### B.8.1 trucks

- Sim (`pnpm dev`): H1 (Motive) and H2 (Geotab) on the board and the fleet panel with their
  badges ("Motive · sim", "Geotab · sim"), engine hours and odometer from the true/adjusted
  readings; a knob in each stand-in raises a fault (Motive `/v1/fault_codes` open → closed; Geotab
  `FaultData`) that maps to the right `NormalizedFault` (system, severity by `faultSeverity`,
  state, times). Replay (`CONNECTOR_MOTIVE=replay`, `CONNECTOR_GEOTAB=replay`): the doc-derived
  fixtures move H1 and H2.
- Motive: v3 only for Vehicle Gateway vehicles (a stand-in vehicle without one is read from
  v1/v2), the host from `MOTIVE_API_BASE`, no webhook names in code. Geotab: one Authenticate per
  session (reused across runs; a second Authenticate within a minute is never needed), GetFeed
  resumes from the stored `toVersion` after a restart, both limits honoured in a test (the
  stand-in answers `OverLimitException` past them), the demo database documented for sandbox.
- Tests: mappers (units, readings, every fault system the vendor sends), contract tests per call
  (sim and replay), fixtures tests, DB tests for positions and stats through the frozen writers,
  `e2e/trucks*.spec.ts` (both hired semis on the board).

### B.8.2 machines

- Sim: C3, T1 and L1 on the board from AEMP as **last-known** positions (not stale for 3 h, no
  trail, no geofence visits), with engine hours, fuel and DEF where the provider sends them
  ("Kubota (AEMP) · sim"); SP2 from Samsara's equipment feeds (live, `via` gateway, engine hours
  from gateway J1939 seconds or synthetic); the same RoGator from AEMP provider `samsara` never
  moves machine_state back. XML and JSON pages parse to the same items (a test per format).
- CNH: the OAuth round trip against its stand-in (tokens stored, refresh), every call carries the
  subscription key, a machine without the EULA answers 403 and is skipped (logged once, shown with
  its reason in the report's admin note), a staging app calling production fails with a clear
  message; no fixtures.
- Tests: the AEMP schema against fixtures from the Samsara SDK types, Deere's `aemp.yaml` example
  and Trackunit's OpenAPI; contract tests (sim and replay; CNH sim only); DB tests for last-known
  vs live precedence; `e2e/machines*.spec.ts`.

### B.8.3 terminal-pickups

- Sim: PU1 and PU2 on the board with pickup styling, their 30 s cadence never stale under the demo
  thresholds, PU1's engine hours and odometer "not reported" and PU2's odometer "not reported" on
  the fleet panel; `fleet.vehicles` sets the pickups' kind from the `Pickup` tag and `via` where
  Samsara says it; `/admin/vehicles` sets a kind (a service truck) that later tags never change; a
  viewer or driver gets 403 there.
- Terminal: its stand-in (a hired truck of its own, `terminal_<provider>` badge), `/providers` in
  the capability matrix, latest locations as `last_known`, history as `live`, fault events as
  `delta`; replay fixtures; sandbox documented (needs Terminal's grant).
- Tests: tag rules, the writer (admin wins), the formatter, contract tests (sim and replay), map
  style (every kind has a colour, label and icon), `e2e/pickups*.spec.ts`.

### B.8.4 The slice (integrator, after merging all seven branches)

- All merged, stubs gone, every check and the full e2e suite green; the combined DB test: a Motive
  `delta` fault, a Geotab FaultData and an AEMP fault series reach `machine_faults` and the panel
  badge through fleet-faults' writer.
- `/admin/connectors` shows all seven connections, their capability matrix and modes; a
  `.env.local` with `CONNECTOR_ELD=replay` shows the alias warning and replays Samsara.
- The integrator's own changes: §B.1's list; `docs/decisions.md` rows current; README (the
  vendor keys, the pickups route, AEMP providers).

## B.9 Out of scope

ISOXML import for customer jobs (operations data: M2 2b), Verizon Connect / Omnitracs /
PeopleNet direct clients (only if a hauler needs one, or through Terminal), the CLAAS API
(partnership needed), Leaf, Smartcar (a fallback only if Derrick won't pay a telematics license per
pickup), webhooks needing a public endpoint (MD), creating machines from a vendor's vehicle list.

## B.10 Decisions (defaults; rows in `docs/decisions.md`)

| # | Default | Where it lives |
|---|---|---|
| D3 (replaced) Telematics vendors | **Trucks: Samsara, Motive and Geotab** direct, **Terminal** for the long tail of hired trucks (once its quote fits). **Machines: John Deere and CNH** direct, **one generic ISO 15143-3 (AEMP) client** for every other brand with a feed (Kubota, and Deere/CNH hours), **Samsara asset gateways** for brands with no API (AGCO/RoGator, CLAAS without a partnership, old iron). **Pickups** through the telematics vendor's carmaker-cloud link (Samsara: Ford Pro, Stellantis Mobilisights; Motive and Geotab have the same), no connector of their own; Smartcar only as a fallback | `src/connectors/vendors.ts`, `src/config.ts` (the mode keys) |
| 1f-9 Every vendor on its own key | one mode key per connection, all running at once; unset = sim locally, off in production; `CONNECTOR_ELD`/`ELD_VENDOR` kept as a deprecated alias with a warning | `src/config.ts` (`resolveConnectorModes`) |
| 1f-10 Vehicle kind | from a vendor tag (`VEHICLE_KIND_TAGS`, default Semi / Pickup / Service truck) or set on `/admin/vehicles`; a hand-set kind always wins; "not reported" for a stat the route doesn't report | `src/domain/vehicles.ts`, `src/db/queries/vehicles.ts`, `src/connectors/vendors.ts` |
| 1f-11 Last-known positions | AEMP and Terminal latest-location snapshots are "last known": no trail, no geofence visits, stale after 3 h (`FLEET_STALE_SECONDS_LAST_KNOWN`) | `src/db/queries/fleet.ts`, `src/domain/fleet.ts` |
| 1f-2 (extended) Fault severity per system | §10 decision 2 | `src/domain/fault-codes.ts` |

Foundation choices beyond the brief (also defaults): the vendor keys default to `off` in
production instead of failing (production names only the vendors it uses); `loader` joined the
machine kinds (the brief's Kubota loader); AEMP providers are one JSON key; the position vendor of
an aggregator route is `<route>_<provider>`; `faultReport` (snapshot vs delta) distinguishes
Samsara's full active set from the other vendors' per-fault reports; the stand-in's carmaker-cloud
cadence is 30 s (under the demo's 60 s stale threshold); the hired haulers are parked at the shop in
every scenario; Motive's replay is wired with an empty fixture list (a replay poll answers "no
fixture"), CNH has no replay mode; the Samsara replay fixtures keep the four semis until the
integrator adds the pickups.

## B.11 For Derrick (sign-ups; `vendors-synthesis.md` §5)

The inventory of every machine's and truck's brand, model year and modem (and the ELDs regular
haulers run) decides the rest. Then: the CNH developer portal account (a company-domain email),
the Deere AEMP app profile request, the Samsara equipment and "Read AEMP" token scopes, the Geotab
demo database, the Terminal quote and sandbox access, a hauler's Motive key when needed, the
Kubota dealer's AEMP credentials (only with KubotaNOW machines), the Ford Pro consent and the Ram
VIN list for the pickups.
