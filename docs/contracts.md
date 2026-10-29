# Contracts for M0 stage 2 (parallel agents)

Oct 29, 2026 · written by the M0 stage 1 (foundation) build · companion to `docs/build-plan.md`

Stage 1 built the tooling, config, database, test harness and the shared interfaces. Four agents now
build the rest of M0 in parallel. This page is the only agreement between them: the directories each one
owns, the ports, the rules for shared files, and every contract (TypeScript files in `src/` plus SQL).
If a contract doesn't fit, **don't change it in place**: work around it and say exactly what you need in
your stage report.

---

## 1. Who owns what

| Agent | Builds | Owns (may create and edit) | Next / stand-in ports |
|---|---|---|---|
| **map** | War-room map shell: `WarRoomMap` (react-map-gl + `MapLibreOverlay`, interleaved), local PMTiles basemap with local fonts/sprites, field fills from `/api/tiles/fields`, fleet `IconLayer` gliding between ticks, `/board` (touch pan/pinch/rotate) and `/m`, Playwright specs | `src/ui/**`, `src/app/board/**`, `src/app/m/**`, `src/app/api/tiles/**`, `src/app/api/fleet/**` *(consumer side only if the vendors agent hasn't landed it; see below)*, `tools/gis/basemap.ts`, `public/**`, `e2e/**` | 3101 / 4011 |
| **sim** | Deterministic world v0 (grid fields, fictional parties, fleet, elevators, section-line roads, combines in passes, carts, semis to elevators), scenarios, demo seed | `src/sim/**` except `src/sim/types.ts` and `src/sim/vendors/**`, `scripts/seed.ts`, `scripts/sim-scenario.ts`, `tools/seed/**`, `data/seed/**` | 3102 / 4012 |
| **vendors** | Vendor stand-in v0 (Samsara-shaped locations feed with bearer token + cursor paging; Deere-shaped OAuth flow + machine locations; fault injection and clock control APIs), the live clients in sim mode, `runSyncStep`, the `fleet.*` jobs and their batched `fleet.tick`, `GET /api/fleet` snapshot | `tools/vendor-sim/**`, `src/sim/vendors/**`, `src/connectors/**` except `src/connectors/types.ts`, `src/jobs/**` except `src/jobs/types.ts` and `src/jobs/schedule.ts`, `src/db/queries/fleet.ts`, `src/app/api/fleet/**`, `src/app/api/webhooks/**`, `src/app/api/oauth/**` | 3103 / 4013 |
| **runtime** | Realtime (SSE route + browser client), `/api/jobs/[name]` (secret, lease, 202, `after()`), the croner clock, `tools/dev.ts`, `pnpm pilot`, `scripts/bootstrap.ts` (full bootstrap built on `scripts/env.ts` and `scripts/db.ts`), `/admin/connectors` (mode, last OK, errors, clock pause, sim pause, fault toggles) | `src/platform/realtime/**` except `types.ts` and `publish.ts`, `src/app/api/realtime/**`, `src/app/api/jobs/**`, `tools/clock/**`, `tools/dev.ts`, `tools/pilot.ts`, `tools/https/**`, `scripts/bootstrap.ts`, `src/app/admin/**` | 3104 / 4014 |

`/api/fleet` belongs to **vendors** (it shares the query that builds `fleet.tick`); **map** only calls it.

**Foundation-owned (read-only for all four; request changes in your report):**
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.node-version`, `tsconfig.json`,
`biome.json`, `next.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `drizzle.config.ts`,
`docker-compose.yml`, `db/migrations/**`, `src/config.ts`, `src/db/**` (except `src/db/queries/fleet.ts`),
`src/domain/**`, `src/lib/**`, `src/test/**`, `scripts/env.ts`, `scripts/db.ts`, `scripts/lib/**`,
`src/app/layout.tsx`, `src/app/page.tsx`, `src/app/api/health/**`, and the contract files
`src/jobs/types.ts`, `src/jobs/schedule.ts`, `src/platform/realtime/types.ts`,
`src/platform/realtime/publish.ts`, `src/connectors/types.ts`, `src/sim/types.ts`, this file.

**Placeholders you replace (keep the exports):** `src/sim/index.ts` (sim: `buildSimFarm`, `createSimWorld`),
`src/platform/realtime/client.ts` (runtime: `getRealtimeClient()`), `src/jobs/registry.ts` (vendors: `jobs`).
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
- **Never run `pnpm db:nuke`, `pnpm db:down`, `pnpm db:up` or `docker compose` commands** against the
  shared container, and never `pnpm db:reset` the shared `postgres` database. Use your own dev
  database (section 2).
- **`package.json` scripts already reserved** (they fail until the owner creates the file):
  `dev` → `tools/dev.ts` (runtime), `pilot` → `tools/pilot.ts` (runtime), `clock` → `tools/clock/index.ts`
  (runtime), `bootstrap` → `scripts/bootstrap.ts` (runtime), `vendor-sim` → `tools/vendor-sim/index.ts`
  (vendors), `db:seed` → `scripts/seed.ts` (sim; `pnpm db:reset` runs `scripts/seed.ts demo` once it
  exists), `sim:scenario` → `scripts/sim-scenario.ts` (sim), `gis:basemap` → `tools/gis/basemap.ts` (map).
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

- The dev container `farm-manager-db-1` is running and migrated (`postgres` database), `farm_app` can log
  in, and `farm_test_template` exists. Get credentials by **copying `.env` and `.env.local` from the
  foundation checkout**; don't run `pnpm env:init` in a fresh checkout (it would mint a new DB password
  that doesn't match the volume).
- **Your own dev database:** point both URLs at `farm_dev_<agent>` and migrate; `db:migrate` creates a
  missing `farm_*` database on the local server. Shell variables win over env files, and Next/scripts
  also read `.env.development.local` (gitignored) before `.env.local`:
  ```
  DATABASE_URL=postgres://farm_app:<FARM_APP_PASSWORD>@127.0.0.1:15432/farm_dev_map
  DATABASE_URL_MIGRATE=postgres://postgres:<DB_PASSWORD>@127.0.0.1:15432/farm_dev_map
  PUBLIC_URL=http://localhost:3101
  VENDOR_SIM_URL=http://127.0.0.1:4011
  ```
  then `pnpm db:migrate`, `pnpm db:configure local` (skips pg_cron/pg_net outside `postgres`),
  `pnpm db:pending`, and `pnpm db:reset` whenever you like (it only touches that database).
- Run Next on your port: `pnpm dev:next --port 3101` or `pnpm build` then `pnpm start --port 3101`.

### Test databases

- `pnpm test` = unit project (`src/**/*.test.ts`, `scripts/**/*.test.ts`, `tools/**/*.test.ts`, no DB).
- `pnpm test:db` = db project (`**/*.db.test.ts` under `src/`, `db/`, `scripts/`, `tools/`). Its global
  setup rebuilds `farm_test_template` when the migrations hash changed and makes sure `farm_app` can log in.
- Each DB test file calls `const t = setupTestDb(import.meta.url)` (from `src/test/db.ts`) and gets its own
  database **`farm_test_<file-slug>_<6 hex>`**, cloned from `farm_test_template` (under an advisory lock),
  with `db/pending/*.sql` applied, dropped after the file. `t().db` / `t().pool` are **farm_app**;
  `t().adminDb` / `t().admin` are **postgres**. Names never collide across agents.
- Throwaway databases made by tools are `farm_lint_*` (db:lint) and `farm_check_*` (db:check).
  `pnpm db:test-template` also drops leftover `farm_test_*` databases nobody is connected to.
- Fixtures: `src/test/fixtures.ts` (`ADRIAN_QUARTER_SECTION`, `squareMultiPolygon`, `tileFor`, `insertField`).

---

## 3. Configuration (`src/config.ts`)

`src/config.ts` is **the only reader of `process.env`** (Biome `style/noProcessEnv` + `src/seams.test.ts`).
It loads `.env*` files with `@next/env`'s `loadEnvConfig` (CLI tools see what Next sees; existing
variables win; under `NODE_ENV=test` it also merges `.env.local`, which Next skips). Use:

- `getConfig()`: validated, memoized; throws `ConfigError` with a fix-it message.
- `tryGetConfig()`, `getMigrateUrl()`, `tryGetMigrateUrl()`, `getDevOrigins()` (never throws; next.config.ts).
- `publicConfig(cfg)`: `{ appEnv, realtime, basemapStyle, staleAfterSeconds }`. **Client components never
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
| `FLEET_STALE_SECONDS` | `600` | a machine whose latest fix is older is `stale` (demo: set e.g. 90) |
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
  field_boundaries, field_seasons, machines, geofences. Vendor ids map to entities in
  `ingest.external_refs (source, kind, external_id, source_org='')`.
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
| `ingest.external_refs` | (`source`, `kind`, `external_id`, `source_org`) unique → `entity_id` |
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
| `app.ensure_stream(source, stream, mode default 'sim')` | upsert the `ingest.sync_state` row (updates mode if different). Call at job start with the configured mode |
| `app.claim_due(source, stream, lease_seconds int) → setof ingest.sync_state` | single `UPDATE … RETURNING`: claims when mode ≠ `off`, no unexpired lease, `next_run_at` null or past, `lease_seconds > 0`; sets `lease_until`, a fresh `lease_token`, `last_run_at`. Exactly one concurrent caller wins |
| `app.release_lease(source, stream, lease_token, ok bool, error text default null, next_run_at timestamptz default null) → bool` | clears the lease only if the token still matches; ok → `last_ok_at = now()`; failure → `last_error`, `last_error_at`; sets `next_run_at` (backoff / Retry-After). Advance the cursor with `update ingest.sync_state set cursor = … where source = … and stream = … and lease_token = …` in the landing transaction |
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
  | { every: EverySpec; host?: 'app' | 'pc'; budgetMs?: number; run(ctx: JobContext): Promise<JobResult> }
  | { cron: string;     host?: 'app' | 'pc'; budgetMs?: number; run(ctx: JobContext): Promise<JobResult> };
interface JobContext { name; db: Db; pool: pg.Pool; log: JobLogger; signal: AbortSignal; now(): Date; deadline: Date }
interface JobResult { items: number; note?: string }
type JobRegistry = Record<string, JobDef>;            // src/jobs/registry.ts: export const jobs = {...} satisfies JobRegistry
```

- Exactly one of `every` (1-59 seconds, pg_cron's only interval form) or `cron` (5 fields, **UTC**, only
  digits `* , - /`). Names are dotted lower-case (`fleet.trucks`); they become `/api/jobs/<name>`,
  `ingest.job_runs.job` and the pg_cron job name. `budgetMs` default 45 000, max 55 000.
- `validateRegistry(jobs)` → `ValidJob[]` (throws one error listing every problem); the clock and
  `jobs:emit-cron` must both use it. Also `parseEvery`, `validateCron`, `nextRun(schedule, from)` (every-jobs
  fire on epoch-aligned multiples), `toPgCronSchedule`.
- The route: check `Authorization: Bearer <JOBS_SECRET>` → skip if `clock.paused` → `ensure_stream` /
  `claim_due` → `202` → work in `after()` until `deadline` → `release_lease` → one `ingest.job_runs` row.
  No child processes, nothing from `tools/gis/**`, no GDAL (lint-enforced in `src/jobs/**`).
  `/api/jobs`, `/api/realtime`, `/api/tiles`, `/api/webhooks`, `/api/oauth` must never answer 3xx
  (no `proxy.ts` yet; keep it that way when it arrives).

## 6. Realtime (`src/platform/realtime/types.ts`, `publish.ts`)

- Server: `publish(topic, event, payload, executor = getPool())` → `select app.publish($1,$2,$3::jsonb)`.
  Payloads must be JSON objects. Over `MAX_PAYLOAD_BYTES` (7 500, under pg_notify's 8 000) it sends
  `invalidate { event, reason: 'too_large' }` instead (about 23 machines fit in one tick; M0 runs ~11).
- Topics (`TopicEvents`): **`fleet`** → `tick: FleetTick`, `invalidate`; **`admin`** →
  `clock: { paused }`, `sync.status: SyncStatusPayload`, `invalidate`. Per-entity topics later use
  `name:<uuid>`. Add a topic by reporting it.
- Local transport: `LISTEN app_events`; each notification is `NotifyMessage { topic, event, payload }`
  with `payload.seq`. The SSE route (`/api/realtime`) sends `text/event-stream`,
  `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, a 15 s heartbeat, from one
  `globalThis` LISTEN connection (a dedicated `pg.Client` as farm_app, not from the pool).
- Client: `getRealtimeClient(): RealtimeClient` with
  `subscribe(topic, onEvent({ event, payload, seq }), { onResync })` → unsubscribe. One shared EventSource
  per tab. `onResync` fires after every (re)connect, on a `seq` gap and on `invalidate`; subscribers
  refetch their snapshot there (fleet: `GET /api/fleet`).

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

`fleetTickSchema` / `machineViewSchema` (zod) validate both; `isStale(ts, now, FLEET_STALE_SECONDS)` and
`normalizeHeading()` are the shared helpers. `stale` is computed on the server when the tick is built.

## 8. Connectors (`src/connectors/types.ts`)

- `Mode` = `sim` | `replay` | `sandbox` | `live` | `off` (`CONNECTOR_MODES`); `ConnectorSource` =
  `deere` | `samsara` | `motive` | `nws` | `qbo` | `bushel` | `drone`; row sources also `app`, `import`,
  `demo`, `sim`.
- Ports: `PositionSource.poll(cursor)`, `VehicleStatsSource.statsSince(cursor)` → `PollResult<T> { items, cursor, hasMore? }`
  with `NormalizedPosition` / `NormalizedVehicleStat` (wall-clock ISO `ts`).
- Sync step: `RunSyncStep = (spec: SyncStepSpec<TRaw, TNorm>, ctx: JobContext) => Promise<SyncStepResult>`,
  implemented by the vendors agent in `src/connectors/sync-step.ts`: claim → `poll` → one transaction lands
  `RawItem { externalId, payload }` rows in `ingest.raw_events` (sha256 dedupe) and advances the cursor →
  process pending events one at a time (`map` pure → `upsert(tx, item, ctx)`), 5 attempts then `dead` →
  `release_lease` → optional `afterRun` (one batched `fleet.tick`).
- Sim mode is the **live client** against `${VENDOR_SIM_URL}/<vendor>` with `SIM_CREDENTIALS` (from
  `src/sim/types.ts`); the same zod schemas validate stand-in and real responses.

## 9. Simulator and stand-in (`src/sim/types.ts`)

- **The time rule:** the world advances in **sim time**; every timestamp the stand-in reports is
  **wall-clock** time. A request at wall `w` samples `world.machineAt(id, clock.wallToSim(w))` and stamps it
  `w`. So a 30x day yields real "now" timestamps; pausing the sim freezes machines without making them
  stale; a vendor outage makes them stale without freezing sim time.
- `ScenarioName`: `harvest-day`, `winter-idle`, `planting-day`, `spray-windy`, `breakdown`, `bad-morning`.
- `SimFarm { parties, farms, fields, machines, elevators, shop, roads }` with stable ids (`demoId(key)`):
  fields carry name, MultiPolygon boundary, tenure, farm/client, landlord, county, entrance point + road
  node, Deere field/boundary ids (and `sharedWith` a second org); machines carry kind, unitNo, make, model,
  year and `vendorIds { deere?, eld? }`; elevators carry a geofence Polygon and entrance; `roads` is the
  section-line `RoadGraph`. `farm` depends only on the seed.
- `SimWorld { scenario, seed, farm, startsAt, machineAt(machineId, simTime): SimMachineSample | null }`,
  `SimMachineSample { lng, lat, heading, speedMph, activity, engineOn, engineHours, odometerMi, fuelPct, fieldId }`.
  Factories from `src/sim/index.ts`: `buildSimFarm(seed?)`, `createSimWorld({ scenario, seed? })`.
- `SimClock { wallToSim(wall), paused, speed }`; state `SimClockState { anchorWall, anchorSim, speed, paused }`,
  normative arithmetic `wallToSim(state, wall)`; every change re-anchors at the current wall time; the
  stand-in persists it in `.data/vendor-sim/state.json`. `SIM_FROZEN_AT` = `freeze` at boot.
- **Seed contract:** `scripts/seed.ts demo` writes the SimFarm into `farm.*` with id = SimFarm id,
  `source='demo'`, `source_id=key`, one current boundary per field, one `farm.geofences` row per elevator
  (kind `elevator`) and the shop (kind `shop`), plus an `ingest.external_refs` row for every vendor id
  (Deere farm/field/machine ids with `source_org` = the Deere org; ELD vehicle ids under the `ELD_VENDOR`
  source). It refuses non-local databases (`assertLocalUrl` in `src/db/admin.ts`) and is idempotent.
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
  - Webhooks go to `${PUBLIC_URL}/api/webhooks/<source>`.

---

## 10. Commands available now

| Command | Does |
|---|---|
| `pnpm install` | clean and non-interactive (`allowBuilds: esbuild`) |
| `pnpm lint` / `lint:fix` | Biome (formatter + linter + seam rules) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` / `pnpm test:db` | unit / database projects (section 2) |
| `pnpm build` / `pnpm start` / `pnpm dev:next` | Next |
| `pnpm env:init` | write `.env` + `.env.local` (idempotent) |
| `pnpm db:up` / `db:down` / `db:nuke` | container (foundation only; not for parallel agents) |
| `pnpm db:migrate` / `db:configure local` / `db:check` / `db:reset` / `db:lint` / `db:test-template` / `db:pending` | see `scripts/db.ts` header |
| `pnpm db:generate` / `db:studio` | drizzle-kit (snapshots in `db/migrations/meta` mirror `src/db/schema`) |
| `GET /api/health` | `200 { ok: true, db: true, postgis, time, dbTime }` or `503 { ok: false, db: false, … }` |
