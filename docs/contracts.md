# Contracts for M0 stage 2 (parallel agents)

Oct 29, 2026 · written by the M0 stage 1 (foundation) build · companion to `docs/build-plan.md`

> **M1:** the parallel M1 build's agreements (owners, ports, migration 0003, new contracts) are in
> [`contracts-m1.md`](contracts-m1.md); everything here still holds unless that page says otherwise.
>
> **Status: integrated (M0 stage 3, Oct 29, 2026).** The four branches are merged into
> `claude/m0-foundation`; the ownership table and the "rules for shared files" in section 1 were
> for the parallel build and no longer apply. Everything else still describes the seams. The
> integration changed a few contracts; each change is marked **(stage 3)** where it lives, and
> section 12 lists them in one place.

Stage 1 built the tooling, config, database, test harness and the shared interfaces. Four agents now
build the rest of M0 in parallel. This page is the only agreement between them: the directories each one
owns, the ports, the rules for shared files, and every contract (TypeScript files in `src/` plus SQL).
If a contract doesn't fit, **don't change it in place**: work around it and say exactly what you need in
your stage report.

---

## 1. Who owns what

| Agent | Builds | Owns (may create and edit) | Next / stand-in ports |
|---|---|---|---|
| **map** | War-room map shell: `WarRoomMap` (react-map-gl + `MapLibreOverlay`, interleaved), local PMTiles basemap with local fonts/sprites (section 10), field fills from `/api/tiles/fields`, fleet `IconLayer` gliding between ticks, `/board` (touch pan/pinch/rotate) and `/m`, the local storage adapter (read side) and `/api/storage`, Playwright specs | `src/ui/**`, `src/app/board/**`, `src/app/m/**`, `src/app/api/tiles/**`, `src/platform/storage/**`, `src/app/api/storage/**`, `tools/gis/**`, `public/**` (small static files only; never tiles, fonts or sprites), `e2e/**` except `e2e/realtime*.spec.ts` (runtime) and `e2e/fleet*.spec.ts` (vendors) | 3101 / 4011 |
| **sim** | Deterministic world v0 (grid fields, fictional parties, fleet, elevators, section-line roads, combines in passes, carts, semis to elevators), scenarios, demo seed | `src/sim/**` except `src/sim/types.ts` and `src/sim/vendors/**`, `scripts/seed.ts`, `scripts/sim-scenario.ts`, `tools/seed/**`, `data/seed/**` | 3102 / 4012 |
| **vendors** | Vendor stand-in v0 (Samsara-shaped locations feed with bearer token + cursor paging; Deere-shaped OAuth flow + machine locations; fault injection and clock control APIs), the live clients in sim mode, `runSyncStep`, the `fleet.*` jobs and their batched `fleet.tick`, `GET /api/fleet` snapshot | `tools/vendor-sim/**`, `src/sim/vendors/**`, `src/connectors/**` except `src/connectors/types.ts`, `src/jobs/**` except `src/jobs/types.ts` and `src/jobs/schedule.ts`, `src/db/queries/fleet.ts`, `src/app/api/fleet/**`, `src/app/api/webhooks/**`, `src/app/api/oauth/**` | 3103 / 4013 |
| **runtime** | Realtime (SSE route + browser client), `/api/jobs/[name]` (secret, lease, 202, `after()`), the croner clock, `tools/dev.ts`, `pnpm pilot`, `scripts/bootstrap.ts` (full bootstrap built on `scripts/env.ts` and `scripts/db.ts`), `/admin/connectors` (mode, last OK, errors, clock pause, sim pause, fault toggles), and optionally `pnpm jobs:emit-cron` (section 5) | `src/platform/realtime/**` except `types.ts`, `publish.ts` and their tests, `src/app/api/realtime/**`, `src/app/api/jobs/**`, `tools/clock/**`, `tools/dev.ts`, `tools/pilot.ts`, `tools/https/**`, `scripts/bootstrap.ts`, `scripts/jobs-emit-cron.ts`, `db/supabase/**`, `src/app/admin/**` | 3104 / 4014 |

`/api/fleet` belongs to **vendors** (it shares the query that builds `fleet.tick`); **map** only calls it.
The basemap files, their layout under `.data/storage` and `basemap.json` belong to **map** (section 10);
**runtime**'s bootstrap only runs `tools/gis/basemap.ts` and checks the result.

**Foundation-owned (read-only for all four; request changes in your report):**
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.node-version`, `tsconfig.json`,
`biome.json`, `next.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `drizzle.config.ts`,
`docker-compose.yml`, `db/migrations/**`, `src/config.ts`, `src/db/**` (except `src/db/queries/fleet.ts`),
`src/domain/**`, `src/lib/**`, `src/test/**`, `scripts/env.ts`, `scripts/db.ts`, `scripts/lib/**`,
`src/app/layout.tsx`, `src/app/page.tsx`, `src/app/api/health/**`, and the contract files
`src/jobs/types.ts`, `src/jobs/schedule.ts`, `src/platform/realtime/types.ts`,
`src/platform/realtime/publish.ts`, `src/connectors/types.ts`, `src/sim/types.ts`, their tests
(`src/sim/types*.test.ts`, `src/connectors/types.test.ts`, `src/platform/realtime/types.test.ts`,
`src/platform/realtime/publish*.test.ts`), this file.
Shared helpers in `src/db/` that two agents must call the same way: `leases.ts` (job and stream
leases, section 5), `external-refs.ts` (vendor id ↔ entity, section 4) and `exec.ts` (one statement on a
pg pool/client or a Drizzle db/tx).

**Placeholders you replace (keep the exports):** `src/sim/index.ts` (sim: `buildSimFarm`, `createSimWorld`),
`src/platform/realtime/client.ts` (runtime: `getRealtimeClient()`), `src/jobs/registry.ts` (vendors: `jobs`, keep `registry`).
`src/app/board/page.tsx` is a placeholder the map agent replaces.

### Rules for shared files

- **Never edit `package.json`, the lockfile or `pnpm-workspace.yaml`.** Every M0 dependency is installed
  (Next 16.4.3, React 19.3, maplibre-gl 6.16.0, react-map-gl 8.1.3, @deck.gl/{core,layers,geo-layers,
  maplibre,extensions,mesh-layers} 9.4.1, @luma.gl/{core,engine} 9.4.2, @loaders.gl/core, pmtiles 4.5.0,
  @protomaps/basemaps 5.7.2, drizzle-orm 0.45.4, pg 8.23.1, zod 4.6.7, @tanstack/react-query 5,
  zustand 5, croner 10.0.1, @turf/turf 7.4.0, jose 6, uuid 14, @next/env, @vercel/functions, tsx,
  TypeScript 6.0.3, Biome 2.6.3, Vitest 5.0.5 + Vite 8, Playwright 1.64.1). If you need another
  package, list it (name, exact version, why) in your report.
- **Never edit `db/migrations/**`.** Put schema changes in `db/pending/<agent>.sql` (idempotent; see
  `db/pending/README.md`). Test databases get them automatically; `pnpm db:pending` applies them to
  your dev database.
- **Never run `pnpm db:nuke`, `pnpm db:down`, `pnpm db:up`, `pnpm env:init` or `docker compose`
  commands** against the **shared** container, and never `pnpm db:reset` the shared `postgres`
  database. Use your own dev database (section 2). The one exception: an environment with its own
  Docker and no shared container (section 2, "Which case are you in?").
- **`package.json` scripts already reserved** (they fail until the owner creates the file):
  `dev` → `tools/dev.ts` (runtime), `pilot` → `tools/pilot.ts` (runtime), `clock` → `tools/clock/index.ts`
  (runtime), `bootstrap` → `scripts/bootstrap.ts` (runtime), `jobs:emit-cron` →
  `scripts/jobs-emit-cron.ts` (runtime; optional in M0, required by MD, section 5), `vendor-sim` →
  `tools/vendor-sim/index.ts` (vendors), `db:seed` → `scripts/seed.ts` (sim; `pnpm db:reset` runs
  `scripts/seed.ts demo` once it exists), `sim:scenario` → `scripts/sim-scenario.ts` (sim),
  `gis:basemap` → `tools/gis/basemap.ts` (map).
  Until `tools/dev.ts` exists, `pnpm dev:next` runs `next dev -H 0.0.0.0`.
- Windows is the target: no bash syntax, inline `FOO=bar`, `rm -rf` or POSIX paths in anything a user
  runs; use `node:path`/`node:fs`; spawn Node tools as `process.execPath` + JS entry (see
  `src/lib/proc.ts`: `runNode`, `tsxBin`, `drizzleKitBin`), never `.cmd` shims; spawn `docker` directly.

---

## 2. Ports, database and environment

| What | Default | Parallel agents |
|---|---|---|
| Next (`next dev` / `next start`) | 3000 (`PUBLIC_URL=http://localhost:3000`) | map 3101, sim 3102, vendors 3103, runtime 3104 |
| Vendor stand-in (`VENDOR_SIM_URL`) | 4010 (`http://127.0.0.1:4010`) | map 4011, sim 4012, vendors 4013, runtime 4014 |
| Postgres (`DB_PORT`) | 15432 on 127.0.0.1, one shared container | shared; use your own database |
| `pnpm start` check by stage 1 | 3100 | |

**Which case are you in?** Check before anything else (from your checkout, with Node 24 on PATH):

1. **Shared machine.** `docker ps --filter name=farm-manager-db-1` lists a running container: it is
   the foundation's, migrated (`postgres` database), `farm_app` can log in, and `farm_test_template`
   exists. Get credentials by **copying `.env` and `.env.local` from the foundation checkout**
   (`/home/user/Farm-manager` on the build machine); don't run `pnpm env:init` (it would mint a new
   DB password that doesn't match the volume) and never touch the container. If `docker ps -a`
   shows it but stopped, `pnpm db:up` is allowed (it only starts it; the data stays).
2. **Your own Docker, no shared container** (e.g. a separate cloud container: `docker ps -a` shows
   no `farm-manager-db-1`, `docker info` works). The container you create is yours, so the shared
   rules don't apply to it: run `pnpm env:init`, then `pnpm db:nuke` once (pulls nothing if
   `supabase/postgres:17.11.0.008` is cached; it brings the database up, migrates and configures
   it), then `pnpm db:check` (all PASS), then follow the rest of this section. `pnpm test:db`
   builds `farm_test_template` itself.
3. **No Docker at all** (`docker info` fails): you can't run DB tests or the app against a
   database. Build and unit-test what you can, and say so in your report.

In every case work from a checkout of the foundation commit on `claude/m0-foundation` that
contains this paragraph; an older commit has older contracts.
- **Your own dev database:** point both URLs at `farm_dev_<agent>` and migrate; `db:migrate` creates a
  missing `farm_*` database on the local server. The overrides:
  ```
  DATABASE_URL=postgres://farm_app:<FARM_APP_PASSWORD>@127.0.0.1:15432/farm_dev_map
  DATABASE_URL_MIGRATE=postgres://postgres:<DB_PASSWORD>@127.0.0.1:15432/farm_dev_map
  PUBLIC_URL=http://localhost:3101
  VENDOR_SIM_URL=http://127.0.0.1:4011
  ```
  **Where to put them.** Shell variables always win over env files. Which env files load depends on
  `NODE_ENV` (`@next/env`, used by Next *and* by `src/config.ts` for scripts):
  - `next dev` and tsx scripts (`NODE_ENV` unset → development) read `.env.development.local`, then
    `.env.local`, `.env`;
  - `next build` / `next start` (`NODE_ENV=production`, even on the PC) read `.env.production.local`,
    then `.env.local`, `.env`, and **not** `.env.development.local`;
  - Vitest (`NODE_ENV=test`) reads `.env.test.local`, `.env`, plus `.env.local` (merged by config).

  So put the same lines in **both** `.env.development.local` and `.env.production.local` (both
  gitignored by `.env.*.local`), or export them in your shell. Otherwise `pnpm start --port 310x`
  silently uses the shared `postgres` database and stand-in port 4010. DB tests don't need them:
  every test file gets its own random database on the shared server.
  Then `pnpm db:migrate`, `pnpm db:configure local` (skips pg_cron/pg_net outside `postgres`),
  `pnpm db:pending`, and `pnpm db:reset` whenever you like (it only touches that database).
- Run Next on your port: `pnpm dev:next --port 3101`, or `pnpm build` then `pnpm start --port 3101`
  (with `.env.production.local` as above).

### Test databases

- `pnpm test` = unit project (`src/**/*.test.ts`, `scripts/**/*.test.ts`, `tools/**/*.test.ts`, no DB).
- `pnpm test:db` = db project (`**/*.db.test.ts` under `src/`, `db/`, `scripts/`, `tools/`). Its global
  setup rebuilds `farm_test_template` when the migrations hash changed and makes sure `farm_app` can log in.
- Each DB test file calls `const t = setupTestDb(import.meta.url)` (from `src/test/db.ts`) and gets its own
  database **`farm_test_<file-slug>_<6 hex>`**, cloned from `farm_test_template` with `db/pending/*.sql`
  applied, dropped after the file. `t().db` / `t().pool` are **farm_app**; `t().adminDb` / `t().admin`
  are **postgres**. Names never collide across agents.
- **The template lock is server-wide.** Every clone and rebuild of `farm_test_template` holds one
  advisory lock taken on the `postgres` maintenance database (`withTemplateLock` in `src/db/admin.ts`),
  whatever database your `DATABASE_URL_MIGRATE` names, so agents and concurrent runs never clone a
  template another one is rebuilding. The rebuild re-checks the migrations stamp inside the lock, so
  concurrent `pnpm test:db` runs rebuild at most once.
- Throwaway databases made by tools are `farm_lint_*` (db:lint) and `farm_check_*` (db:check).
  `pnpm db:test-template` makes the template current (`--force` rebuilds it anyway) and drops leftover
  `farm_test_*` databases that nobody is connected to and that were created over an hour ago.
- Fixtures: `src/test/fixtures.ts` (`ADRIAN_QUARTER_SECTION`, `squareMultiPolygon`, `tileFor`, `insertField`).

---

## 3. Configuration (`src/config.ts`)

`src/config.ts` is **the only reader of `process.env`** (Biome `style/noProcessEnv` + `src/seams.test.ts`,
which also scans the root `*.config.ts` files; there are no exceptions).
It loads `.env*` files with `@next/env`'s `loadEnvConfig` (CLI tools see what Next sees; existing
variables win; under `NODE_ENV=test` it also merges `.env.local`, which Next skips). Use:

- `getConfig()`: validated, memoized; throws `ConfigError` with a fix-it message.
- `tryGetConfig()`, `getMigrateUrl()`, `tryGetMigrateUrl()`, `getDevOrigins()` (never throws; next.config.ts).
- `getE2eSettings()` → `{ baseURL, ci, external }` for `playwright.config.ts` (pure core
  `parseE2eSettings(env)`; `external` = `E2E_BASE_URL` was given, so no webServer; stage 3).
  It needs none of the app's secrets, so it works in a fresh clone; it throws only for a malformed
  `E2E_BASE_URL`. Test-tooling keys, not part of `Config`:
  - `E2E_BASE_URL`: the app the suite targets; else `PUBLIC_URL` (so your `.env.development.local`
    port applies), else `http://localhost:3000`;
  - `CI`: true for any value but empty, `0` or `false` (`forbidOnly`, 2 retries, GitHub reporter).
- `publicConfig(cfg)`: `{ appEnv, realtime, basemapStyle, staleAfterSeconds, deereStaleAfterSeconds }`
  (the last one: stage 3). **Client components never
  read env**: a server component passes `publicConfig(getConfig())` down as props.
- `childEnv(overrides)`: environment for a child process (`undefined` removes a key).
- Keep imports in `src/config.ts`, `src/db/schema/**`, `drizzle.config.ts` relative (drizzle-kit loads them).

With **`APP_ENV=production`**, config refuses `sim`/`replay` connector modes, `SIM_FROZEN_AT`, a missing
`TOKEN_ENC_KEY`, a non-https `PUBLIC_URL` and `NEXT_PUBLIC_REALTIME=sse`.

| Key | Default | Meaning |
|---|---|---|
| `APP_ENV` | `development` | `development` \| `test` \| `production` (`next start` on the PC is still development) |
| `DATABASE_URL` | required | app connection as `farm_app` |
| `DATABASE_URL_MIGRATE` | optional | admin/migrations as `postgres` (scripts only) |
| `DB_PORT` | `15432` | container host port (compose reads `.env`) |
| `DB_PASSWORD` | optional | container `postgres` password (compose reads `.env`) |
| `FARM_APP_PASSWORD` | optional | `farm_app` password applied by `db:configure local` |
| `DB_POOL_MAX` | `10` | app pool size |
| `DB_JOBS_POOL_MAX` | `2` | jobs pool size |
| `PUBLIC_URL` | `http://localhost:3000` | base URL; cookie `Secure` follows its scheme (`cfg.cookieSecure`) |
| `DEV_ORIGINS` | `''` | comma list → `string[]` for Next `allowedDevOrigins` (LAN IPs + `<host>.local`) |
| `JOBS_SECRET` | required (≥ 32 chars) | bearer secret for `POST /api/jobs/<name>` |
| `SESSION_SECRET` | required (≥ 32 chars) | signs the local session cookie (jose) |
| `TOKEN_ENC_KEY` | optional (64 hex; required in production) | AES-256-GCM key for `ingest.oauth_tokens.ciphertext` |
| `AUTH_PROVIDER` | `local` | `local` \| `supabase` (MD) |
| `NEXT_PUBLIC_REALTIME` | `sse` | client realtime adapter: `sse` \| `supabase` |
| `BASEMAP_STYLE` | `protomaps-local` | `protomaps-local` \| `openfreemap` |
| `STORAGE_DIR` | `.data/storage` | local storage adapter root |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `CLOCK` | `croner` | `croner` (tools/clock) \| `pgcron` (rehearse Supabase Cron locally) |
| `CLOCK_HOSTS` | `app,pc` | which job `host` values this clock fires |
| `FLEET_STALE_SECONDS` | `600` | a machine whose latest fix (ELD, cab device, manual) is older is `stale`; `pnpm env:init` writes `60` for the demo |
| `FLEET_STALE_SECONDS_DEERE` | `600` | the same for Deere working-only fixes (`deere_working`): an idle cart has no new fix for minutes; `env:init` writes `900` (stage 3) |
| `JOBS_DEMO_CADENCE` | `off` | `on` \| `off` → boolean. tools/clock fires jobs that declare `demoEvery` at that interval (fleet.trucks 5 s, fleet.deere 15 s). Refused in production and when any connector is `sandbox`/`live`; `env:init` writes `on` (stage 3) |
| `VENDOR_SIM_URL` | `http://127.0.0.1:4010` | stand-in base; sim clients use `${VENDOR_SIM_URL}/<vendor>` |
| `CONNECTOR_DEERE` | `sim` | `sim` \| `replay` \| `sandbox` \| `live` \| `off` |
| `CONNECTOR_ELD` | `sim` | same modes; vendor chosen by `ELD_VENDOR` |
| `CONNECTOR_WEATHER` | `sim` | same modes (NWS) |
| `ELD_VENDOR` | `samsara` | `samsara` \| `motive` |
| `WRITEBACK_DEERE` | `off` | `on` \| `off` → boolean; Work Plan push gate |
| `DEERE_CLIENT_ID` | optional | real Deere app (sandbox/live); sim uses `SIM_CREDENTIALS.deere` |
| `DEERE_CLIENT_SECRET` | optional | " |
| `SAMSARA_API_TOKEN` | optional | real Samsara token; sim uses `SIM_CREDENTIALS.samsara` |
| `MOTIVE_API_KEY` | optional | real Motive key; sim uses `SIM_CREDENTIALS.motive` |
| `NWS_USER_AGENT` | `farm-manager (local development)` | NWS requires a User-Agent with contact info |
| `SIM_SCENARIO` | `harvest-day` | one of the six scenarios |
| `SIM_SEED` | `1` | world seed |
| `SIM_SPEED` | `1` | sim seconds per wall second (`30` ≈ a farm day in 30 min) |
| `SIM_FROZEN_AT` | unset | ISO instant: freeze sim time there (→ `Date \| null`) |

`pnpm env:init` (`scripts/env.ts`, exports `initEnvFiles`, `planEnvFiles`, `devOriginCandidates`,
`privateIPv4Candidates`, `randomHex`) writes `.env` (`DB_PASSWORD` 32 hex, `DB_PORT`) and `.env.local`
(`APP_ENV`, `PUBLIC_URL`, `FARM_APP_PASSWORD`, `DATABASE_URL`, `DATABASE_URL_MIGRATE`, `JOBS_SECRET`,
`SESSION_SECRET`, `TOKEN_ENC_KEY`, `VENDOR_SIM_URL`, `DEV_ORIGINS`). It never rewrites an existing key or
regenerates a secret; `--refresh-origins` recomputes `DEV_ORIGINS`; `--dry-run` writes nothing.

---

## 4. Database

Schemas `farm`, `gis`, `ingest`, `app` (+ `extensions` for PostGIS/btree_gist, + `drizzle` for the journal).
SQL source of truth: `db/migrations/0000_m0_extensions_roles.sql`, `0001_m0_tables.sql`,
`0002_m0_functions.sql`; mirrored by `src/db/schema/*.ts` (a DB test fails on any column drift).

- **Access:** `getDb()` / `getPool()` (app, farm_app), `getJobsDb()` / `getJobsPool()` (jobs, small),
  `createPool()`, `createDb()`, `createJobsPool()`, types `Db`, `DbTx`, `Queryable` (`src/db/client.ts`).
  Driver `pg` only; postgres.js and named prepared statements (`.prepare(...)`) are banned.
- **Geometry** (`src/db/geo.ts`): columns read and write **GeoJSON** (EPSG:4326). Writes wrap
  `extensions.ST_GeomFromGeoJSON`; reads parse hex EWKB; `asGeoJson(col, { maxDecimals, simplifyTolerance })`
  for select lists; `geomFromGeoJson()` / `multiGeomFromGeoJson()` for raw SQL. A Polygon written to a
  MultiPolygon column is promoted with `ST_Multi`.
- **Ranges** (`src/db/range.ts`): `tstzrange` columns are `{ from: Date | null; to: Date | null }`, half-open.
- **Ids** (`src/domain/ids.ts`): outside-source rows get `deterministicId(source, sourceId)` = uuidv5 of
  `source:sourceId`; demo/sim rows use `demoId(key)` = `deterministicId('demo', key)` with
  `source='demo'`, `source_id=key`. `source` + `source_id` are unique together on parties, farms, fields,
  field_boundaries, field_seasons, machines, geofences.
- **External refs** (vendor id → our entity id, `ingest.external_refs`): the seed writes them and every
  sync reads them, so both sides use the same vocabulary and helpers:
  - build keys with `externalRef(source, kind, externalId, sourceOrg = '')` from `src/connectors/types.ts`
    (it rejects unknown sources/kinds, empty ids, and Deere refs without an org);
    `EXTERNAL_REF_KINDS = ['party', 'farm', 'field', 'boundary', 'machine']`; `externalRefKey(...)` gives
    a `source|kind|sourceOrg|externalId` string for Maps;
  - read and write them with `upsertExternalRef(ex, ref, entityId)`, `resolveExternalRef(ex, ref)` and
    `resolveExternalRefs(ex, source, kind, sourceOrg, ids) → Map<externalId, entityId>` from
    `src/db/external-refs.ts` (`ex` = pg pool/client or Drizzle db/tx);
  - the tuples:

    | entity | source | kind | external_id | source_org |
    |---|---|---|---|---|
    | `farm.farms` | `deere` | `farm` | Deere farm id | Deere org id |
    | `farm.fields` | `deere` | `field` | Deere field id | Deere org id; **one row per org** that has the field (`sharedWith`) |
    | `farm.field_boundaries` | `deere` | `boundary` | Deere boundary id | Deere org id |
    | `farm.machines` (JDLink) | `deere` | `machine` | Deere machine id | Deere org id |
    | `farm.machines` (ELD vehicle) | `ELD_VENDOR` (`samsara` \| `motive`) | `machine` | vehicle id | `''` |
    | `farm.parties` (1f, unused in M0) | `deere` | `party` | Deere client id | Deere org id |

    `NormalizedPosition` / `NormalizedVehicleStat` carry `sourceOrg` (the Deere org a machine was read
    from, `''` for ELDs) so the lookup key is complete. The simulated farm's exact rows come from
    `simExternalRefs(farm, ELD_VENDOR)` (section 9). Adding a kind goes through your report.
- **Roles:** migrations run as `postgres`; the app runs as `farm_app` (USAGE on the four schemas and
  `extensions`; SELECT/INSERT/UPDATE/DELETE on all their tables via default privileges; EXECUTE on `app.*`;
  no CREATE anywhere; search_path `"$user", public, extensions`).

| Table | Notes |
|---|---|
| `farm.parties` | kind `person`\|`org`, `org_id`, `display_name`, `roles text[]` ⊆ owner, crew, landlord, customer, elevator, vendor, neighbor; phone, email, address, `introduced_by`, notes |
| `farm.farms` | name, `client_party_id` (null = your operation), `deere_farm_id` |
| `farm.fields` | `farm_id`, name, `county_fips` (5 digits), tenure `owned`\|`cash_rent`\|`share`\|`custom`, `landlord_party_id`, `deere_field_id`, active, notes |
| `farm.field_boundaries` | `field_id`, `geom` MultiPolygon, `acres` (trigger: `ST_Area(geom::geography)/4046.86`, never write it), `valid tstzrange` (default `[now(),)`), `source`, `source_id`, `source_ref`, `derived_stale`; **EXCLUDE** `field_boundaries_no_overlap` (one version per field at any instant); to replace a boundary, close the current one (`valid = [from, t)`) and insert `[t, null)` |
| `farm.current_boundaries` | view: versions whose `valid @> now()` (security_invoker) |
| `farm.field_seasons` | `field_id`, `crop_year` (unique together), crop, variety, `planted_on`, `harvested_on`, `yield_bu_ac`, source |
| `farm.machines` | kind (combine, tractor, sprayer, planter, grain_cart, semi, trailer, drone, pickup), `unit_no`, make, model, year, `vin_serial`, status `active`\|`down`\|`retired`, `down_reason`, `engine_hours`, `odometer_mi` |
| `farm.machine_state` | PK `machine_id`; `ts` (wall clock), `geom` Point, `speed_mph`, `heading`, activity (working, transport, idle, queued), `current_field_id`, `fuel_pct`, `engine_on`, `position_source` (eld, deere_working, cab_device, manual) |
| `farm.positions` | PK (`machine_id`, `ts`), `geom` Point, `speed_mph`, `heading`, `engine_on`, `source`; BRIN on `ts`; 90-day retention (later job) |
| `farm.geofences` | kind (elevator, field_entrance, shop, bin_site, fuel), name, `party_id`, `field_id`, `geom` Polygon, active |
| `ingest.external_refs` | (`source`, `kind`, `external_id`, `source_org`) unique → `entity_id`; vocabulary and helpers above |
| `ingest.sync_state` | PK (`source`, `stream`); mode, `cursor jsonb`, `lease_until`, `lease_token`, `next_run_at`, `last_run_at`, `last_ok_at`, `last_error`, `last_error_at`, `extra jsonb` |
| `ingest.job_runs` | job, host, `started_at`, `finished_at`, ok, items, note, error |
| `ingest.raw_events` | source, stream, `external_id`, payload, `sha256` (64 hex), `fetched_at`, status `pending`\|`processed`\|`dead`, attempts, `last_error`, `processed_at`; unique (source, stream, external_id, sha256) |
| `ingest.oauth_tokens` | source, `org_external_id` (unique together), ciphertext, `expires_at`, `refresh_expires_at`, scopes |
| `app.settings` | key → jsonb value |
| `app.topic_seq` | topic → seq (bigint) |

GiST index on every geometry column (a DB test enforces it for new tables too).

**SQL functions** (EXECUTE granted to farm_app):

| Function | Contract |
|---|---|
| `app.publish(topic text, event text, payload jsonb)` | exactly plan §1: bumps `app.topic_seq`, merges `seq` into the payload, `realtime.send` if present else `pg_notify('app_events', {topic, event, payload})`. Inside a transaction it delivers on commit |
| `app.ensure_stream(source, stream, mode default 'sim')` | upsert the `ingest.sync_state` row (updates mode if different). Call before claiming (TS: `ensureStream`) |
| `app.claim_due(source, stream, lease_seconds int) → setof ingest.sync_state` | single `UPDATE … RETURNING`: claims when mode ≠ `off`, no unexpired lease, `next_run_at` null or past, `lease_seconds > 0`; sets `lease_until`, a fresh `lease_token`, `last_run_at`. Exactly one concurrent caller wins. The row comes back **snake_case** (`lease_until`, `lease_token`, …); TS: `claimDue()` returns a camelCase `ClaimedLease \| null` (`toClaimedLease(row)` maps a raw row) |
| `app.release_lease(source, stream, lease_token, ok bool, error text default null, next_run_at timestamptz default null) → bool` | clears the lease only if the token still matches; ok → `last_ok_at = now()`; failure → `last_error`, `last_error_at`; sets `next_run_at` (backoff / Retry-After). TS: `releaseLease(ex, lease, { ok, error, nextRunAt })`. Advance the cursor in the landing transaction with `advanceCursor(tx, lease, cursor)` (an `update … where lease_token = …`; false = lease lost) |
| `app.mvt_fields(z int, x int, y int) → bytea` | MVT, layer **`fields`**, extent 4096, buffer 64, from `farm.current_boundaries` ⋈ active `farm.fields`; properties `id` (uuid text), `name`, `acres` (1 decimal), `tenure`, `farm_id`; `''` when empty. Serve as `application/vnd.mapbox-vector-tile` with `Cache-Control: private` (fields are private data) |

**`app.settings` keys** (readers treat a missing key as its default; `db:configure local` inserts defaults):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `clock.paused` | boolean | `false` | The **job clock** is paused: `/api/jobs/<name>` answers `202 { skipped: 'paused' }` without claiming, and tools/clock skips firing. Toggled on `/admin/connectors`; publish `admin`/`clock { paused }` on change. Data goes stale while paused. (Pausing the **simulation** is different: `POST /_control/clock { action: 'pause' }` on the stand-in freezes machines but keeps them fresh.) |

---

## 5. Jobs (`src/jobs/types.ts`, `src/jobs/schedule.ts`)

```ts
type EverySpec = `${number} seconds`;               // only '1 seconds' … '59 seconds'
type JobDef =
  | { every: EverySpec; host?: 'app' | 'pc'; budgetMs?: number; demoEvery?: EverySpec; run(ctx: JobContext): Promise<JobResult> }
  | { cron: string;     host?: 'app' | 'pc'; budgetMs?: number; demoEvery?: EverySpec; run(ctx: JobContext): Promise<JobResult> };
interface JobContext { name; db: Db; pool: pg.Pool; log: JobLogger; signal: AbortSignal; now(): Date; deadline: Date }
interface JobResult { items: number; note?: string }
type JobRegistry = Record<string, JobDef>;
// src/jobs/registry.ts: export const jobs = {...} satisfies JobRegistry; export const registry: JobRegistry = jobs;
```

- Exactly one of `every` (1-59 seconds, pg_cron's only interval form) or `cron` (5 fields, **UTC**, only
  digits `* , - /`). Names are dotted lower-case (`fleet.trucks`); they become `/api/jobs/<name>`,
  `ingest.job_runs.job` and the pg_cron job name. `budgetMs` default 45 000, max 55 000.
- `demoEvery` (stage 3): the local demo cadence. `ValidJob.demoSchedule` holds it (or null);
  `clockSchedule(job, demo)` is what tools/clock fires with `JOBS_DEMO_CADENCE=on`. `jobs:emit-cron`
  and pg_cron ignore it: production always runs `every` / `cron`.
- `validateRegistry(jobs)` → `ValidJob[]` (throws one error listing every problem); the clock and
  `jobs:emit-cron` must both use it. Also `parseEvery`, `validateCron`, `nextRun(schedule, from)` (every-jobs
  fire on epoch-aligned multiples), `toPgCronSchedule`.
- Consumers import `registry` (typed `JobRegistry`, so `registry[name]` is `JobDef | undefined` and
  compiles while `jobs` is empty) from `src/jobs/registry.ts`; vendors adds entries to `jobs`.
- **`pnpm jobs:emit-cron`** (reserved → `scripts/jobs-emit-cron.ts`, owner runtime; optional in M0,
  required by MD for `db:configure prod`, and what a `CLOCK=pgcron` rehearsal would load):
  `validateRegistry(registry)`, skip `host: 'pc'` jobs, and write `db/supabase/cron.sql` with one
  named (so re-applying updates it) `cron.schedule('<name>', '<toPgCronSchedule(...)>', …)` per
  job whose command is a `net.http_post` to `<base>/api/jobs/<name>` with the bearer header and
  `timeout_milliseconds := 5000` (plan §1). `JOBS_SECRET` is never written into the file: the
  command reads it at run time (Vault in production, `app.settings` or a psql variable locally).
  If it isn't built in M0, it arrives at MD.

### Leases: two levels, two rows (`src/db/leases.ts`)

| Level | Row (`ingest.sync_state`) | Claimed by | Length | When busy |
|---|---|---|---|---|
| **Job** | `('job', <job name>)`, mode `live` | `POST /api/jobs/<name>`, **before** the 202 | `jobLeaseSeconds(budgetMs)` = ceil(budgetMs / 1000) + 30 | route answers `202 { skipped: 'busy' }` |
| **Stream** | `(<connector source>, <stream>)`, e.g. `('samsara', 'positions')`, mode = configured | `runSyncStep`, **inside** `run(ctx)` | `spec.leaseSeconds` (default 90) | `SyncStepResult { claimed: false, skipped: 'lease held elsewhere' }`; the job returns `{ items: 0, note: 'lease held elsewhere' }` |

The route never claims a stream row and runSyncStep never claims the job row, so the two never
collide. The job lease stops overlapping runs of one job; the stream lease guards the cursor (two jobs,
or a webhook nudge plus the clock, can't land the same page twice).

**The route** (runtime agent), in order:
1. `Authorization: Bearer <JOBS_SECRET>` (constant-time compare) → else `401`; unknown name → `404`.
2. `app.settings` `clock.paused` = true → `202 { skipped: 'paused' }` (claims nothing).
3. `await ensureStream(pool, JOB_LEASE_SOURCE, name, JOB_LEASE_MODE)` then
   `const lease = await claimDue(pool, JOB_LEASE_SOURCE, name, jobLeaseSeconds(budgetMs))`;
   `null` → `202 { skipped: 'busy' }`.
4. `202 { accepted: true, name }`.
5. In `after()`: build `JobContext` (`deadline` = start + budgetMs; `signal` aborts at the deadline),
   `await def.run(ctx)` (a throw counts as failure), then `releaseLease(pool, lease, { ok, error })` and
   insert one `ingest.job_runs` row (`job`, `host`, `started_at`, `finished_at`, `ok`, `items`, `note`, `error`).

`clock.paused` helpers: `readClockPaused(ex)` and `setClockPaused(db, paused)` (writes the key and
publishes `admin`/`clock` in one transaction) live in `src/db/settings.ts` (stage 3; built in
`src/app/api/jobs/_lib/clock-setting.ts`).

No child processes, nothing from `tools/**` or `scripts/**`, no `src/lib/proc.ts` / `src/db/admin.ts`
(directly or transitively), no GDAL (Biome + `src/seams.test.ts` walk the import graph of `src/jobs/**`).
`/api/jobs`, `/api/realtime`, `/api/tiles`, `/api/webhooks`, `/api/oauth` must never answer 3xx (no
`proxy.ts` yet; keep it that way when it arrives). `next.config.ts` sets `skipTrailingSlashRedirect`
(stage 3), because Next answered `308` for a trailing slash; `e2e/routes.spec.ts` checks it.

## 6. Realtime (`src/platform/realtime/types.ts`, `publish.ts`)

- Server: `publish(topic, event, payload, executor = getPool())` → `select app.publish($1,$2,$3::jsonb)`.
  `executor` is any `Executor` from `src/db/exec.ts` (pg pool/client or Drizzle db/**tx**), so a sync
  step's upsert transaction or the seed can publish in-transaction (delivered on commit, dropped on
  rollback). Payloads must be JSON objects. Over `MAX_PAYLOAD_BYTES` (7 500; pg_notify rejects 8 000 or more) it
  sends `invalidate { event, reason: 'too_large' }` instead. The size is measured on the **exact NOTIFY
  text** Postgres builds (`messageBytes` / `notifyText`: jsonb text output adds a space after every `:`
  and `,`, and `json_build_object` writes `"topic" : …`), budgeting a 16-digit `seq`; that is about 7%
  more than `JSON.stringify`. **About 20 machines fit in one `fleet.tick`** (21 compact ones); M0 runs ~11.
  Beyond that clients get `invalidate` and refetch `GET /api/fleet`.
- Topics (`TopicEvents`): **`fleet`** → `tick: FleetTick`, `invalidate`; **`admin`** →
  `clock: { paused }`, `sync.status: SyncStatusPayload`, `invalidate`. Per-entity topics later use
  `name:<uuid>`. Add a topic by reporting it.
- Local transport: `LISTEN app_events`; each notification is `NotifyMessage { topic, event, payload }`
  with `payload.seq`. The SSE route (`/api/realtime`) sends `text/event-stream`,
  `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, a 15 s heartbeat, from one
  `globalThis` LISTEN connection (a dedicated `pg.Client` as farm_app, not from the pool).
- Client: `getRealtimeClient(): RealtimeClient` with
  `subscribe(topic, onEvent(evt: TopicMessage<topic>), { onResync })` → unsubscribe. `TopicMessage<T>`
  is a union discriminated on `event`, so `if (evt.event === 'tick')` narrows `evt.payload` to
  `FleetTick` with no cast. One shared EventSource per tab. `onResync` fires after every (re)connect,
  on a `seq` gap and on `invalidate` (which is still passed to `onEvent`); subscribers refetch their
  snapshot there (fleet: `GET /api/fleet`).
- SSE wire format (runtime, documented in `src/platform/realtime/sse.ts`): each notification is a
  `message` with the raw NOTIFY JSON; three named events on top: `ready` (LISTEN is active and the
  subscriber registered; the client resyncs), `resync` (the hub's LISTEN reconnected) and `ping`
  (the 15 s heartbeat, an event rather than a comment so the client's 45 s watchdog sees it).

## 7. Fleet (`src/domain/fleet.ts`)

```ts
interface MachineView {
  id: string; unitNo: string; kind: MachineKind; lng: number; lat: number;
  heading: number;  /* [0,360) */  speedMph: number;  /* >= 0 */
  activity: 'working' | 'transport' | 'idle' | 'queued'; fieldId: string | null;
  positionSource: 'eld' | 'deere_working' | 'cab_device' | 'manual';
  ts: string;       /* wall-clock ISO */  status: 'active' | 'down' | 'retired'; stale: boolean;
}
interface FleetTick { ts: string; machines: MachineView[] }   // realtime fleet/tick and GET /api/fleet
```

`fleetTickSchema` / `machineViewSchema` (zod) validate both; `isStale(ts, now, seconds)`,
`isMachineStale(m, now, thresholds)` / `staleAfterFor(positionSource, thresholds)` (stage 3: Deere
fixes use `FLEET_STALE_SECONDS_DEERE`, everything else `FLEET_STALE_SECONDS`) and
`normalizeHeading()` are the shared helpers. `stale` is computed on the server when the tick (or the
`GET /api/fleet` snapshot) is built.

**Staleness has two owners, so "trucks API down → trucks go stale with a badge" works even when no
tick arrives:**
- **vendors:** every claimed run of a `fleet.*` job publishes one `fleet.tick` from `afterRun`, **also
  when the poll failed** (section 8), built from `farm.machine_state` with `stale` recomputed at
  build time. `GET /api/fleet` recomputes `stale` per request.
- **map:** the board and `/m` re-evaluate `isStale(m.ts, now, publicConfig.staleAfterSeconds)` for
  every machine on a **5-10 s timer**, not only when a tick arrives, and show the stale badge from
  that (the server's `stale` is only the value at build time). `now` is the browser's wall clock;
  timestamps are wall clock in sim mode too (section 9).

## 8. Connectors (`src/connectors/types.ts`)

- `Mode` = `sim` | `replay` | `sandbox` | `live` | `off` (`CONNECTOR_MODES`); `ConnectorSource` =
  `deere` | `samsara` | `motive` | `nws` | `qbo` | `bushel` | `drone`; row sources also `app`, `import`,
  `demo`, `sim`.
- Ports: `PositionSource.poll(cursor)`, `VehicleStatsSource.statsSince(cursor)` → `PollResult<T> { items, cursor, hasMore? }`
  with `NormalizedPosition` / `NormalizedVehicleStat` (wall-clock ISO `ts`).
- Sync step: `RunSyncStep = (spec: SyncStepSpec<TRaw, TNorm>, ctx: JobContext) => Promise<SyncStepResult>`,
  implemented by the vendors agent in `src/connectors/sync-step.ts`. It runs inside `run(ctx)` (the route
  already holds the **job** lease) and owns only the **stream** lease (section 5), all through
  `src/db/leases.ts`:
  0. `ensureStream(ctx.pool, source, stream, spec.mode)`; `spec.mode === 'off'` → return
     `{ claimed: false, skipped: 'off' }` (job: `{ items: 0, note: 'off' }`);
  1. `claimDue(ctx.pool, source, stream, spec.leaseSeconds ?? 90)`; `null` → `{ claimed: false, skipped:
     'lease held elsewhere' }` (job: `{ items: 0, note: 'lease held elsewhere' }`);
  2. `poll(cursorOf(lease))` (cursors are stored as a jsonb string);
  3. one transaction lands `RawItem { externalId, payload }` rows in `ingest.raw_events` (sha256 dedupe)
     and calls `advanceCursor(tx, lease, cursor)` (false → lease lost: roll back, stop);
  4. process pending events one at a time (`map` pure → `upsert(tx, item, ctx)` resolving vendor ids with
     `resolveExternalRefs`), 5 attempts then `dead`, stop taking new ones after `ctx.deadline`;
  5. `releaseLease(ctx.pool, lease, { ok, error, nextRunAt })`;
  6. optional `afterRun` (one batched `fleet.tick`) **whenever claimed, ok or not**, after the release.
- **`SyncStepResult { claimed, ok, error?, skipped?, landed, processed, dead, cursor }`.** Failure rules:
  - before the claim (steps 0-1) database errors throw; nothing is held;
  - after the claim runSyncStep **never throws** for a poll error, a landing error or a lost lease: it
    releases with `{ ok: false, error, nextRunAt }` and returns `{ claimed: true, ok: false, error }`
    (`'lease lost'` when `advanceCursor` returned false). `nextRunAt = retryAfterFrom(err, ctx.job.now())`:
    now + `err.retryAfterSeconds` when the client's error carries that number (429/503 `Retry-After`),
    else `null` (due at the next tick: the job cadence is the backoff). Vendor clients put
    `retryAfterSeconds` on the errors they throw;
  - one event failing to map/upsert is **not** a step failure: it counts an attempt / `dead`, `ok` stays true;
  - `afterRun` runs after the release whenever claimed, so ticks keep flowing during an outage
    (section 7); if it throws, the error is logged and the result becomes `ok: false, error: 'afterRun: …'`;
  - the job ends with `return syncStepJobResult(result)`: skipped → `{ items: 0, note }`, `!ok` → throws
    `SyncStepError` (so `ingest.job_runs` records `ok = false` and the error), ok → `{ items: processed }`
    plus `note: '<n> dead-lettered'` when `dead > 0`.
- `SyncStepSpec` carries `mode` (the configured `CONNECTOR_*` value) next to `source` and `stream`.
- Sim mode is the **live client** against `${VENDOR_SIM_URL}/<vendor>` with `SIM_CREDENTIALS` (from
  `src/sim/types.ts`); the same zod schemas validate stand-in and real responses.

## 9. Simulator and stand-in (`src/sim/types.ts`)

- **The time rule:** the world advances in **sim time**; every timestamp the stand-in reports is
  **wall-clock** time. A request at wall `w` samples `world.machineAt(id, clock.wallToSim(w))` and stamps it
  `w`. So a 30x day yields real "now" timestamps; pausing the sim freezes machines without making them
  stale; a vendor outage makes them stale without freezing sim time.
- `ScenarioName`: `harvest-day`, `winter-idle`, `planting-day`, `spray-windy`, `breakdown`, `bad-morning`.
- `SimFarm { parties, farms, fields, machines, elevators, shop, roads }` with stable ids (`demoId(key)`):
  farm units carry `deereFarmId` and `deereOrgId` (`SIM_DEERE_HOME_ORG = 'org-home'` or
  `'org-customer-<n>'`); fields carry name, MultiPolygon boundary, tenure, farm/client, landlord, county,
  entrance point + road node, Deere field/boundary ids, `boundaryId` (id of the seeded current boundary
  row = `demoId('boundary:' + key)`) and optionally `sharedWith` a second org; machines carry kind, unitNo,
  make, model, year, `vendorIds { deere?, eld? }` and `deereOrgId` (required when `vendorIds.deere` is
  set; M0: `SIM_DEERE_HOME_ORG`); elevators carry a geofence Polygon and entrance; `roads` is the
  section-line `RoadGraph`. `farm` depends only on the seed.
- `SimWorld { scenario, seed, farm, startsAt, machineAt(machineId, simTime): SimMachineSample | null }`,
  `SimMachineSample { lng, lat, heading, speedMph, activity, engineOn, engineHours, odometerMi, fuelPct, fieldId }`.
  Factories from `src/sim/index.ts`: `buildSimFarm(seed?)`, `createSimWorld({ scenario, seed? })`.
- `SimClock { wallToSim(wall), paused, speed }`; state `SimClockState { anchorWall, anchorSim, speed, paused }`,
  normative arithmetic `wallToSim(state, wall)`; every change re-anchors at the current wall time; the
  stand-in persists it in `.data/vendor-sim/state.json`. `SIM_FROZEN_AT` = `freeze` at boot.
- **Seed contract:** `scripts/seed.ts demo` writes the SimFarm into `farm.*` with id = SimFarm id,
  `source='demo'`, `source_id=key`, one current boundary per field (id `field.boundaryId`, `source_id`
  `boundary:<key>`), one `farm.geofences` row per elevator (kind `elevator`) and the shop (kind `shop`),
  plus **exactly** the external refs `simExternalRefs(farm, cfg.ELD_VENDOR)` returns, written with
  `upsertExternalRef` (tuples in section 4):
  - Deere farm `('deere', 'farm', unit.deereFarmId, unit.deereOrgId)`;
  - Deere field `('deere', 'field', field.deereFieldId, <owning unit's deereOrgId>)`, plus
    `('deere', 'field', sharedWith.deereFieldId, sharedWith.deereOrgId)` → the same field;
  - Deere boundary `('deere', 'boundary', field.deereBoundaryId, <owning org>)` → `field.boundaryId`;
  - Deere machine `('deere', 'machine', vendorIds.deere, machine.deereOrgId)`;
  - ELD vehicle `(ELD_VENDOR, 'machine', vendorIds.eld, '')`.

  The seed also writes one `farm.geofences` row per bin site (kind `bin_site`, from the demo farm's
  `binSites`; stage 3 accepted it as is). Scenario starts (`world.startsAt`): harvest-day and
  breakdown 07:00 EDT Oct 15 2026, bad-morning 05:45 (same motion, 6 a.m. outage), planting-day
  May 5 07:15, spray-windy Jun 9 06:00, winter-idle Jan 15 09:00 EST.

  The Deere stand-in serves each org's data under that org id, so the org a sync reads from is the
  `source_org` it looks up. The seed refuses non-local databases (`assertLocalUrl` in
  `src/db/admin.ts`) and is idempotent.
- **Stand-in** (one Node server, loopback only, default 4010): vendor APIs under `/deere`, `/samsara`,
  `/motive`, `/qbo`, `/nws`; control API (403 unless loopback):
  - `GET/POST /_control/clock` — `ClockControlRequest` (`pause` | `resume` | `speed` | `jump` | `freeze`) → `SimClockStatus`
  - `GET/POST /_control/scenario` — `ScenarioControlRequest { scenario, seed? }` → `ScenarioStatus` (re-anchors at `startsAt`)
  - `GET/POST /_control/faults` — `FaultsControlRequest` (`set` | `add` | `remove` | `clear`) → `FaultsStatus`
  - `POST /_control/reset` — `ResetControlRequest` → `SimStatus`; `GET /_control/status` → `SimStatus`
  - `FaultRule { id, vendor | '*', pathPrefix?, kind, probability?, latencyMs?, status?, retryAfterSeconds?,
    from?/until? (wall), simFrom?/simUntil? (sim), label? }`, kinds `latency`, `timeout`, `http_error`,
    `rate_limit`, `token_expired`, `token_revoked`, `duplicate_page`, `out_of_order`, `webhook_replay`,
    `webhook_reorder`, `outage`. "Trucks API down" = `{ vendor: 'samsara', kind: 'outage', label: 'trucks API down' }`.
  - Webhooks go to `${PUBLIC_URL}/api/webhooks/<source>` (not sent yet in M0).
  - Launch (stage 3): `pnpm dev` / `pnpm pilot` restart the scenario day of a stand-in they start
    (`POST /_control/scenario`, faults cleared, Deere grants kept) and jump `LAUNCH_OFFSET_MINUTES`
    into it (harvest-day and breakdown: 90, i.e. 08:30, when every machine is busy;
    `--from-start` skips the jump), unless `--resume` or `SIM_FROZEN_AT`; a stand-in already
    running is reused as is. Bootstrap runs
    `tools/vendor-sim/connect.ts` (`pnpm vendor-sim:connect`): the Deere sim grant and an ELD token
    check, against the running stand-in or one it starts for the purpose.

---

## 10. Storage and the offline basemap (owner: map)

Plan §1 *Storage* / *Basemap* and §2 step 6. Only `src/platform/**` touches the filesystem for storage.

- **Adapter** `src/platform/storage/local.ts` (map agent; read side only in M0): root
  `path.resolve(cfg.projectDir, cfg.STORAGE_DIR)` (default `.data/storage`, gitignored); objects at
  `<root>/<bucket>/<key>`. A **path-traversal guard** rejects empty segments, `.`/`..`, backslashes, NUL,
  drive letters and absolute keys, and checks the resolved path stays under `<root>/<bucket>/`. Buckets:
  `tiles` (public-domain and app basemap data; content-addressed; never overwritten) in M0, `uploads`
  (private) from 2c. Signed URLs and PUT (4 MB limit, two-step grant) arrive in 1d/2c.
- **Route** `GET`/`HEAD /api/storage/[bucket]/[...key]` (map agent): only bucket `tiles` in M0 (others 404);
  `Accept-Ranges: bytes`; `Range: bytes=a-b` / `a-` / `-n` → `206` with `Content-Range`, unsatisfiable →
  `416`; strong `ETag` (`"<sha8>"` for content-addressed keys, size + mtime otherwise) and `If-None-Match`
  → `304`; `Content-Type` by extension (`.pmtiles` `application/vnd.pmtiles`, `.pbf` `application/x-protobuf`,
  `.json`, `.png`); `Cache-Control: public, max-age=31536000, immutable` for content-addressed keys and
  `assets/**`, `no-cache` for `basemap.json`; `400` for a bad key, `404` when missing. Streams the file
  (no 4 MB buffering). Runtime `nodejs`, dynamic.
- **Layout** (written by `tools/gis/basemap.ts` = `pnpm gis:basemap`, map agent):
  - `tiles/basemap.<sha8>.pmtiles`: the `pmtiles extract … --bbox=-84.45,41.65,-83.10,42.15 --maxzoom=15`
    output (`protomaps/go-pmtiles:v1.31.2` in Docker), `sha8` = first 8 hex of its sha256;
  - `tiles/assets/fonts/<fontstack>/<range>.pbf` and `tiles/assets/sprites/...`, mirroring the pinned
    protomaps/basemaps-assets commit that `@protomaps/basemaps` 5.7.2 expects;
  - `tiles/basemap.json` (**the lookup until `gis.map_layers` exists in 1d**), written last and atomically
    (temp file + rename): `{ key: 'basemap.<sha8>.pmtiles', sha8, bytes, builtAt, build, bbox, maxzoom,
    assetsCommit }`. Older `basemap.*.pmtiles` are deleted only after `basemap.json` points elsewhere.
- **Use:** a server component reads `basemap.json` through the adapter and passes URLs down as props:
  `pmtiles://<origin>/api/storage/tiles/<key>`, glyphs `<origin>/api/storage/tiles/assets/fonts/{fontstack}/{range}.pbf`,
  sprite `<origin>/api/storage/tiles/assets/sprites/...`. If `basemap.json` is missing the board still renders
  fields and fleet on a plain background with a "basemap missing: run `pnpm gis:basemap`" badge (CI and
  e2e run that way); it never falls back to an online style unless `BASEMAP_STYLE=openfreemap`.
- **Never** put tiles, fonts or sprites in `public/` or in git.
- **Bootstrap** (runtime agent) runs `tools/gis/basemap.ts` (as `process.execPath` + tsx's CLI, see
  `src/lib/proc.ts`) when `tiles/basemap.json` or the file it names is missing, and exits non-zero with
  "offline basemap missing, run `pnpm gis:basemap`" if that fails. `tools/gis/basemap.ts` is idempotent
  and exits non-zero on any failure. **(stage 3)** The synthetic test basemap (`build`
  `local:synthetic…`, `pnpm gis:basemap --synthetic`) counts as missing, so a plain bootstrap
  fetches the real extract; `pnpm run bootstrap --synthetic-basemap` installs or accepts the
  synthetic one instead (CI, machines that can't reach build.protomaps.com). With `--no-docker`
  bootstrap cannot build a basemap (it needs `protomaps/go-pmtiles`) and says so. **(M1 polish)**
  When the fetch fails (or `--no-docker`) and a synthetic basemap is already installed, a plain
  bootstrap keeps it with a `WARN offline basemap kept …` line and goes on (it never exits non-zero
  for it); only a PC with no basemap at all stops with "offline basemap missing".

---

## 11. Commands available now

| Command | Does |
|---|---|
| `pnpm install` | clean and non-interactive (`allowBuilds: esbuild`) |
| `pnpm lint` / `lint:fix` | Biome (formatter + linter + seam rules) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` / `pnpm test:db` | unit / database projects (section 2) |
| `pnpm build` / `pnpm start` / `pnpm dev:next` | Next |
| `pnpm test:e2e` | Playwright (`baseURL` from `getE2eSettings()`, section 3). Without `E2E_BASE_URL` it starts `pnpm pilot` itself (CI: `--skip-build` after `pnpm build`) or reuses an app on that port (stage 3) |
| `pnpm vendor-sim:connect` | the sim connector setup bootstrap runs (stage 3) |
| `pnpm env:init` | write `.env` + `.env.local` (idempotent) |
| `pnpm db:up` / `db:down` / `db:nuke` | container (foundation only; not for parallel agents) |
| `pnpm db:migrate` / `db:configure local` / `db:check` / `db:reset` / `db:lint` / `db:test-template [--force]` / `db:pending` | see `scripts/db.ts` header |
| `pnpm db:generate` / `db:studio` | drizzle-kit (snapshots in `db/migrations/meta` mirror `src/db/schema`) |
| `GET /api/health` | `200 { ok: true, db: true, postgis, time, dbTime }` or `503 { ok: false, db: false, … }` |

---

## 12. Stage 3 (integration) changes

| Area | Change | Why |
|---|---|---|
| Config | `JOBS_DEMO_CADENCE`, `FLEET_STALE_SECONDS_DEERE`; `publicConfig().deereStaleAfterSeconds`; `getE2eSettings().external`; `pnpm env:init` writes the demo values (`on`, `60`, `900`) | plan §1 "5 s in local demo mode"; vendors asked for a demo cadence key. A single stale threshold either took 10 min to show "trucks API down" or flagged idle Deere carts as stale |
| Jobs | `JobDef.demoEvery`, `ValidJob.demoSchedule`, `clockSchedule()`; fleet.trucks 5 s / fleet.deere 15 s in demo | same |
| Fleet | `isMachineStale`, `staleAfterFor`, `StaleThresholds`; `fleetSnapshot(ex, now, number \| StaleThresholds)`, `staleThresholdsOf(cfg)` | per-source staleness on the server and the map |
| Settings | `src/db/settings.ts` (from `src/app/api/jobs/_lib/clock-setting.ts`) | runtime's request |
| Next | `skipTrailingSlashRedirect: true` | runtime: a trailing slash got 308 on routes that must never answer 3xx |
| Launch | `pnpm dev`/`pilot` restart the scenario day of a stand-in they start, harvest-day at 08:30 (`--from-start`, `--resume`); `NEXT_TELEMETRY_DISABLED=1` for the children | a launch otherwise resumed whatever sim day (or night, or fault) the last session left, and at 07:00 only the parked semis showed for the first 11 minutes |
| Bootstrap | `--synthetic-basemap`; synthetic counts as missing otherwise; `tools/vendor-sim/connect.ts` | build.protomaps.com was unreachable from the build machine; the sim-connect step had no entry |
| e2e | `playwright.config.ts`: WebGL flags in `use`, `webServer` = `pnpm pilot`; `e2e/m0-demo.spec.ts` (the M0 demo), `e2e/routes.spec.ts` | map and runtime asked for both |
| db/pending | no builder left SQL there: no new migration | |

### Review fixes after stage 3 (Oct 29, 2026)

Additive: every earlier contract still holds (an existing call keeps compiling and behaving the
same), except where a row says a value is now refused.

| Area | Change | Why |
|---|---|---|
| Realtime (§6) | `getRealtimeClient(kind = 'sse')` takes the adapter kind (`publicConfig().realtime`); `'supabase'` returns the inert client (one `onResync`, a console warning) until the Broadcast adapter lands at MD. BoardScreen, `LiveRefresh` and `RealtimeMonitor` pass it | `NEXT_PUBLIC_REALTIME` reached no client |
| Fleet on the map (§7) | `src/ui/map/fleet/feed.ts`: the first snapshot loads 1.5 s after subscribing if no resync came, and the 5 s staleness timer also refetches `GET /api/fleet` while realtime isn't connected. A glide lasts the machine's own fix interval (the shorter of its last two gaps between fixes) | an unreachable `/api/realtime` left the map empty; two full-fleet publishers broke the arrival-gap glide |
| Storage (§10) | `StorageReader.publicUrl(bucket, key)`; the board builds the PMTiles, glyph and sprite URLs through it (local: `/api/storage/<bucket>/<key>`, segments encoded) | at MD the Supabase adapter returns the public bucket URLs; no UI change |
| HTTP limits (plan §1) | `src/platform/http/limits.ts`: `limitedJson` / `limitedBytes` (outside production a response over 4 MiB becomes a 500 saying to page or stream it) and `readLimitedText` (request bodies, 4 MB cap, chunked included). Every API route except `/api/storage` and `/api/realtime` uses them (`src/seams.test.ts`) | the dev guard the plan asks for |
| Admin | `/admin/*`, its server actions and the non-sim start of `GET /api/oauth/deere` need the `farm_admin` cookie: an HMAC of `SESSION_SECRET` (`src/platform/auth/admin-key.ts`) set by `GET /admin/unlock?key=…`, which `pnpm dev` / `pnpm pilot` / bootstrap print on the PC; never in production. e2e contexts get it from `e2e/support/admin.ts` | Next listens on the LAN and the actions had no check; until 1a's sign-in |
| OAuth tokens (§4) | the stand-in's Deere grant lives under `org_external_id` `SIM_GRANT_ORG` (`'sim'`), chosen by `userGrantOrg(endpoints)`; real grants stay under `''` | a sim client sent a real grant to `VENDOR_SIM_URL` and replaced it |
| Config (§3) | `VENDOR_SIM_URL` must be loopback (127.0.0.1, localhost, [::1]); `BASEMAP_STYLE=openfreemap` is refused until that style exists | sim traffic never leaves the PC; the switch was silently ignored |
| Stand-in (§9) | `/_control/*` also needs a loopback `Host`, no foreign `Origin`, and `application/json` for POST (415 otherwise); `startVendorSim` refuses a non-loopback `host` | a web page in the PC's browser could drive the control API |
| Webhooks | sim-mode secrets are `simWebhookSecret(SESSION_SECRET, source)` (was the public `SIM_WEBHOOK_SECRETS`); off/sandbox/live are refused before the body is read | forged sim webhooks; unbounded body reads |
| Sync step (§8) | pending raw events are processed `order by fetched_at, external_id, id` (every external id ends in its series' ISO time) | in-page order was random, so fuel ("latest wins") could end on an older reading |
| Motive (placeholder) | the positions cursor is a JSON map of vehicle id to newest `located_at` | one global watermark dropped slower trucks |
| DB guards | `isLoopbackUrl` / `assertLocalUrl` check every host pg would use (`?host=`, `hostaddr`; `connectionHosts`); bootstrap refuses a non-local `DATABASE_URL_MIGRATE` before connecting | the guard could be bypassed, and `--db=external` migrated whatever it named |
| Launchers | port checks bind like the servers (`src/lib/ports.ts`), with a hint for Windows excluded port ranges; bootstrap also checks the stand-in's port | connect-probes said "free" for reserved or other-address ports |

Still open (reported, not done in M0): `loadBu` on `SimMachineSample` (3d), webhook secrets
(`SAMSARA_WEBHOOK_SECRET` …, needed before sandbox/live webhooks), the stand-in sending webhooks
(`webhook_replay` / `webhook_reorder` faults are accepted but inert; it signs with
`simWebhookSecret`), `pnpm pilot:https` (slice 2c), a native go-pmtiles for
`bootstrap --no-docker`, real authentication on `/admin/*` (1a; the admin key stands in), a
time guard on `machine_state.fuel_pct` across pages (needs a stat-time column), the
`BASEMAP_STYLE=openfreemap` style, the Supabase Realtime client adapter (MD), and the plan §7
`ipad` (WebKit) and iPhone e2e projects (not verified: WebKit couldn't be downloaded on the build
machine).
