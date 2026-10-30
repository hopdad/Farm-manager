# Contracts for slice 1f "Live connectors + sync health" (parallel builders)

Oct 30, 2026 · written by the 1f foundation stage · companion to `docs/build-plan.md` (§4 rows
`farm.operations`, `farm.pins`, `farm.machine_hours` / `farm.machine_faults`; §5 Deere and trucks
rows, ports, sync step, replay, stand-in; §6 1f; §8 D3, D6, D9, D19), `docs/contracts.md` (M0)
and `docs/contracts-m1.md` (M1). Both are **still binding** except where this page says
otherwise.

Four builders now work in parallel, each in its own git worktree off `claude/m1-1f`. This page
is the only agreement between them: who owns which paths, the ports and databases, the rules for
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

**Out of scope (don't build):** MD and production (Supabase adapters, the production redirect,
production webhooks, write-back on), M2 (Work Plans, outbox, `job_operations`, pin drawing and
photos, customer-org field matching), 1g (`tracks_daily`, raw retention), Motive stats and faults
(explicitly unsupported until D3), anything in `tools/gis/**` or the `gis` schema (slice 1e is
being built on the PC).

---

## 1. Who owns what

| Key | Builds (brief, plan §6 1f) | Owns (may create and edit) | Next / stand-in | Dev database |
|---|---|---|---|---|
| **deere-data** | `deere.fields` job (hourly; 45 s demo cadence in sim/replay), per connected org (§5.4): farms (doc-derived), fields, boundaries (D6 writer with deterministic ids, decision 7), flags → `farm.pins` (read-only, `source = 'deere_flag'`), equipment → `farm.machines` rows for unmapped Deere machines, engine hours → `machines.engine_hours` + `farm.machine_hours`. Stand-in routes for farms, fields, boundaries, flags, equipment and hours (consistent with the demo seed, so sim mode matches the seeded fields through external refs, never duplicates them); sim world flags. Replay fixtures for what's missing. `GET /api/pins` (viewer), a read-only "Deere flags" map layer in the rail, the pin popup on the board and the phone, publishing `pins`/`updated` | `src/jobs/deere-fields*.ts`, `src/connectors/deere/fields/**`, `src/db/queries/{deere-fields,pins,machine-hours}*.ts`, `src/sim/vendors/deere/fields-*.ts`, `src/sim/farm/flags*.ts` (new pure module, §7.4), `src/app/api/pins/**`, `src/ui/pins/**`, `src/ui/map/layers/pins*.ts`, `e2e/deere-fields*.spec.ts`; **plus (assigned, §1.2)** the 1a Deere fixture builder `src/connectors/deere/fixtures/{build,write,fixtures.test}.ts` with the 1a `fixtures/doc-derived/*/01-*.json`, and new fixture files numbered `20`-`29` (§8) | 3111 / 4021 | `farm_dev_deere_data` |
| **deere-ops** | `farm.operations` writer, `deere.ops` job (15 min; 20 s demo cadence): this crop season's operations per field with measurements, products and coverage (simplified MultiPolygon). Stand-in operations from the demo world's day reports (a finished field emits an operation). Historical replay fixtures for seeding and harvest 2022-2026 on the demo fields, with the replay **no-shift** option (§8). `deere:backfill --seasons=2022-2026` (decision 1; mapping shared from `src/connectors/deere/ops/`; crop normalization moved to `src/domain/crops.ts` so jobs and the CLI share it). Field panel: this season's operations in the History tab, backfilled seasons shown with their source | `src/jobs/deere-ops*.ts`, `src/connectors/deere/ops/**`, `src/db/queries/{operations,deere-seasons}*.ts`, `src/domain/crops*.ts`, `scripts/deere-backfill*.ts`, `src/sim/vendors/deere/ops-*.ts`, `src/app/api/fields/[id]/operations/**`, `src/ui/fields/tabs/history*.tsx`, `src/ui/fields/operations*.ts(x)`, `e2e/deere-ops*.spec.ts`, new fixture files numbered `30`-`39` (§8); **plus (assigned, §1.2)** in `src/connectors/replay.ts` the `noShift` option only, and in `tools/import/seasons-csv.ts` replacing `normalizeCrop` with a re-export from `src/domain/crops.ts` only | 3112 / 4022 | `farm_dev_deere_ops` |
| **fleet-faults** | Samsara fault codes end to end: schemas, client, its own `faults` stream, mapper with decision 2, `farm.machine_faults` history plus the current summary on `machine_state` with a time guard, the stand-in `faultCodes` feed type, a breakdown-scenario semi fault and a control knob, a doc-derived replay fixture; `fleet`/`invalidate` reason `faults`. Fleet panel: fault badge, the critical-fault mark-down prompt, a per-machine vendor + mode badge ("Samsara · sim", "Deere · replay"), and Deere-only machines that stopped working show "Last working position, N min ago" instead of a stale alarm. The `stats_at` time guard for fuel (contracts.md open item) | `src/connectors/samsara/**` (except `replay-recorded.ts`), `src/sim/vendors/samsara/**`, `src/jobs/fleet.ts`, `src/jobs/fleet-shared.ts`, `src/db/queries/fleet*.ts`, `src/db/queries/machine-faults*.ts`, `src/ui/fleet/**` except `contract.ts`, `src/app/api/machines/**`, `src/connectors/fleet-jobs.db.test.ts`, `e2e/fleet-panel*.spec.ts`, `e2e/fleet-faults*.spec.ts`; **plus (assigned, §1.2)** the `samsara` line of `WEBHOOK_NUDGES` in `src/connectors/webhooks.ts` (add `'faults'`) | 3113 / 4023 | `farm_dev_fleet_faults` |
| **sync-health** | Call counting in `vendorFetch` (calls, errors, rate-limited, per source and stream) into `ingest.api_calls_daily`; decision 4 pacing through `SyncStepSpec.minIntervalSeconds`; `/admin/connectors`: calls today/yesterday and the budget per source, the "Runs" column label fix (it counts job runs), dead-letter requeue and discard (manager) with the total count, the `DOC_DERIVED` list, Deere OAuth status (connected, expiry, scopes, a Connect link outside sim) and org approval status (decision 5, with a stand-in knob that makes an org need approval); per-org isolation of the Deere locations poll; decision 6 (`DEERE_REDIRECT_URI` + the forwarder template); `connectors:record` (decision 3) with the scrubber and a conformance test (recorded vs stand-in shapes, runnable against sim in CI); the `test:live` suites (by hand only) | `src/connectors/{http,sync-step,endpoints,doc-derived}.ts`, `src/connectors/oauth/**`, `src/connectors/deere/{client,oauth}.ts` (keeping the §5.0 seam signatures), `src/connectors/deere/connections*.ts`, `src/connectors/{deere,samsara}/replay-recorded.ts`, `src/connectors/*/fixtures/recorded/**`, `src/connectors/**/*.live.test.ts`, `src/connectors/{call-budget,conformance}*.ts`, `src/jobs/fleet-deere.ts`, `src/db/queries/{api-calls,connector-orgs}*.ts`, `src/sim/vendors/deere/connections-*.ts`, `src/app/admin/connectors/**`, `src/app/api/oauth/**`, `scripts/connectors-record*.ts`, `tools/record/**`, `docs/deere-callback.html`, `e2e/sync-health*.spec.ts` | 3114 / 4024 | `farm_dev_sync_health` |

Existing test files follow the code they test. A test of a file you don't own that your change
breaks means you changed a contract: don't edit that test, report it.

### 1.1 Integrator-owned (shared) files

Builders don't edit these; they list what to add in their report. The exceptions are the
**one-line registries and minimal mounts** of §1.2.

Everything not listed in §1 stays untouched, notably: `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `vitest.config.ts`, `db/migrations/**`, `src/db/schema/**`, `src/db/geo.ts`,
`src/config.ts`, `src/jobs/registry.ts` (and its test: the foundation registered both 1f jobs),
`src/ui/board/**`, `src/app/board/**`, `src/app/m/**`, `src/ui/map/*.ts(x)`, `src/sim/**` (except
the files §1 gives out), `tools/seed/**`, `tools/vendor-sim/**`, `src/db/queries/{boundaries,seasons,fields}*.ts`,
`tools/import/**` (except the one line §1 gives deere-ops), the M0/M1 e2e specs and `e2e/support/**`,
`README.md`, `docs/**` (except `docs/deere-callback.html`), `.github/**`, and **every contract file**:

`src/connectors/types.ts`, `src/connectors/replay.ts` (deere-ops: `noShift` only),
`src/connectors/deere/{schemas,mapper,replay,orgs}.ts`,
`src/domain/{operations,pins,fault-codes,fields,farm,fleet,ids}.ts`,
`src/platform/realtime/types.ts`, `src/ui/fleet/contract.ts`, `src/ui/map/layers/{types,builtin}.ts`,
`src/sim/types.ts`, `src/sim/vendors/{context,server,http,state,stub-world}.ts`,
`src/sim/vendors/deere/{routes,platform,modules}.ts`, the empty modules' shapes in
`src/sim/vendors/deere/*-routes.ts` (each builder fills its own), this file.

New Deere schemas go in the builder's own directory (`src/connectors/deere/fields/schemas.ts`,
`src/connectors/deere/ops/schemas.ts`), built with `deereCollectionSchema` from the shared
`schemas.ts`. The 1a mapper helpers (`deereBoundaryToMultiPolygon`, `areaAcres`, `deereLinkId`,
`deereFlagGeometry`) are read-only; new mappers live with their builder.

### 1.2 One-line registries, minimal mounts, assigned lines

- `src/ui/map/layers/registry.ts`: deere-data adds exactly its import line and its `pins` entry.
- `src/ui/board/BoardScreen.tsx`: deere-data may add one import and one element for the pin
  popup; fleet-faults one for an optional fault tag on the phone's machine card (contracts-m1
  §12 rule: no layout or style changes; say so in the report).
- deere-ops: the `noShift` option in `src/connectors/replay.ts` (§8) and the `normalizeCrop`
  re-export in `tools/import/seasons-csv.ts`.
- fleet-faults: `'faults'` in `WEBHOOK_NUDGES.samsara` (`src/connectors/webhooks.ts`).
- deere-data owns the 1a Deere fixture builder; deere-ops may **import** helpers from it
  (`OPERATIONS_ANCHOR`, `fixtureFarm`) but never edits it.

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
  `pnpm db:configure local`, `pnpm db:pending`, `pnpm db:reset` (seeds the demo farm).
  `pnpm test:e2e` then builds and starts `pnpm pilot` on your port. DB tests need none of this:
  every test file gets its own clone of `farm_test_template` (already rebuilt for 0007).
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
  `developer.deere.com`, `sandboxapi.deere.com`, `api.samsara.com` answer 403 at the proxy; the
  npm registry works, and `@samsarahq/samsara` 14.11's types are a usable Samsara reference).
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
| `farm.operations` | `kind` text (`OPERATION_KINDS`: seeding, application, harvest, tillage), `field_id` → fields (set null; null = unmapped field, a dq row), `crop_year` int, `crop` text null (normalized, `src/domain/crops.ts`), `started_at`, `ended_at` null, `area_reported_ac` / `area_clipped_ac` numeric(12,4) null, `products` jsonb `OperationProduct[]` default `[]`, `measurements` jsonb `OperationMeasurements` default `{}`, `machine_ids` uuid[] default `{}`, `operator_party_id` → parties (set null), `weather` jsonb `OperationWeather` null (2b), `status` (provisional, final; default provisional), `geom` MultiPolygon null (coverage, simplified), `source`, `source_id`, `source_org` (Deere org id), `source_modified_at` (Deere `modifiedTime`) | unique (`source`, `source_id`); btree (`field_id`, `crop_year`, `started_at` desc); GiST `geom`; CHECKs kind, status, crop_year 1950-2100, `ended_at >= started_at`, areas ≥ 0 | deere-ops |
| `farm.pins` | `kind` (`PIN_KINDS`: wet_hole, rock, tile_blowout, washout, hazard, note; default note), `field_id` → fields (set null), `geom` Geometry (CHECK: Point, LineString or Polygon), `note`, `category` (the vendor's category or label), `photo_keys` text[] (2c), `created_by` → app_users (set null), `resolved_at` (a Deere flag archived = resolved), `client_id` uuid null (offline dedupe, 2c), `read_only` bool default false, `source` default `'app'` (`deere_flag` for flags), `source_id`, `source_org`, `source_modified_at` | unique (`source`, `source_id`); unique `client_id` where not null; btree `field_id`; GiST `geom` | deere-data |
| `farm.machine_hours` | `machine_id` → machines (cascade), `ts` (vendor time), `engine_hours` / `odometer_mi` numeric(10,1) null (at least one), `source` | PK (`machine_id`, `source`, `ts`); btree (`machine_id`, `ts` desc); CHECKs one value, values ≥ 0 | deere-data |
| `farm.machine_faults` | `machine_id` → machines (cascade), `source`, `code`, `severity` (`FAULT_SEVERITIES`: info, warning, critical), `description`, `first_seen_at`, `last_seen_at`, `cleared_at` null | unique (`machine_id`, `source`, `code`) **where `cleared_at` is null** (one open row; a code seen again after clearing opens a new row); btree (`machine_id`, `first_seen_at` desc); CHECKs severity, `last_seen_at >= first_seen_at`, `cleared_at >= first_seen_at` | fleet-faults |
| `farm.machine_state` + | `fault_codes` jsonb `ActiveFaultCode[]` default `[]` (worst first), `faults_at` (vendor time of the fault event it reflects: **an older event never overwrites a newer one**), `stats_at` (vendor time of the stat `fuel_pct` came from: the same guard for fuel), `position_vendor` text null (connector source of the latest fix: samsara, motive, deere) | — | fleet-faults |
| `farm.fields` (tenure) | CHECK `fields_tenure_check` now allows **`unknown`** (`TENURES`): a field the Deere sync created, until someone sets it (decision 7; the map draws it grey, legends unchanged) | — | (deere-data writes it) |
| `ingest.api_calls_daily` | `source`, `stream` (default `''`: calls outside a sync step), `day` date (**UTC**), `calls` (every HTTP attempt, retries included), `errors` (non-2xx other than 429, and attempts with no answer), `rate_limited` (429s), `updated_at` | PK (`source`, `stream`, `day`); CHECK counts ≥ 0. Upsert `on conflict (source, stream, day) do update set calls = api_calls_daily.calls + excluded.calls, …` | sync-health |
| `ingest.connector_orgs` | `source`, `org_external_id`, `name`, `status` (connected, needs_approval), `approval_url`, `detail` (short reason, no secrets), `first_seen_at`, `last_seen_at`, `updated_at` | PK (`source`, `org_external_id`); CHECK status | sync-health |

**Ids of synced rows** (all `source = 'deere'` unless said; `source_id` = the vendor's raw id):
operations `deterministicId('deere', <operation id>)`; pins `deterministicId('deere_flag', <flag
id>)` with `source = 'deere_flag'`; Deere boundaries `deterministicId('deere', <boundary id>)`
with `source_ref` = the Deere boundary name; fields the sync creates `deterministicId('deere',
<field id of the org that owns it>)`; farms (`deere_farm_id` set too), parties (Deere clients) and
machines the same way. **No new `ingest.external_refs` kinds**: fields, farms, boundaries,
machines and parties use the existing ones (contracts §4 tuples); operations and pins carry their
own `source_id`. `ingest.sync_state.extra` may hold per-stream numbers (e.g. sync-health's
measured calls per run); `/admin/connectors` already shows numeric keys as counters.

### 3.2 Not exported

`data:export` doesn't list the 1f tables: they are synced (or derived) and come back by
re-syncing; their ids are deterministic, so hand-entered rows that point at them survive
`data:export → db:reset → re-sync → data:import`. Fields with tenure `unknown` export like any
field. The integrator re-runs the round-trip test after merging.

---

## 4. Configuration (`src/config.ts`, documented in `docs/contracts.md` §3)

| Key | Default | Meaning |
|---|---|---|
| `DEERE_REDIRECT_URI` | unset (http(s) URL; **https in production**) | decision 6: the Deere OAuth callback when it isn't `${PUBLIC_URL}/api/oauth/deere` |
| `DEERE_DAILY_CALL_BUDGET` | unset (integer ≥ 1) | decision 4: Deere API calls a day; unset = "limit unknown", the jobs keep their cron |

`FleetConfig` (`src/jobs/fleet-shared.ts`) already picks `DEERE_DAILY_CALL_BUDGET`; sync-health
adds `DEERE_REDIRECT_URI` to `ConnectorConfig` (`src/connectors/endpoints.ts`, its file).
Nothing reads `process.env` outside `src/config.ts`.

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
NormalizedMachine { source, sourceOrg, externalId, name, kind: MachineKind | null, make, model, year, vin }
NormalizedVehicleStat.faultCodes?: { code, severity: FaultSeverity, description? }[]   // [] = cleared; absent = says nothing
SyncStepSpec.minIntervalSeconds?: number | null                                        // decision 4, §5.5
```

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
  deere-ops); `area_clipped_ac` = the geodesic area of coverage ∩ the field's current boundary.
- `status`: deere-ops picks the provisional → final rule and states it in its report (suggested
  default: final once ended and unchanged for 24 h).
- Seasons from operations (backfill, decision 1): crop from `cropName` (normalized), variety from
  the seeding products, `planted_on` = the seeding start and `harvested_on` = the harvest end as
  America/Detroit dates, `yield_bu_ac` from `HarvestYieldResult.averageYield` (`bu1ac-1`),
  `source = 'deere'`, `source_id` deterministic per (field, crop year). Publish `fields`/`updated`
  with part `seasons` per field written.

### 5.2 Pins (`src/domain/pins.ts`; deere-data)

`PIN_KINDS`, `PIN_SOURCES` (app, deere_flag), `PinGeometry` (Point | LineString | Polygon),
`PinView` / `PinsResponse` (+ zod), `PINS_URL`.

- `GET /api/pins[?fieldId=<uuid>][&resolved=1]` (viewer; `no-store`; `limitedJson`) →
  `PinsResponse`: open pins unless `resolved=1`.
- Deere flags: `read_only = true`, `kind` from the flag's category when it names one of
  `PIN_KINDS` (deere-data's mapping, tested), else `note`; an archived flag gets `resolved_at`;
  geometry as Deere sends it (`deereFlagGeometry`).
- Map layer: key `pins`, group `fields`, label "Deere flags", `render: 'maplibre'` with a GeoJSON
  source from `GET /api/pins`, `requiresRow: false`, `cachePolicy: 'private'`, `offline: true`,
  `defaultVisible: true`; it refetches on `pins`/`updated`. The popup shows category, note, the
  field and "From Operations Center (read-only)".
- Publish `pins`/`updated` (§6) in the writer's transaction, at most once per run.

### 5.3 Fleet panel and fault codes (`src/domain/fault-codes.ts`, `src/ui/fleet/contract.ts`; fleet-faults)

`FAULT_SEVERITIES` (info < warning < critical), `FaultCode`, `ActiveFaultCode` (+ `since`),
`severityRank`, `worstSeverity`, `sortFaultCodes` (worst first, then code).

- The panel contract gains two **optional** fields (1a code keeps compiling): `faults?:
  ActiveFaultCode[]` per machine (from `machine_state.fault_codes`) and `position.vendor?:
  'deere' | 'samsara' | 'motive' | null` (from `machine_state.position_vendor`). The badge text
  is `<Vendor> · <mode>` with the mode from `FleetPanelData.modes` (`deere` for Deere,
  `eld` for Samsara/Motive): "Samsara · sim", "Deere · replay". Faults never ride on the tick
  (`MachineView` and `fleet`/`tick` are unchanged).
- Severity (decision 2) is applied by the Samsara mapper; `faultCodes: []` (no codes, no lamps)
  clears the machine. In the per-event transaction: update `machine_faults` (open, refresh
  `last_seen_at`, clear), then `machine_state.fault_codes` / `faults_at` only when the event is
  newer than `faults_at`; when the active set or its worst severity changed, publish
  `fleet`/`invalidate` `{ event: 'machine', reason: 'faults' }`.
- A machine whose worst code is critical, not down, with `canMarkDown`: the row offers
  "Critical fault: mark down?"; it opens the existing `StatusSheet` with the reason pre-filled
  from the code (within `MAX_DOWN_REASON_CHARS`). Never automatic. Viewers and the wall see the
  badge only.
- A Deere-only machine (latest fix `positionSource = 'deere_working'`) that stopped working (no
  new breadcrumb for a while: Deere records positions only while working) shows "Last working
  position, N min ago" instead of a stale alarm; fleet-faults picks and tests the threshold. A
  failing Deere stream still shows as failing (the panel's mode notice, `/admin/connectors`).
- Motive: faults stay unsupported (D3); its rows show no fault badge.

### 5.4 Deere orgs (`src/connectors/deere/orgs.ts`; decision 5)

`DEERE_CONNECTIONS_REL` (`'connections'`, doc-derived), `deereOrgAccess(org)` (a `connections`
link → `needs_approval` with that link as `approvalUrl`, else `connected`), `isDeereOrgDenied(err)`
(Deere 403), `deniedOrgAccess(org, err)`.

- **Every Deere sync** (locations, fields, operations, the backfill) lists orgs, skips the
  `needs_approval` ones (and any org that answers 403 mid-run), logs each skip, and never fails
  the other orgs for it.
- **Only sync-health writes `ingest.connector_orgs`**, from the `fleet.deere` locations step
  (which lists every org every run; poll keeps the statuses, `afterRun` writes them). After the
  merge the integrator may route the other syncs' 403s to the same writer.
- `/admin/connectors` shows each org's status with its approval link and says that customer
  organizations are connected only after a data-rights agreement (plan 2a, D17); nothing blocks
  the home org.

### 5.5 Call counting and the budget (`src/connectors/http.ts`; decision 4; sync-health)

- `VendorHttpOptions.onCall?: VendorCallHook` (default `noopVendorCallHook`), called **once per
  attempt** with `VendorCall { vendor, method, path (no query), status | null, outcome: 'ok' |
  'rate_limited' | 'error', attempt, ms }`; a hook that throws is ignored. sync-health wires the
  counter (e.g. an ambient per-step counter set by `runSyncStep`, so no client or job changes)
  and flushes it into `ingest.api_calls_daily` (§3.1). Replay calls count too (they measure the
  per-run cost offline); the page may show them apart by mode.
- `SyncStepSpec.minIntervalSeconds`: after a claimed run, `runSyncStep` releases with
  `next_run_at` = the later of (run start + this) and the Retry-After time. It never makes a stream
  run faster than its cron. Undefined or null = no minimum.
- fleet.deere's pace: with `DEERE_DAILY_CALL_BUDGET` set, `minIntervalSeconds = ceil(callsPerRun ×
  86 400 / (0.8 × budget))`, `callsPerRun` measured over its recent runs; unset = null and the
  page says "limit unknown". Keep `FLEET_STALE_SECONDS_DEERE` above the resulting interval (say
  so on the page when it isn't). Webhook nudges (`next_run_at = now()`) only exist in sim today.

### 5.6 OAuth redirect (decision 6; sync-health)

`deereEndpoints(mode, cfg).redirectUri` = `DEERE_REDIRECT_URI ?? ${PUBLIC_URL}/api/oauth/deere`,
used by both the authorize URL and the code exchange. `docs/deere-callback.html` is a static
page (no scripts from other hosts) that forwards `code`, `state` (and `error`,
`error_description`) to `http://localhost:3000/api/oauth/deere`, so the state cookie (host-only,
localhost) still matches when the sign-in started on the PC. `/api/oauth` and `/api/webhooks`
still never answer 3xx.

---

## 6. Realtime (`src/platform/realtime/types.ts`)

| Topic / event | Payload | Published by | Subscribers do |
|---|---|---|---|
| `pins` / `updated` (**new topic**) | `PinsUpdatedPayload { fieldIds, hasUnfielded }` | deere-data, in the writer's transaction, at most once per run | the pins layer and open popups refetch `GET /api/pins` |
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
and `/machines/{id}/breadcrumbs`. Every other `GET /deere/platform/...` call goes to the modules
in `DEERE_ROUTE_MODULES` order, **before** the core routes; the first non-null reply wins; else
404 "not simulated".

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
// helpers (./platform.ts): apiError, paging, collection, pagedReply, platformBase, simDeereOrgs
```

| Module (file) | Owner | Paths |
|---|---|---|
| `connections` (`connections-routes.ts`) | sync-health | refuses every org-scoped path (`/organizations/{org}/…`, core ones included) of an org its knob marks "needs approval" with Deere's 403 body; adds the `connections` link to that org; knob under `/_control/vendor/deere/connections/…` (types in a types-only `connections-control-types.ts` the admin page imports, NWS pattern) |
| `fields` (`fields-routes.ts`) | deere-data | `/organizations/{org}/farms`, `/clients`, `/fields`, `/fields/{f}`, `/boundaries`, `/fields/{f}/boundaries`, `/flags`, `/fields/{f}/flags`, and the equipment and engine-hours paths deere-data confirms from Deere's docs; org links `fields`, `farms`, `boundaries`, `flags` |
| `ops` (`ops-routes.ts`) | deere-ops | `/organizations/{org}/fields/{f}/fieldOperations` (honouring `cropSeason` and `fieldOperationType`), `/fieldOperations/{id}`, `/fieldOperations/{id}/measurementTypes`, `/fieldOperations/{id}/boundary`, and any org-wide operations listing deere-ops confirms |

Ids and shapes follow the demo seed (`simExternalRefs`): sim mode must map onto the seeded rows,
never create duplicates. Each module is created empty by the foundation (it serves nothing).

### 7.2 Day reports (`ctx.days`)

`VendorContext.days` / `VendorControlContext.days`: `SimDayReports { dayIndexAt(simTime),
dayWindow(index), dayReport(index): SimDayReport }` (src/sim/world.ts: per day, `work` ranges
with machine, op, field, acres, first/last time, passes and implement width; `loads`; `events`),
or null for a world without them (the stub world). Days run 05:00-05:00 local; index 0 is the
scenario's first day; a day is planned on first use (tens of ms) and cached. A field's work range
that ended before sim-now is a finished operation. Contract tests that need it start the stand-in
with `createWorld: createSimWorld` (src/sim/index.ts); the stub world keeps `days = null`.

### 7.3 Samsara (fleet-faults)

`faultCodes` is a stats feed type of its own call (Samsara allows at most 3 `types` per request
and `SAMSARA_STAT_TYPES` is full), served on `/fleet/vehicles/stats/feed?types=faultCodes`. A
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

- **Lists and order** (first match wins): `deereReplayFixtures` = recorded
  (`deere/replay-recorded.ts`, sync-health) → deere-ops (`deere/ops/replay.ts`) → deere-data
  (`deere/fields/replay.ts`) → the 1a doc-derived set (`deereDocDerived1aFixtures`).
  `samsaraReplayFixtures` = recorded (`samsara/replay-recorded.ts`) → doc-derived
  (`samsaraDocDerivedFixtures`, fleet-faults adds its `faults` fixture there).
- **Files:** `src/connectors/<source>/fixtures/doc-derived/<stream>/<nn>-<name>.json`; Deere
  numbers `20`-`29` are deere-data's, `30`-`39` deere-ops's (1a's are `01`); recorded fixtures
  under `…/fixtures/recorded/<stream>/` are sync-health's (scrubbed copies only). Each builder's
  own test checks its files (committed JSON = its builder's output, live schemas,
  `replayFixtureSchema`, "no real farm data" in `reference`).
- **No two exchanges answer the same request** (method, path, query) across a source's list
  (`deere/fixtures/fixtures.test.ts`); shadow a 1a exchange only with a more specific `query`.
- **Query parameters a fixture doesn't name are ignored**, so per-season exchanges carry
  `query: { cropSeason: 'YYYY' }` (and `fieldOperationType` where it matters); they come first by
  the order above.
- **No-shift (deere-ops adds it):** `ReplayFixture.noShift?: true` (+ `replayFixtureSchema`). With
  it every instant in the bodies is served as written (historical seasons 2022-2026 keep their
  dates), replays are byte-identical at any time, and `shiftStepSeconds` must be absent (the
  schema refuses both). Fixtures without it behave exactly as today.
- **OAuth is skipped** in replay (fixed token), as in 1a. A replay connection sees every fixture
  org as `connected` unless a fixture says otherwise.
- **CI:** the step "End-to-end in replay mode" (`CONNECTOR_DEERE=replay`, `CONNECTOR_ELD=replay`)
  gains the slice spec `e2e/m1f-replay.spec.ts` (integrator, §11.5).

---

## 9. Scripts, dependencies, jobs

| Script | Entry | Owner | Today |
|---|---|---|---|
| `deere:backfill --seasons=2022-2026 [--replace] [--dry-run]` | `scripts/deere-backfill.ts` | deere-ops | stub: prints "not built yet", exits 0 |
| `connectors:record <source> [--scrub]` | `scripts/connectors-record.ts` | sync-health | stub: prints "not built yet", exits 0 |
| `test:live` | `vitest run --project live --passWithNoTests` (`**/*.live.test.ts`, one file at a time, 120 s timeouts; never in CI) | sync-health (the suites) | no suites yet: passes |

**Jobs** (`src/jobs/registry.ts`, registered by the foundation; the builders replace the stubs):

| Job | Schedule | Demo (sim/replay/off) | Run | Owner |
|---|---|---|---|---|
| `deere.fields` | `17 * * * *` (plan §1) | 45 s | `runDeereFields` in `src/jobs/deere-fields.ts` (stub `{ items: 0, note: 'not built yet' }`) | deere-data |
| `deere.ops` | `*/15 * * * *` | 20 s | `runDeereOps` in `src/jobs/deere-ops.ts` (stub) | deere-ops |
| `fleet.deere` | `*/2 * * * *`, paced by decision 4 | 15 s | `runFleetDeere`, moved to `src/jobs/fleet-deere.ts` | sync-health |
| `fleet.trucks` | every 30 s | 5 s | `runFleetTrucks` in `src/jobs/fleet.ts` (+ the `faults` stream) | fleet-faults |

`src/jobs/fleet.ts` re-exports `createFleetDeereJob`, `DEERE_STREAM`, `runFleetDeere`,
`FleetConfig` and `FleetJobOptions`, so existing imports keep working; the shared pieces
(`machineResolver`, `positionsUpsert`, `tickAfterRun`, `publishSyncStatus`, `httpFor`) are in
`src/jobs/fleet-shared.ts`. Job code still imports nothing from `tools/**` or `scripts/**`
(heavy work, the backfill and recording, is CLI-only). **Dependencies:** none added.

---

## 10. Decisions (defaults in force; easy to change; rows in `docs/decisions.md`)

| # | Default | Where it lives |
|---|---|---|
| 1 Season precedence | `deere:backfill` writes a season when the field has none for that crop year, or the existing row's source is `demo` or `deere`; never replaces `import` or `app` rows unless `--replace`; each skipped conflict is listed in the run's report. `import:seasons` keeps `--replace-deere` | `scripts/deere-backfill.ts`, `src/db/queries/deere-seasons.ts` |
| 2 Fault severity (Samsara) | critical = J1939 red stop lamp (`stopIsOn`); warning = amber warning or protect lamp, emissions lamp, OBD MIL on, confirmed DTCs; info = pending DTCs. No codes and no lamps clears. A critical fault never marks a machine down: it offers "Critical fault: mark down?" to driver and above (the status sheet with the reason pre-filled) | Samsara mapper (fleet-faults), `src/domain/fault-codes.ts` |
| 3 Recorded fixtures | raw responses only under `data/raw/recorded/<source>/` (gitignored); `--scrub` writes an anonymized copy into `src/connectors/<source>/fixtures/recorded/<stream>/`: names to stable pseudonyms, ids hashed, coordinates moved into the demo area, tokens and auth headers dropped, each file validated by the live schemas, plus a check that no original id or name survives | `scripts/connectors-record.ts`, `tools/record/**` |
| 4 Deere call budget | `DEERE_DAILY_CALL_BUDGET` optional; unset: cron cadence, "limit unknown"; set: fleet.deere keeps measured calls-per-run × runs-per-day under 80 % of it, never faster than its cron | `src/config.ts`, `src/jobs/fleet-deere.ts`, `SyncStepSpec.minIntervalSeconds` |
| 5 Deere Connections | an org whose listing carries a `connections` link (doc-derived, confirm) or answers 403 is "needs approval": skipped (never fails the others), shown on `/admin/connectors` with the approval link. Customer orgs only after a data-rights agreement (2a, D17); nothing blocks the home org | `src/connectors/deere/orgs.ts`, `ingest.connector_orgs` |
| 6 Public callback | optional `DEERE_REDIRECT_URI` overrides `${PUBLIC_URL}/api/oauth/deere`; `docs/deere-callback.html` forwards `code` and `state` to `http://localhost:3000/api/oauth/deere` | `src/config.ts`, `src/connectors/endpoints.ts`, `docs/deere-callback.html` |
| 7 D6 boundaries | a Deere boundary becomes the field's current boundary (a new version, `source = 'deere'`); an imported or drawn one on that field becomes history, with lineage (its closed version). New Deere fields land in a farm per Deere farm when the farms call works, else in the default import farm ("Home farm"); tenure `unknown` until set by hand | `src/connectors/deere/fields/`, `src/db/queries/deere-fields.ts`, `TENURES` |

Foundation choices beyond the brief (also defaults): tenure `unknown` joined `TENURES` and the
CHECK (the allowed values had none; the legends list only the four real tenures);
`api_calls_daily.day` is the UTC day and every HTTP attempt counts as a call (retries included,
since vendors count them); `fleet.deere` moved to its own file so sync-health and fleet-faults
never edit the same job file.

---

## 11. Done when

Every builder: §2 "Quality" green in its worktree, sim **and** replay paths tested, the report
written. Then, per builder:

### 11.1 deere-data

- `pnpm dev` (sim) and `CONNECTOR_DEERE=replay`: after `deere.fields` runs, the 40 demo fields
  keep their ids (matched through external refs: no duplicate field, farm or machine), each has
  its Deere boundary as the current version (`source = 'deere'`; an imported or drawn one is now
  history), a Deere field the app didn't know lands in its Deere farm with tenure `unknown`;
  flags show as read-only pins (the "Deere flags" toggle in the rail, a popup on `/board` and
  `/m`); every Deere machine exists (no "unmapped" log line) and shows engine hours
  (`machines.engine_hours` + `farm.machine_hours`).
- A needs-approval org (sync-health's knob, or a 403 in your contract test) is skipped and the
  others sync.
- Tests: contract tests per new call (sim and replay), mapper units, DB tests (a second run
  changes nothing; ids survive `db:reset` + re-sync; D6 versioning), `e2e/deere-fields*.spec.ts`.

### 11.2 deere-ops

- Sim: a field the simulation finishes shows its operation (kind, acres, products, coverage) in
  the History tab within about a minute at the demo cadence; replay: the 2026 fixture operations
  land.
- `pnpm deere:backfill --seasons=2022-2026` in replay writes the 2022-2026 seasons of the demo
  fields under decision 1 (its report lists skipped `import`/`app` rows; `--replace` replaces
  them; a second run changes nothing); the History tab shows each season's source.
- `noShift` in `replay.ts` with its unit test; `normalizeCrop` shared from `src/domain/crops.ts`
  (`import:seasons` tests unchanged and green).
- Tests: contract (sim with `createSimWorld`, replay), mapper and crop units, DB tests
  (idempotent upserts, clipping, decision 1 cases), `e2e/deere-ops*.spec.ts`.

### 11.3 fleet-faults

- Sim, `breakdown` scenario: the semi's critical code shows a badge on the fleet panel within one
  `fleet.trucks` run; a driver sees "Critical fault: mark down?" which opens the sheet with the
  reason filled in; a viewer sees the badge only; clearing it with the knob clears the badge; an
  older page never brings it back. Replay: the doc-derived `faults` fixture lands.
- Every machine row shows its vendor + mode badge; a Deere-only machine that stopped working
  shows "Last working position, N min ago"; fuel never moves back to an older reading.
- Tests: mapper (every decision 2 case, cleared), contract (sim: type parameter, cursor; replay;
  fixture drift), DB (stored, cleared, out of order, invalidate published), `model.test.ts`,
  `e2e/fleet-panel*.spec.ts` green in sim and in replay.

### 11.4 sync-health

- `/admin/connectors` (manager): calls today and yesterday per source with the budget ("limit
  unknown" when unset), the "Runs" label, dead letters with the total count plus requeue and
  discard (a viewer or driver gets 403), the doc-derived list, the Deere OAuth status (connected,
  expiry, scopes; a Connect link outside sim) and each org's approval status; the knob makes an
  org need approval and the other orgs' locations keep flowing.
- App call counts match the stand-in's `/_control/stats` for a run; with a budget set,
  `fleet.deere`'s `next_run_at` follows decision 4 (formula unit test + DB test).
- `DEERE_REDIRECT_URI` is used by the authorize URL and the exchange; the forwarder template
  exists and is linked from README's Deere section (integrator adds the link).
- `pnpm connectors:record deere --scrub` against the stand-in (sim) writes raw files under
  `data/raw/recorded/` and scrubbed fixtures that pass the live schemas, with the "no original id
  or name survives" check; the conformance test (recorded vs stand-in shapes) runs in CI against
  sim; `pnpm test:live` suites exist and skip with a clear message without credentials.
- Tests and `e2e/sync-health*.spec.ts`.

### 11.5 The slice (integrator, after merging)

- All four branches merged into `claude/m1-1f`, the stubs gone, `pnpm lint`, `typecheck`, `test`,
  `test:db`, `build` and the full e2e suite green, the M0 and M1 demo specs included.
- **Replay e2e** `e2e/m1f-replay.spec.ts` (integrator), run in CI's replay step with
  `CONNECTOR_DEERE=replay` and `CONNECTOR_ELD=replay` (it skips itself under the sim stack, like
  `fleet-panel-replay.spec.ts`): it runs `pnpm deere:backfill --seasons=2022-2026` against the
  app's database (process.execPath + tsx, `src/lib/proc.ts`), then on `/board`: Deere fields
  with no duplicates, flags as pins in the rail and a popup, Deere machines with engine hours, a
  field's History tab with this season's operations and the 2022-2026 seasons marked Deere, the
  Samsara fault badge on the fleet panel, and `/admin/connectors` with call counts, the
  doc-derived list and the org status. The same flow is checked by hand in sim (`pnpm dev`).
- `docs/build-plan.md` 1f boxes ticked with an as-built note, `docs/decisions.md` rows current,
  `docs/status.md` entry, README (Deere sandbox on the PC, `DEERE_REDIRECT_URI`, the call budget,
  `pnpm deere:backfill`, `pnpm connectors:record`, `pnpm test:live`).

---

## 12. For Derrick's PC (not buildable here)

- Slice 1e's `db/pending/pc-1e.sql` takes the next free migration number when it merges (0007
  went to 1f).
- With a Deere app: `CONNECTOR_DEERE=sandbox`, `DEERE_CLIENT_ID` / `DEERE_CLIENT_SECRET`, sign in
  at `/api/oauth/deere` (or through the `DEERE_REDIRECT_URI` page), approve each org in Deere
  Connections, then `pnpm connectors:record deere --scrub` and `pnpm test:live`. Never point the
  PC at Derrick's production Deere organization without his say-so (PC-AGENT.md).
