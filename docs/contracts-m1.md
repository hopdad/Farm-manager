# Contracts for M1 "See it" (parallel builders)

Oct 29, 2026 · written by the M1 contracts stage · companion to `docs/build-plan.md` (§6 M1, slices
1a-1d) and `docs/contracts.md` (M0; **still binding** except where this page says otherwise).
Slice 1f's parallel build (Oct 30) has its own page: [`contracts-1f.md`](contracts-1f.md).

Seven builders now work in parallel, each in its own git worktree off `claude/m1-see-it`. This page
is the only agreement between them: who owns which paths, the ports and databases, the rules for
shared files, and every contract (TypeScript files in `src/` plus the SQL of migration
`0003_m1_see_it`). If a contract doesn't fit, **don't change it in place**: work around it and say
exactly what you need in your report. The integrator merges, resolves the one-line registry
conflicts, wires the shared lists and owns the final layout.

---

## 1. Who owns what

| Key | Builds (plan §6) | Owns (may create and edit) | Next / stand-in | Dev database |
|---|---|---|---|---|
| **auth** | 1a `LocalAuth`: device and manager sessions, operator PIN on shared devices with lockout, roles, kiosk device session (D8), enrollment, people and device admin, `src/proxy.ts`, sessions for the e2e suite, kiosk instructions for `pnpm pilot` | `src/platform/auth/**` except `types.ts`, `src/app/login/**`, `src/app/enroll/**`, `src/app/admin/people/**`, `src/app/admin/devices/**`, `src/proxy.ts`, `e2e/auth*.spec.ts`, `e2e/support/auth.ts` (replace the placeholder, §1.2), `e2e/global-setup.ts`, `docs/kiosk.md`, **plus (assigned here, §1.2)** `playwright.config.ts`: only its `globalSetup` and `use.storageState` | 3101 / 4011 | `farm_dev_auth` |
| **field-panel** | 1a tap a field: boundary, acres, owner or landlord, 5 seasons, open jobs (placeholder), notes; wall side panel (72 px targets), phone bottom sheet; < 200 ms | `src/ui/fields/**` except `tabs.ts`, `tab-registry.ts` and the other builders' tab files, `src/app/api/fields/**`, `src/db/queries/fields.ts`, `e2e/field-panel*.spec.ts` | 3102 / 4012 | `farm_dev_field_panel` |
| **field-data** | 1c `import:boundaries`, `import:seasons`, landlords/customers/crew admin + CSV, `data:export` / `data:import`, boundary edit/split/merge for non-Deere fields with lineage, "change this in Ops Center" requests | `scripts/import-boundaries.ts`, `scripts/import-seasons.ts`, `scripts/data-export.ts`, `scripts/data-import.ts`, `tools/import/**` except `tools/import/tile*.ts`, `src/app/admin/parties/**`, `src/app/admin/fields/**`, `src/ui/fields/tabs/history*.tsx`, `src/db/queries/parties.ts`, `src/db/queries/{boundaries,seasons,lineage}*.ts`, `e2e/field-data*.spec.ts` | 3103 / 4013 | `farm_dev_field_data` |
| **fleet** | 1a fleet panel (moving, idle, down, stale, position-source badge), mark down with a reason from a phone, geofence enter/exit in the positions job, doc-derived replay fixtures for Deere and the ELD | `src/ui/fleet/**`, `src/app/api/machines/**`, `src/domain/geofence*.ts`, `src/jobs/geofences*.ts`, `src/sim/farm/geofences*.ts` (new files, §1.2), `e2e/fleet-panel*.spec.ts`, **plus (assigned here, §1.2)** `src/jobs/fleet.ts`, `src/db/queries/fleet.ts`, `src/connectors/endpoints.ts`, `src/connectors/{deere,samsara,motive}/**` (their `replay*.ts` and `fixtures/**` included), `src/connectors/doc-derived.ts` | 3104 / 4014 | `farm_dev_fleet` |
| **weather** | 1b `weather.nws` job (grid lookup cached, hourly forecast with `issued_at`, observations, sim fallback), weather strip, soil temperature entry, spray go/no-go v0, thresholds page | `src/connectors/nws/**` (its fixtures and replay too), `src/sim/vendors/nws/**`, `src/jobs/weather*.ts`, `src/domain/spray*.ts`, `src/db/queries/weather*.ts`, `src/ui/weather/**`, `src/ui/map/layers/spray*.ts` (§7.3), `src/app/api/weather/**`, `src/app/admin/spray/**`, `e2e/weather*.spec.ts`, **plus** its one-line entry in `src/jobs/registry.ts` (§1.1) | 3105 / 4015 | `farm_dev_weather` |
| **soils** | 1c `gis:soils` (county load + per-boundary clip), soils layer, field soils tab; 1d the layer rail and `GET /api/layers` | `tools/gis/soils*.ts`, `tools/gis/fixtures/soils/**`, `src/db/queries/soils*.ts`, `src/ui/map/layers/soils*.ts`, `src/ui/map/rail/**`, `src/app/api/layers/**`, `src/ui/fields/tabs/soils*.tsx`, `e2e/soils*.spec.ts`, `e2e/layers*.spec.ts` | 3106 / 4016 | `farm_dev_soils` |
| **imagery** | 1d storage write side (signed PUT, 4 MB, no overwrites), NAIP online layer + AOI close-up PMTiles, parcels import (D7) + private parcels layer + parcel tab, tile-line import and draw tool | `src/platform/storage/**` **new files only** (the write side and the signed-GET check; never break the reader), `tools/gis/naip*.ts`, `tools/gis/parcels*.ts`, `tools/gis/fixtures/parcels/**`, `tools/import/tile*.ts`, `src/db/queries/{parcels,tile-lines}*.ts`, `src/ui/map/layers/{naip,parcels,tile}*.ts`, `src/ui/map/draw/**`, `src/ui/fields/tabs/parcel*.tsx`, `src/app/api/tile-lines/**`, `e2e/imagery*.spec.ts`, **plus (assigned here, §1.2)** in `src/app/api/storage/[bucket]/[...key]/route.ts` the PUT handler and the signed `uploads` branch of GET/HEAD | 3107 / 4017 | `farm_dev_imagery` |

### 1.1 Integrator-owned (shared) files

Builders don't edit these; they list what to add in their report. The exceptions are the
**one-line registries**: a builder may add exactly its own import line and its own entry, nothing
else (the integrator resolves the trivial merge conflicts):

- `src/ui/fields/tab-registry.ts` (`FIELD_PANEL_TABS`, §8)
- `src/ui/map/layers/registry.ts` (`LAYER_DEFS`, §7)
- `src/jobs/registry.ts` (`jobs`, §13): only weather, and exactly
  `import { runWeatherNws } from './weather';` plus the entry
  `'weather.nws': { cron: '*/30 * * * *', demoEvery: '30 seconds', run: runWeatherNws },`
  (and, because that test lists every job, the `weather.nws` row in each of the two expected lists
  of `src/jobs/registry.test.ts`). The clock and `POST /api/jobs/<name>` only run registered jobs,
  so this is what makes the job run under `pnpm dev` / `pnpm pilot` in the weather worktree.

Everything else shared stays untouched: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
`db/migrations/**`, `src/db/schema/**`, `src/config.ts`, `src/ui/board/**` (except the minimal
mount of §12), `src/app/board/**`, `src/app/m/**`, `src/ui/map/*.ts(x)` (the map shell,
`style.ts`, `WarRoomMap.tsx`), `src/app/api/tiles/**`, `src/app/api/fleet/**`,
`src/app/api/realtime/**`, `src/platform/realtime/**`, `src/sim/**` (except
`src/sim/vendors/nws/**`; fleet's new `src/sim/farm/geofences*.ts`), `tools/vendor-sim/**`,
`tools/seed/**`, `scripts/{bootstrap,db,env,seed}.ts`, `tools/{dev,pilot}.ts`,
`src/app/admin/connectors/**`, `src/app/admin/_*/**` (`guard.ts`: see §4), `src/ui/map/fleet/**`,
the M0 e2e specs and `e2e/support/{admin,map,touch}.ts`, `README.md`, `.github/**` and **every
contract file** of this page:
`src/platform/auth/types.ts`, `src/domain/{weather,fields,soils,parcels,map-layers,farm}.ts`,
`src/ui/fields/tabs.ts`, `src/ui/map/layers/{types,apply,visibility,builtin,test-fixtures}.ts`,
`src/platform/storage/types.ts`, `src/connectors/replay.ts`, `src/connectors/types.ts`,
`src/platform/realtime/types.ts`, this file.

### 1.2 Existing files assigned in M1

M0 files no builder is listed for belong to the integrator, except these, which only one builder
needs and is therefore given:

- **fleet** gets `src/jobs/fleet.ts` (geofence detection inside the positions step, replay
  wiring), `src/db/queries/fleet.ts`, `src/connectors/endpoints.ts`,
  `src/connectors/{deere,samsara,motive}/**` and `src/connectors/doc-derived.ts`. The demo seed
  has only elevator, shop and bin-site geofences; plan 1a also wants **field entrances**. Fleet
  writes them as a new pure module `src/sim/farm/geofences*.ts` (polygons around each built
  field's `entrance`, deterministic ids; not imported by `src/sim/farm/build.ts`, so the sim's
  determinism hashes don't move), builds its own geofences in its DB tests, and names in its
  report the lines the integrator adds to `tools/seed/demo.ts`.
- **imagery** gets, in the storage route, the new `PUT` handler and the `uploads` branch of
  `GET`/`HEAD` (§9): `tiles` stays byte-for-byte as it is (`e2e/storage.spec.ts`).
- **auth** gets two keys of `playwright.config.ts`: `globalSetup` and `use.storageState` (§4
  "E2E"). Nothing else in that file.

The **weather** builder puts its NWS endpoint function in `src/connectors/nws/` (not
`endpoints.ts`) and its "doc-derived, confirm" entries in `src/connectors/nws/doc-derived.ts`
(the integrator appends them to the admin list).

Placeholders you replace, keeping their exports: `src/platform/auth/server.ts` and
`src/platform/auth/testing.ts` (auth: `getSession`, `requireRole`, `authErrorResponse`,
`runWithSession`, `sessionOverride`, `makeSession`), `e2e/support/auth.ts` (auth: `signInAs`,
same signature), `src/sim/vendors/nws/routes.ts` (weather: `nwsModule`).

---

## 2. Working rules

- **Start from this commit** of `claude/m1-see-it`. Make your worktree:
  `git worktree add ../fm-<key> -b m1/<key> claude/m1-see-it`, then in it `pnpm install`
  (offline from the store is fine), copy `.env` and `.env.local` from `/home/user/Farm-manager`,
  and copy `.data/storage` (16 MB; the synthetic basemap) so your board has a basemap.
- **Your own ports and database** (§1): put the same four lines in **both**
  `.env.development.local` and `.env.production.local` of your worktree (contracts §2 explains
  why both):
  ```
  DATABASE_URL=postgres://farm_app:<FARM_APP_PASSWORD>@127.0.0.1:15432/farm_dev_<key>
  DATABASE_URL_MIGRATE=postgres://postgres:<DB_PASSWORD>@127.0.0.1:15432/farm_dev_<key>
  PUBLIC_URL=http://localhost:31xx
  VENDOR_SIM_URL=http://127.0.0.1:401x
  ```
  then `pnpm db:migrate` (creates `farm_dev_<key>`), `pnpm db:configure local`, `pnpm db:pending`,
  `pnpm db:reset` (seeds the demo farm). `pnpm test:e2e` then builds and starts `pnpm pilot` on
  your port. DB tests need none of this: every test file gets its own clone of
  `farm_test_template` (already rebuilt for 0003).
- **The shared container:** never `db:nuke`, `db:down`, `env:init`, `docker compose down`, never
  `db:reset` or `db:migrate` the `postgres` database (only this stage and the integrator migrate
  it). `pnpm db:up` is allowed if the container stopped (it only starts it). If `docker info`
  fails, start the daemon (`(setsid nohup dockerd > /tmp/claude-0/dockerd.log 2>&1 &)`), wait,
  then `pnpm db:up`.
- **Schema:** never edit `db/migrations/**` or `src/db/schema/**`. Extra schema goes in
  `db/pending/<key>.sql` (idempotent, `db/pending/README.md`); tests apply it to every clone,
  `pnpm db:pending` to your dev database. Name its Drizzle mirror in your report. 0003 should make
  this rare: say why you needed it.
- **Dependencies:** never edit `package.json` or the lockfile. Already added for M1: `shpjs`
  6.2.0 and `csv-parse` 7.0.3 (§13). Need another? Name, exact version (`npm view`), why.
- **Never edit another builder's paths.** Need something from one? Use its contract; if the
  contract lacks it, ask in your report.
- **Authorization:** every mutation (route handler or server action) and every private read calls
  `requireRole(min)` FIRST, on the server (§4). The browser's claims count for nothing. New admin
  pages (`/admin/spray`, `/admin/parties`, `/admin/fields`, `/admin/people`, `/admin/devices`)
  use `requireRole(ROLE_FOR.…)`, never `assertAdmin`/`adminUnlocked`.
- **E2E sessions:** every spec you write gets its session from
  `signInAs(context, role = 'viewer', baseURL?)` (`e2e/support/auth.ts`) before its first
  navigation: `'viewer'` for reads, the role the action needs (`ROLE_FOR`) for writes, and the
  origin when a context opens another host (a phone on the LAN address). Never call `unlockAdmin`
  directly (only M0's specs do). Today's placeholder: `'viewer'` adds nothing (the anonymous viewer,
  so "a viewer gets 403" is testable now); `'driver'` and above set the admin cookie, a
  provisional **owner**: show the role you need is enough, and test refusals of roles above
  viewer with `runWithSession` in unit/DB tests. A spec that needs a signed-out browser:
  `test.use({ storageState: { cookies: [], origins: [] } })`. These calls keep your spec green
  when the auth builder's real sessions land.
- **Windows is the target:** no bash in anything a user runs, no inline `FOO=bar`, `node:path`,
  spawn `process.execPath` + a JS entry (`src/lib/proc.ts`), never `.cmd` shims, LF endings, no
  POSIX-only signals. Windows CI runs unit tests under heavy parallelism with a 30 s timeout:
  assert invariants, not exact counts at an instant.
- **Public data hosts are blocked from the build machine** (checked Oct 29: `api.weather.gov`,
  `SDMDataAccess.sc.egov.usda.gov`, `websoilsurvey.sc.egov.usda.gov`, `imagery.nationalmap.gov`,
  `basemap.nationalmap.gov`, `build.protomaps.com` all answer 403 at the proxy). Build against a
  small, faithful fixture taken from the provider's documentation, mark it clearly, cite the doc
  URL in a comment, and make the real path the default for Derrick's PC. Never invent endpoints:
  confirm them (WebSearch/WebFetch/Context7) and cite them.
- **Quality:** production TypeScript in the existing style (read neighbouring files), tests for
  everything, `pnpm lint`, `typecheck`, `test`, `test:db`, `build` and your e2e green, and the M0
  demo (`e2e/m0-demo.spec.ts`) still passing. Commit on your branch with the attribution lines
  from the task; don't push.
- **Report:** what you built, files, how to run your demo, what the integrator must add (registry
  lines, jobs, board mounts, pending SQL, dependencies), open questions.

---

## 3. Database: migration `0003_m1_see_it`

`db/migrations/0003_m1_see_it.sql` (custom SQL, mirrored by `src/db/schema/{farm,gis}.ts`;
snapshot `meta/0003_snapshot.json`), applied to `postgres` and to `farm_test_template`. Every
statement is re-runnable. Conventions as in M0 (contracts §4): uuid PKs, `timestamptz` UTC,
EPSG:4326 + GiST, `source` + `source_id` unique for outside rows, deterministic ids
(`deterministicId(source, sourceId)`; parcels: `parcelId(county, number)`). Grants: farm_app has
SELECT/INSERT/UPDATE/DELETE on all of it, EXECUTE on `app.*`, `gis.rebuild_field_soils(uuid)` and
`gis.rebuild_all_field_soils()` (both revoked from PUBLIC).

### 3.1 Tables

| Table | Columns (beyond id / created_at / updated_at) | Notes |
|---|---|---|
| `farm.app_users` (1a) | `party_id` → parties (unique, restrict), `role` (viewer, driver, operator, manager, owner), `auth_user_id` unique null, `pin_hash`, `pin_set_at`, `failed_pins` ≥ 0, `locked_until`, `session_epoch` ≥ 0, `active`, `last_sign_in_at`, `source`, `source_id` | One sign-in per person. `auth_user_id` links Supabase Auth at the first verified sign-in (MD). Bump `session_epoch` to sign someone out everywhere |
| `farm.devices` (1a) | `kind` (wall, cab_ipad, truck_ipad, phone), `name`, `role` (viewer, driver, operator; never manager/owner: CHECK), `app_user_id` (a personal phone's owner), `auth_user_id` unique null, `enroll_code_hash` (unique when set), `enroll_expires_at`, `enrolled_at`, `session_epoch`, `last_seen_at`, `revoked_at`, `created_by`, `source`, `source_id` | Local enrollment stores only the one-time code's hash. `revoked_at` or a `session_epoch` bump kills every cookie of the device |
| `farm.machines` + | `down_at`, `down_by` → app_users | with M0's `status`, `down_reason` |
| `farm.fields` + | `notes_updated_at`, `notes_updated_by` → app_users | optimistic saves use `updated_at` (FieldNotes.version) |
| `farm.geofence_visits` (1a) | `machine_id`, `geofence_id`, `entered_at`, `exited_at` (≥ entered) | unique (machine, geofence, entered_at); **one open visit** per machine and geofence (partial unique index) |
| `farm.weather_grids` (1b) | PK `id` = `'<WFO>/<x>,<y>'` (CHECKed), `wfo`, `grid_x`, `grid_y`, `stations` jsonb `WeatherStation[]` nearest first, `geom` Polygon null, `time_zone`, `looked_up_at`, `forecast_checked_at` and `forecast_checked_issue` (migration 0006) | the cached NWS cell; `forecast_checked_at` = the job's last successful fetch of its forecast, `forecast_checked_issue` = the newest issue a fetch confirmed, never moving back to an older one NWS served again (§5.4 staleness) |
| `farm.field_weather_grids` (1b) | PK `field_id`, `grid_id`, `point` (the point looked up), `looked_up_at` | redo when the boundary moves |
| `farm.weather_forecasts` (1b) | PK (`grid_id`, `issued_at`, `valid_at`); `temp_f`, `dewpoint_f`, `rh_pct`, `wind_mph`, `gust_mph`, `wind_dir`, `pop_pct`, `qpf_in`, `sky_pct`, `mixing_height_ft`, `transport_wind_mph`, `source` ('nws'), `fetched_at` | one row per hour per issue; `valid_at` = hour start UTC. Pruned by the job (§13): issues older than 48 h go, except the hours an assessment used |
| `farm.weather_observations` (1b) | PK (`station_id`, `observed_at`); `geom` Point, `temp_f`, `dewpoint_f`, `rh_pct`, `wind_mph`, `gust_mph`, `wind_dir`, `precip_last_hour_in`, `source`, `fetched_at` | |
| `farm.soil_temp_readings` (1b) | `field_id` null, `observed_at`, `depth_in` (default 2), `temp_f`, `source` (manual, station, probe), `source_id`, `geom`, `entered_by`, `device_id`, `note` | |
| `farm.spray_assessments` (1b) | `field_id`, `for_hour` (whole hour, CHECK), `verdict` (go, caution, no_go), `reasons` jsonb `SprayReason[]`, `inputs` jsonb, `rules_version`, `forecast_issued_at`, `grid_id`, `assessed_at` | insert-only audit trail; unique **nulls not distinct** (field, hour, rules_version, forecast_issued_at): insert `on conflict on constraint spray_assessments_run_key do nothing`. Each run writes, per field, **only the current hour plus the next 12** (`sprayAssessmentHours(now)`, `SPRAY_ASSESS_AHEAD_HOURS`); `inputs` holds every forecast value the rules read (the audit never depends on forecast rows). Pruned by the job (§13) |
| `farm.field_lineage` (1c) | `parent_field_id`, `child_field_id` (≠ parent), `kind` (split, merge), `effective_on`, `note`, `created_by` | unique (parent, child) |
| `farm.boundary_change_requests` (1c) | `field_id`, `proposed_geom` MultiPolygon null, `note`, `requested_by`, `requested_at`, `resolved_at`, `resolved_by`, `resolution` (set together: CHECK) | D6: an edit attempted on a Deere field lands here |
| `gis.soil_mapunits` (1c) | PK `mukey`; `areasymbol`, `musym`, `muname`, `dominant_component`, `drainage_class`, `hydgrp`, `farmland_class`, `nccpi` (0-1), `components` jsonb `SoilComponent[]`, `survey_version`, `loaded_at` | |
| `gis.soil_polygons` (1c) | `mukey` → mapunits (cascade), `areasymbol`, `geom` MultiPolygon (valid!), `source` ('ssurgo'), `source_id` (SDA `mupolygonkey`, or `areasymbol:mukey:<sha8 of WKB>`), `loaded_at` | reloads converge on (source, source_id) |
| `gis.field_soils` (1c) | PK (`boundary_id`, `mukey`); `acres`, `pct` (0-100 of the boundary), `computed_at` | **written only by** `gis.rebuild_field_soils` |
| `farm.tile_lines` (1d) | `field_id` null, `geom` MultiLineString, `kind` (main, submain, lateral, unknown), `size_in`, `depth_ft`, `installed_on`, `origin` (installer_drawing, deere_tile_plow, manual), `installer`, `notes`, `source` (app, import, demo, deere), `source_id`, `source_ref`, `created_by` | drawn lines: source `app`, origin `manual` |
| `gis.parcel_imports` (1d) | `source` ('synthetic', a county, a vendor), `county_fips`, `received_on`, `license_note`, `file_name`, `sha256`, `feature_count`, `imported_at`, `notes` | |
| `gis.parcels` (1d) | `import_id` → imports (cascade), `county_fips`, `parcel_no` (unique together), `owner_name`, `owner_mailing`, `property_address`, `acres` (the file's), `gis_acres` (trigger, geodesic), `attrs` jsonb, `geom` MultiPolygon | **PRIVATE** (owner names). `parcel_no` is stored **normalized**: importers write `normalizeParcelNo(raw)`, upsert on (`county_fips`, `parcel_no`) and take the id from `parcelId(county_fips, parcel_no)`; features of one file that normalize to the same number become one row (geometries unioned, count logged) |
| `gis.map_layers` (1d) | PK `key` (`^[a-z][a-z0-9_]{0,62}$`), `kind` (pmtiles, mvt, xyz), `url_or_key`, `version` null, `cache_policy` (public, private), `minzoom`, `maxzoom`, `attribution`, `legend` jsonb `LayerLegend`, `source_vintage`, `built_at`, `default_visible`, `meta` jsonb | rows `fields`, `soils`, `parcels`, `tile_lines` (mvt) come with 0003; pmtiles/xyz rows are upserted by the CLIs |

### 3.2 Functions and triggers

| Object | Contract |
|---|---|
| `gis.rebuild_field_soils(boundary_id) → int` | Deletes and recomputes the boundary's `gis.field_soils` (geodesic acres per mukey, pct of the boundary); returns rows written. A GEOS failure raises a WARNING and leaves no soils instead of failing the boundary write |
| trigger `field_boundaries_rebuild_soils` | AFTER INSERT or UPDATE OF geom on `farm.field_boundaries`: a new boundary version gets its soils at once. Closing a version (`valid`) does not |
| `gis.rebuild_all_field_soils() → int` | Every boundary version; `gis:soils` calls it after a load |
| trigger `parcels_set_gis_acres` | BEFORE INSERT or UPDATE OF geom on `gis.parcels` |
| `app.mvt_fields(z,x,y)` (replaced) | M0's layer `fields` plus `client_id`, `client` (the farm's custom-work customer; absent for your own operation) |
| `app.mvt_soils(z,x,y)` | layer `soils`: `mukey`, `musym`, `muname`, `drainage_class`, `hydgrp`, `farmland_class`, `nccpi` (3 decimals); '' below z10. Public |
| `app.mvt_parcels(z,x,y)` | layer `parcels`: `id`, `county_fips`, `parcel_no`, `owner_name`, `owner_mailing`, `acres` (the file's, else geodesic; 1 decimal); '' below z12. **Private** |
| `app.mvt_tile_lines(z,x,y)` | layer `tile_lines`: `id`, `field_id`, `kind`, `origin`, `size_in`, `depth_ft`, `installed_on` (YYYY-MM-DD); '' below z12. **Private** |

All MVT functions: extent 4096, buffer 64, absent properties when null, `''` when empty, served by
`/api/tiles/<layer>/{z}/{x}/{y}` (§7.4).

### 3.3 `app.settings` keys

| Key | Value | Default (applied by `db:configure` / the test template) |
|---|---|---|
| `clock.paused` | boolean | `false` (M0) |
| `spray.thresholds` | `SprayThresholdsSetting` (§5.4) | `defaultSprayThresholdsSetting()`: `isDefault: true` |

Readers always use `parseSprayThresholdsSetting(value)`: a missing or invalid value is the
defaults. `/admin/spray` (weather) saves `{ thresholds, isDefault: false, updatedAt, updatedBy }`.

---

## 4. Auth (`src/platform/auth/types.ts`, `server.ts`, `testing.ts`)

Plan §1 "Auth": two layers, the same in both environments. The **provider** (`AUTH_PROVIDER`:
`local` now, `supabase` at MD) proves the base identity of a request, a device or a person, and
returns only OUR ids (`AuthIdentity`); nothing outside `src/platform/**` sees a provider user id.
The **operator layer** (shared devices: wall, cab and truck iPads, D8) adds the person who picked
their name and entered a PIN (`farm.app_users.pin_hash`, `PIN_RULES`: 4-8 digits, 5 failures,
15-minute lockout, 12 h idle).

```ts
const ROLES = ['viewer', 'driver', 'operator', 'manager', 'owner'] as const; // lowest first
type Role = (typeof ROLES)[number];
roleAtLeast(role, min): boolean;  roleRank(role);  isRole(x);
ROLE_FOR = { viewPrivate: 'viewer', markMachineDown: 'driver', enterSoilTemp: 'driver',
  editFieldNotes: 'manager', editFieldData: 'manager', editTileLines: 'manager',
  editSprayThresholds: 'manager', admin: 'manager', manageDevices: 'manager',
  managePeople: 'manager', manageManagers: 'owner' };

interface Session {
  kind: 'device' | 'person'; deviceId: string | null; appUserId: string | null;
  partyId: string | null; role: Role; displayName: string;
  deviceKind: DeviceKind | null;   // PIN pad on shared kinds
  provisional: boolean;            // true only for the placeholder's stand-in sessions
}
class AuthError extends Error { status: 401 | 403; required: Role | null }
getSession(): Promise<Session | null>   // server components, route handlers, server actions
requireRole(min: Role): Promise<Session> // throws AuthError(401 | 403)
authErrorResponse(e): Response | null    // route handlers: 401/403 JSON, no-store
checkRole(session, min)                  // the pure core (types.ts)
```

- **How to use it.** Route handler: `try { const s = await requireRole(ROLE_FOR.markMachineDown); … }
  catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }`. Server action: catch
  `AuthError` and return an error result (actions never throw to the client). Pass `session` into
  your query functions (`downBy: session.appUserId`) and test them with a made-up session.
- **Tests:** `runWithSession(makeSession({ role: 'driver' }), () => action(form))`; `null` =
  signed out. Only tests import `testing.ts` (`src/seams.test.ts` checks).
- **The placeholder until auth lands:** a request with the M0 admin cookie (`farm_admin`) is a
  provisional **owner** ("Admin key"); every other request is the provisional `ANONYMOUS_VIEWER`.
  So `requireRole('viewer')` passes for everyone today, and `requireRole('driver')`+ needs the
  admin cookie (in e2e: `signInAs(context, role)`, §2). When the auth builder's code lands,
  signed-out requests get 401.
- **The admin cookie (decided):** it stays. On the PC a valid `farm_admin` cookie is a
  provisional owner session that wins over any other identity on that browser (the person at the
  PC opened the link `pnpm dev` / `pnpm pilot` printed). It is never valid in production
  (`isAdminKey` is false there), so production has managers only through real sign-in. The real
  `getSession()` keeps that branch. `src/app/admin/_lib/guard.ts` stays as it is, and M0's
  `/admin/connectors` and `/admin/realtime` keep using it; after merging, the integrator moves
  `/admin/*` to `requireRole('manager')` (the admin cookie, an owner, still passes).
- **Already guarded** (they start enforcing the day auth lands): `/api/tiles` for private layers
  (fields, parcels, tile_lines), `/api/fleet`, `/api/realtime` (all `requireRole('viewer')`).
- **`src/proxy.ts` never redirects an API call.** No `/api/**` path ever gets a 3xx from the
  proxy: a signed-out API call reaches its handler and gets 401 JSON from `requireRole`
  (`e2e/routes.spec.ts` asserts no 3xx for `/api/jobs`, `/api/realtime`, `/api/tiles`,
  `/api/webhooks`, `/api/oauth`, `/api/fleet` and `/api/health`; `/api/storage` serves Range
  requests to MapLibre). Also never redirected: `/admin/unlock`, `/login`, `/enroll`,
  `/_next/**` and static files. Only a page request with no identity at all (a valid admin
  cookie counts as one) redirects, to `/login` or `/enroll`; role checks stay in the pages and
  handlers.
- **E2E (auth builder).** Once real auth lands the suite must still carry sessions, with no edits
  to the M0 specs:
  - `e2e/global-setup.ts` (set as `globalSetup` in `playwright.config.ts`) enrolls or reuses a
    **viewer kiosk device** in the app's database and writes its cookies to a storageState file
    under `.data/e2e/` (gitignored; not `test-results/`, which Playwright empties at the start
    of a run), which `use.storageState` points at. Playwright 1.64.1 (checked) applies
    `use.storageState` to every context a test or hook opens: the `page`/`context`/`request`
    fixtures and `browser.newContext()` alike. So `/board`, `/m`, `/api/fleet`, `/api/realtime`
    and the private tiles keep working in the board, fields, map-fleet, touch and m0-demo specs.
    It must also work against `E2E_BASE_URL` (same `SESSION_SECRET`, like `unlockAdmin`).
  - Cookies are per host: the M0 demo's phone opens `/m` on the LAN address, so its `openMap`
    already calls `signInAs(context, 'viewer', origin)` (added by the contracts stage; a no-op
    today).
  - `signInAs` keeps its signature and mints a real device or person session for exactly that
    role, for `baseURL`'s host. The M0 specs that call `unlockAdmin` (admin-lock, realtime,
    realtime-admin, the demo's admin context) keep passing because the admin cookie stays.
- **Kiosk instructions** (enroll the wall and the cab iPads, full-screen, operator PIN) go in
  `docs/kiosk.md`; the integrator links it from `README.md` and the `pnpm pilot` banner.
- **Provider adapter** (auth builder implements `local.ts`; `supabase.ts` at MD):

  ```ts
  type AuthIdentity =
    | { kind: 'device'; deviceId: string; epoch: number }
    | { kind: 'person'; appUserId: string; epoch: number;
        deviceId: string | null; deviceEpoch: number | null };
  interface AuthProvider {
    readonly kind: 'local' | 'supabase';
    identify(cookies: CookieJar): Promise<AuthIdentity | null>;
    signInDevice(cookies, deviceId, epoch): Promise<void>;
    signInPerson(cookies, appUserId, epoch, deviceId | null, deviceEpoch | null): Promise<void>;
    signOut(cookies): Promise<void>;
  }
  ```
  `epoch` is the row's `session_epoch` at issue time: an identity whose epoch is below the row's
  current one is revoked. A person on their enrolled phone carries both epochs, the person's
  (`epoch`) and the phone's (`deviceEpoch`, set exactly when `deviceId` is), so a new code
  redeemed on a replacement phone, or a revoke, signs the old phone out like any device
  (review fix, Oct 29: phone cookies issued before it carry no phone epoch and are refused, so
  such a phone needs one new code). Cookies: httpOnly, `SameSite=Lax`, `Secure` = `cfg.cookieSecure`
  (follows `PUBLIC_URL`, never `NODE_ENV`), signed with `SESSION_SECRET` (jose). Sign-in must
  work over `http://<lan-ip>` under `pnpm pilot` (plan 1a done-when).
- **PIN hashing:** `node:crypto` scrypt with a per-user random salt, compared with
  `timingSafeEqual`; no dependency. Review fix (Oct 29): scrypt hashes HMAC-SHA256(pepper, PIN),
  the pepper derived from `SESSION_SECRET` (`scrypt-p1$…`), so the hashes `data:export` writes
  can't be brute-forced without `.env.local`; legacy `scrypt$…` hashes verify and are rewritten
  at the next good sign-in. Lockout state lives in the row (`failed_pins`,
  `locked_until`), never in memory.

---

## 5. Domain contracts (`src/domain/*.ts`, pure TS)

### 5.1 Fields (`fields.ts`)

`FieldSummary { id, name, farmId, farmName, tenure, acres, countyFips, landlord: PartyRef | null,
customer: PartyRef | null, deereFieldId, active }`; `BoundaryInfo { id, acres, source, sourceRef,
validFrom, bbox, editable, readOnlyReason }`; `SeasonRow { cropYear, crop, variety, plantedOn,
harvestedOn, yieldBuAc, source }`; `FieldNotes { text, updatedAt, updatedByName, version }`;
`FieldDetail { field, boundary, seasons (newest first, ≤ FIELD_PANEL_SEASONS = 5), soils,
soilsSummary, parcels, openJobs: { count, placeholder: true }, notes, lineage { parents,
children }, openBoundaryRequests, spray: SprayAssessmentView | null }`.
`FIELD_PARTS` = identity, boundary, notes, seasons, soils, parcels, lineage, spray (the `parts` of
`fields/updated`). `FieldTileProperties` = the fields MVT properties.

**D6 (default):** `boundaryEditPolicy(field)`: a field with a `deere_field_id` is read-only
(`DEERE_BOUNDARY_READ_ONLY`; an attempted edit becomes a `farm.boundary_change_requests` row);
other fields may be drawn, edited, split and merged with lineage. Every boundary write checks it
on the server.

### 5.2 Soils (`soils.ts`)

`FieldSoilRow { mukey, musym, muname, dominantComponent, drainageClass, hydgrp, farmlandClass,
nccpi, acres, pct }`, `summarizeFieldSoils(rows) → { weightedNccpi (acre-weighted), coveredPct,
dominant, drainage[] }`, `SoilComponent`, `DRAINAGE_CLASSES` (driest first), `SOIL_SURVEY_AREAS`
(MI091, MI115), `SoilTileProperties`.

### 5.3 Parcels (`parcels.ts`)

`ParcelSummary`, `FieldParcelRow` (+ `overlapAcres`, `overlapPct`), `ParcelTileProperties`,
`COUNTY_FIPS` (lenawee 26091, monroe 26115), `parcelId(county, parcelNo)` (uuid v5 of the
normalized number) and `normalizeParcelNo` (idempotent). **Importers store the normalized
number**: `parcel_no = normalizeParcelNo(raw)`, upsert on (`county_fips`, `parcel_no`),
`id = parcelId(county_fips, parcel_no)`, so two spellings of one number (case, spacing) are one
row with one id; features of a file that normalize to the same number are merged into that row
(geometries unioned) before the insert, never upserted twice in one statement.

### 5.4 Weather and spray (`weather.ts`)

- NWS: `GridRef { id, wfo, x, y }`, `gridId(wfo, x, y)`, `parseGridId`, `WeatherStation`,
  `HourlyForecast` (US units; null = layer absent), `ForecastIssue { grid, issuedAt, hours }`,
  `Observation`. Ports `ForecastSource` / `SoilTempSource` are in `src/connectors/types.ts`.
- Strip view model: `WeatherStrip { builtAt, grid, issuedAt, fetchedAt (the last NWS check, else
  when the newest issue was stored), stale (no forecast, or stale as below), mode, now, days
  (today + 3, America/Detroit), hours (≤ 36, each with its `spray` verdict), soilTemp:
  SoilTempView (with ageMinutes) | null, spray counts }`.
- Go/no-go v0.1 (**advisory**): `SPRAY_VERDICTS` go, caution, no_go; `worstVerdict()`;
  `SprayReason { code, verdict, message, value?, threshold? }` with `SPRAY_REASON_CODES`
  (wind_high, wind_caution, wind_low, gust_high, rain_expected, inversion_risk, no_forecast,
  forecast_stale); `SprayAssessmentView` (with `forecastCheckedAt`: the cell's
  `forecast_checked_at` at read time when the row was built from `forecast_checked_issue`, else
  null; not stored per row).
- **Staleness** (`forecastStaleness(issuedAt, checkedAt, now)` in `spray.ts`; the rules,
  `withStaleness` and the strip all use it): a forecast is current as of the later of its issue
  time (NWS `updateTime`) and `checkedAt`, the weather.nws job's last successful fetch of the cell
  (a new issue or the same one again; live NWS often keeps one `updateTime` for hours).
  `forecast_stale` (caution) when not checked for more than `WEATHER_STALE_MINUTES` (120 min:
  "Forecast not checked with NWS for 3 h"), else when the issue is older than
  `FORECAST_ISSUE_MAX_AGE_MINUTES` (18 h: "NWS forecast is 19 h old"); one reason at most, value
  and threshold in minutes. `checkedAt` null counts from the issue time: never recorded, or the
  row's issue is not the one the last check confirmed (it was replaced, and the spray pass hasn't
  reassessed the row yet). The
  views judge it at read time both ways: they add it while NWS is unreachable and drop one a row
  stored during an outage once the same issue is confirmed again.
- **D4 thresholds (defaults pending Derrick's values):** `SprayThresholds` with
  `DEFAULT_SPRAY_THRESHOLDS` = wind no-go > 10 mph, caution > 8, too calm < 3, gusts > 15,
  rain-free 4 h (pop ≥ 50 % or qpf ≥ 0.01 in → no-go), inversion heuristic (wind < 3 mph, sky ≤
  30 %, within 2 h of sunrise/sunset or at night → caution); `sprayThresholdsSchema` (zod);
  `SPRAY_THRESHOLDS_SETTING_KEY`; `SprayThresholdsSetting { thresholds, isDefault, updatedAt,
  updatedBy }`; `parseSprayThresholdsSetting`; `sprayRulesVersion(thresholds)` =
  `'<SPRAY_RULES>-<fnv8>'`, now `'v0.1-…'` (bump `SPRAY_RULES` when the rules change). The strip and the admin page say
  "advisory, defaults pending Derrick's values" while `isDefault`.
- Stored window and retention (§13): `SPRAY_ASSESS_AHEAD_HOURS` (12) and
  `sprayAssessmentHours(now)` (the current UTC hour plus the next 12), `FORECAST_RETENTION_HOURS`
  (48), `SPRAY_DETAIL_RETENTION_DAYS` (30). Strip hours past the stored window have `spray: null`.

### 5.5 Map layers (`map-layers.ts`)

`MAP_LAYER_FORMATS`, `CACHE_POLICIES`, `LAYER_KEY_RE`, `LayerLegend`/`LegendItem` (+
`legendSchema`), `MapLayerRow` (+ `mapLayerRowSchema`), `ResolvedMapLayer` (+ `url`),
`MapLayersResponse`.

---

## 6. Realtime topics (`src/platform/realtime/types.ts`)

| Topic / event | Payload | Published by | Subscribers do |
|---|---|---|---|
| `fleet` / `tick` | `FleetTick` (M0) | fleet jobs | draw |
| `fleet` / `machine` | `MachineStatusPayload { machineId, status, downReason, downAt, by }` | fleet: after marking down/up (in the same transaction), **always followed by** `fleet` / `invalidate` `{ event: 'machine', reason: 'changed' }` in that transaction | the fleet panel patches the machine; the M0 map (`src/ui/map/fleet/feed.ts` reads only ticks) refetches `GET /api/fleet` (it carries `machines.status`) on the invalidate, so the wall shows "down" within the 2 s target, not at the next `fleet.deere` tick (15 s demo, 2 min live); the next tick agrees |
| `admin` / `clock`, `sync.status` | M0 | runtime | M0 |
| `fields` / `updated` | `{ fieldId, parts: FieldPart[] }` | field-panel (notes), field-data (boundary, seasons, parties, lineage), soils (`soils` after a load: one per field or `invalidate`), weather (`spray`) | panels showing that field refetch `GET /api/fields/<id>`; maps refetch field tiles when `boundary` or `identity` |
| `weather` / `updated` | `{ gridIds, issuedAt }` | weather job | strips refetch |
| `spray` / `assessed` | `{ forHour, fieldIds, counts }` | weather job | strips and `SprayFieldState` (§7.3) refetch verdicts (a big farm gets `invalidate` instead: the same) |
| `layers` / `updated` | `{ key, version }` | gis CLIs (after a build), parcels import, tile-line draws | the rail refetches `GET /api/layers`; maps re-add that layer |
| every topic / `invalidate` | `InvalidatePayload` | `publish()` when a payload is too big | refetch (onResync) |

`TOPICS` lists them all; subscribe with `getRealtimeClient(publicConfig.realtime)` as in M0. Keep
payloads small (ids, never rows); `publish(topic, event, payload, tx)` inside the write's
transaction. A new topic or event goes through your report.

---

## 7. Map layers (`src/ui/map/layers/`)

### 7.1 The contract (`types.ts`)

```ts
type LayerDef = MapLibreLayerDef | StyleLayerDef | ExternalLayerDef;   // discriminated on `render`
// shared: key (= gis.map_layers.key), group (LAYER_GROUPS), label, legend, kind
//   ('vector' | 'raster' | 'online'), offline, cachePolicy, defaultVisible, order
MapLibreLayerDef: { render: 'maplibre'; requiresRow; buildHint?; anchor ('below-fields' |
  'below-labels' | 'top'); minzoom; maxzoom; spec(ctx: { origin, row, flavor, variant }) → { sources, layers } }
StyleLayerDef:    { render: 'style'; styleLayerIds }   // base-style layers (fields)
ExternalLayerDef: { render: 'external' }               // drawn outside MapLibre (deck.gl fleet)
resolveLayers(defs, rows) → ResolvedLayer[] { def, row, status: 'ready' | 'missing' | 'mismatch', legend, defaultVisible }
```

- Ids: sources `layer:<key>` (or `layer:<key>:…`), layers `layer:<key>:…` (`validateSpec`).
- `LAYER_GROUPS` in rail order: fields, soils, terrain ("elevation and drainage"), imagery, tile
  ("tile maps"), parcels, fleet ("live fleet"), customers ("custom-work customers").
- A def whose row's cache policy differs is `mismatch` and is never drawn; a `requiresRow` def
  with no row is `missing` and the rail shows its `buildHint`.
- Online layers (`kind: 'online'`, `offline: false`) must show "offline" when they can't load
  (plan 1d done-when).

### 7.2 Composing on the map

- `applyLayers(map, resolved, isVisible, ctx)` (`apply.ts`): idempotent; adds/re-adds MapLibre
  defs (a new `?v=` re-adds), flips visibility of style defs, removes leftovers. Call it on every
  change and on the map's `styledata` event.
- `useLayerVisibilityStore` / `useLayerVisible(key, default)` / `isLayerVisible` (`visibility.ts`):
  one zustand store per tab, overrides only; the rail may persist them (`hydrate`).
- Built-ins (`builtin.ts`): `fieldsLayer` (style), `fleetLayer` (external),
  `customersLayer` (outline + name over the fields tiles' `client_id`/`client`).
- `WarRoomMap` props added for M1: `onMapReady(map | null)` (the rail calls `applyLayers` on that
  map; `SprayFieldState` sets feature state on it; the integrator gives both the same map),
  `fleetVisible` (the board passes `useLayerVisible('fleet', true)`), `onFieldTap(fieldId |
  null)` (machines win when both are under the finger; the board opens the field panel).
- Until the rail (soils) is merged, nothing calls `applyLayers` on a builder's own board, so
  MapLibre defs (spray, parcels, tile lines, NAIP) don't draw in their worktree: test the def as a
  unit (`spec()`, `validateSpec`, the fake map of `apply.test.ts`) and your e2e through your data
  (API responses, your components). The integrator checks the drawn layers after wiring the rail.

### 7.3 Who draws what

| key | def file (owner) | render / kind | data |
|---|---|---|---|
| `fields` | builtin | style / vector | MVT `fields` (private) |
| `fleet` | builtin | external | `/api/fleet` + realtime |
| `customers` | builtin | maplibre / vector | the fields tiles (no row) |
| `soils` | `soils*.ts` (soils) | maplibre / vector | MVT `soils` (public), row from 0003; version set by `gis:soils` |
| `parcels` | `parcels*.ts` (imagery) | maplibre / vector | MVT `parcels` (private), row from 0003 |
| `tile_lines` | `tile*.ts` (imagery) | maplibre / vector | MVT `tile_lines` (private), row from 0003 |
| `naip` | `naip*.ts` (imagery) | maplibre / online | xyz row written by `gis:naip` (USGS imagery service; confirm the URL from the plan's §5 sources) |
| `naip_aoi` | `naip*.ts` (imagery) | maplibre / raster | pmtiles row (`tiles` key `naip/aoi.<sha8>.pmtiles`) written by `gis:naip` |
| `spray` | `spray*.ts` (weather) | maplibre / vector; group `fields`, order 20, `requiresRow: false`, `cachePolicy: 'private'`, anchor `below-labels`, `defaultVisible: false` (on from the rail) | the fields tiles (no row, no source of its own) + feature state set by `SprayFieldState` |

**Spray colors (1b done-when: the wind slider flips field colors).** The `spray` def's spec adds
one layer, `layer:spray:fill` (type `fill`), on `FIELDS_SOURCE` / `FIELDS_SOURCE_LAYER`
(`src/ui/map/style.ts`; the fields source already has `promoteId: 'id'`), with
`'fill-color': ['match', ['feature-state', 'verdict'], 'go', <green>, 'caution', <amber>,
'no_go', <red>, 'rgba(0,0,0,0)']` (translucent; a field with no verdict stays clear) and a legend
marked advisory. The verdicts come from the weather client component
`src/ui/weather/SprayFieldState.tsx`, `({ map }: { map: maplibregl.Map | null })`, which renders
nothing: it loads `GET /api/weather/spray` (weather; `requireRole('viewer')`, `no-store`; field id
→ verdict for the current hour), calls `map.setFeatureState({ source: FIELDS_SOURCE, sourceLayer:
FIELDS_SOURCE_LAYER, id: fieldId }, { verdict })` for each field (and clears fields no longer
listed), refetches on `spray` / `assessed` and in `onResync`, and re-applies after a style reload
(`styledata`). Weather mounts it on `/board` with the strip (§12).

### 7.4 Tiles route and `GET /api/layers`

`/api/tiles/<layer>/{z}/{x}/{y}[?v=]` serves `fields`, `soils`, `parcels`, `tile_lines`
(`src/app/api/tiles/layers.ts`: SQL, cache policy, zooms, `version()`); private layers call
`requireRole('viewer')` first (401/403 `no-store`); a DB test keeps the registry rows and the code
equal. Versions: fields (boundaries, names, tenure, client), soils (`gis.map_layers.version` set
by the loader, else a hash of the polygons), parcels and tile lines (row count, newest
`updated_at`, id hash: **writers must bump `updated_at`**). After changing a layer's data,
publish `layers`/`updated`.

`GET /api/layers` (soils builder) → `MapLayersResponse`: every `gis.map_layers` row the session
may see (`requireRole('viewer')`), `url` resolved on the server (pmtiles via
`storage.publicUrl('tiles', key)`, mvt as `${url_or_key}/{z}/{x}/{y}?v=<version()>`, xyz as is),
`Cache-Control: no-store`, through `limitedJson`.

---

## 8. Field panel tabs (`src/ui/fields/tabs.ts`, `tab-registry.ts`)

```ts
interface FieldPanelTabProps { fieldId; detail: FieldDetail | null; variant: 'wall' | 'phone'; role: Role; onChanged(parts: FieldPart[]): void }
interface FieldPanelTab { id; label; order; Component: ComponentType<FieldPanelTabProps>; visible?(detail); minRole? }
orderTabs(tabs)   // sorted by order then id; throws on duplicate or non-slug ids
```

| Tab | id | order (`TAB_ORDER`) | Owner | File |
|---|---|---|---|---|
| Overview (boundary, acres, owner/landlord, open jobs placeholder, notes) | `overview` | 10 | field-panel | `src/ui/fields/tabs/overview.tsx` |
| History (5 seasons, lineage) | `history` | 20 | field-data | `src/ui/fields/tabs/history.tsx` |
| Soils | `soils` | 30 | soils | `src/ui/fields/tabs/soils.tsx` |
| Parcels | `parcels` | 40 | imagery | `src/ui/fields/tabs/parcels.tsx` |
| Weather / spray | `weather` | 50 | weather | `src/ui/weather/FieldWeatherTab.tsx` |

Tabs are client components that render from `detail` (everything in `FieldDetail` is loaded in one
request) and may fetch more. Test ids: `field-tab-<id>`. A tab that saves calls `onChanged`;
server code re-checks roles.

---

## 9. Storage write side (`src/platform/storage/types.ts`)

```ts
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;        // the 4 MB request limit
const MAX_UPLOAD_GRANT_SECONDS = 7200;           // Supabase signed upload URLs last 2 h
const BUCKET_RULES = { tiles: { public: true, overwrite: false }, uploads: { public: false, overwrite: false } };
interface StorageWriter extends StorageReader {
  createUploadGrant(req: { bucket, key, contentType, bytes, expiresInSeconds? }): Promise<UploadGrant>;
  createSignedReadUrl(bucket, key, expiresInSeconds): Promise<string>;
  put(bucket, key, body: Readable | Uint8Array, opts?: { contentType? }): Promise<StorageObjectInfo>;
  delete(bucket, key): Promise<boolean>;
}
UploadGrant { bucket, key, method: 'PUT', url, headers, expiresAt, maxBytes }
StorageConflictError (409), StorageTooLargeError (413)
```

- Two-step uploads only (plan §1): a route handler or action checks the session, then
  `createUploadGrant`; the browser PUTs to `grant.url` with `grant.headers`. Locally the URL is
  `/api/storage/<bucket>/<key>?…` HMAC-signed with `SESSION_SECRET` (expiry, size and content type
  inside the signature) and checked by the route's new `PUT` handler, which reads at most
  `maxBytes` (never buffers unbounded) and answers 403 (bad or expired signature), 409, 413.
- **Signed GET (private `uploads`):** `createSignedReadUrl` returns
  `/api/storage/uploads/<key>?…` signed the same way (bucket, key and expiry inside the
  signature). Imagery adds the check as a new file under `src/platform/storage/` and, in the
  route's `GET`/`HEAD`, an `uploads` branch: no signature → 404 exactly as in M0
  (`e2e/storage.spec.ts`), bad or expired → 403, valid → `serveStorageObject(request, storage,
  bucket, key, { access: 'signed' })`, which the contracts stage added to `http.ts` (Range, ETag,
  `Cache-Control: private, no-store`; tested in `http.test.ts`). The `tiles` path does not
  change.
- **No bucket overwrites:** identical bytes at an existing key are a no-op (a retried upload);
  different bytes → `StorageConflictError`. `put()` writes a temp file and renames (atomic).
- Entry point: `getStorageWriter()` in `src/platform/storage/writer.ts` (new file);
  `getStorage()` (the reader) is unchanged. Only `src/platform/**` touches the filesystem.
- Adapter contract tests (plan §7): signed PUT accepted once and expired/forged refused, signed
  GET served and expired/forged/other-key refused, 4 MB limit, no overwrite in `tiles`, path
  guard; written so the Supabase adapter (MD) runs the same suite.

---

## 10. Connector replay (`src/connectors/replay.ts`)

Replay mode (`CONNECTOR_<X>=replay`) runs the **live client** with a fixture transport:
`createReplayFetch(fixtures)` as `VendorHttpOptions.fetch` and `replayBaseUrl(source)`
(`https://replay.invalid/<source>`) as its base URL. OAuth is skipped (give the client a fixed
token). Contract details, in the file's header:

- **Layout:** `src/connectors/<source>/fixtures/doc-derived/<stream>/<nn>-<name>.json`
  (hand-written from the vendor's public API reference; `reference` cites it; unconfirmed paths
  also go in the doc-derived list) and `…/fixtures/recorded/<stream>/…` (`pnpm
  connectors:record`, 1f; scrubbed). Each file is a `ReplayFixture` (`replayFixtureSchema`);
  `src/connectors/<source>/replay.ts` imports them statically and exports
  `<source>ReplayFixtures`, recorded first.
- **Matching:** method + path (minus `basePath`) + the fixture's required query values; any host
  (the transport never touches the network); first match wins; else 404.
- **Time-shifting rule:** every RFC 3339 instant in the body (and interval starts like NWS
  `validTime`, and numbers under `epochMsKeys`) moves by `floor((now − anchor) / step) · step`
  (step = `shiftStepSeconds`, default 60 s): data stays as fresh as it was at the anchor, and
  replays within one step are byte-identical (raw-event dedupe holds). Date-only strings stay.
- Fixtures contain no real farm data. Validate each with the same zod schema as live responses
  (the connector's `schemas.ts`), plus `replayFixtureSchema`.
- Plan 1a done-when: `CONNECTOR_DEERE=replay` runs on the doc-derived fixtures (fleet: Deere
  fields, boundaries, operations with coverage, machine locations, flags; ELD positions). Weather
  ships NWS fixtures the same way for `CONNECTOR_WEATHER=replay`.

---

## 11. Stand-in extension (`src/sim/vendors`)

- `/nws` is mounted with the placeholder `nwsModule` (`src/sim/vendors/nws/routes.ts`, weather
  replaces it): api.weather.gov-shaped responses computed from the simulated world (spray-windy:
  a windy morning) under `${VENDOR_SIM_URL}/nws`.
- A module may add `control(req, ctx)`, served at `/_control/vendor/<vendor>/…` behind the same
  loopback/Origin/JSON guard. It keeps its knobs in `ctx.state.vendors[<vendor>]` (persisted in
  `.data/vendor-sim/state.json`; `ctx.persist()` after a change; cleared by reset). The spray
  demo's wind slider is `POST /_control/vendor/nws/…` (the weather builder picks the path and puts
  the slider on `/admin/spray`).

---

## 12. Board and phone composition

Each builder exposes **self-contained components** (data loading included) and never edits the
board or phone layout: field-panel `<FieldPanel fieldId variant onClose />`; fleet
`<FleetPanel variant />` and the mark-down sheet; weather `<WeatherStrip variant />`,
`<SprayFieldState map />` (§7.3) and a soil temperature entry form for `/m`; soils
`<LayerRail map variant />`; imagery the draw tool (`src/ui/map/draw/**`). To see your work on
`/board` or `/m` you may add **one minimal mount** there (`src/ui/board/BoardScreen.tsx`): one
import line and one element (plus the one prop it needs, e.g. `onFieldTap`), no layout or style
changes, so the merge stays trivial; say so in your report. A component that needs the map
(weather's `SprayFieldState`, soils' `LayerRail`) also adds
`const [map, setMap] = useState<maplibregl.Map | null>(null)` and `onMapReady={setMap}` on
`WarRoomMap`; weather's mount is the strip plus `<SprayFieldState map={map} />`. The integrator
owns the final layout, the 72 px wall targets, and the wiring between pieces (`onFieldTap` →
panel, one `onMapReady` map shared by the rail and `SprayFieldState`, `useLayerVisible('fleet')`
→ `fleetVisible`).

---

## 13. Scripts, dependencies, jobs

**npm scripts reserved** (they fail until the owner creates the file):

| Script | Entry | Owner |
|---|---|---|
| `import:boundaries <file>` | `scripts/import-boundaries.ts` | field-data |
| `import:seasons <csv>` | `scripts/import-seasons.ts` | field-data |
| `data:export` / `data:import [--target]` | `scripts/data-export.ts` / `scripts/data-import.ts` | field-data |
| `gis:soils` | `tools/gis/soils.ts` | soils |
| `gis:naip` | `tools/gis/naip.ts` | imagery |
| `gis:parcels <file>` | `tools/gis/parcels.ts` | imagery |
| `import:tile <file>` | `tools/import/tile.ts` | imagery |

**Dependencies added** (exact, verified with `npm view`, both pure JS, no build scripts):
`shpjs` 6.2.0 (shapefile or zipped shapefile → GeoJSON in WGS84, reprojecting with the `.prj`
through proj4; types in `src/types/shpjs.d.ts`) and `csv-parse` 7.0.3 (`csv-parse/sync`; BOM,
quoted commas). Examples: `src/lib/third-party.test.ts`. GeoPackage and ArcGIS FeatureServer
inputs go through GDAL in Docker (`ghcr.io/osgeo/gdal:ubuntu-small-3.13.3`, `ogr2ogr` to GeoJSON),
like the other `gis:*` steps: no npm reader. PIN hashing uses `node:crypto` scrypt. Raster
PMTiles: `tools/gis/pmtiles-writer.ts` now has `PmTileType.Jpeg/Webp/Avif`.

**Jobs** (`src/jobs/registry.ts`; weather adds its own line, §1.1): `weather.nws`
(`cron: '*/30 * * * *'`, `demoEvery: '30 seconds'` for the sim, plan §1) from
`src/jobs/weather.ts`. Each run: grid lookups (cached), the newest forecast issue (when the
forecast step succeeds, every cell NWS answered for whose served issue is stored, a new issue or
the same one again, gets `farm.weather_grids.forecast_checked_at` = the run's time and
`forecast_checked_issue` = that issue (never an older one), written with the spray pass's rows in
its transaction: staleness counts from it for rows built from that issue,
§5.4; a failed or unclaimed step marks nothing, a partial one only the cells that answered) and the
observations, then the spray assessment of **each field's current hour plus the next 12**
(`sprayAssessmentHours(now)`: 13 rows per field per new forecast issue or rules version; up to
about 12k rows a day for the 40 demo fields, 150k at 500 fields), then pruning, at most once an hour (when
the run's hour changes), in batches (e.g. 5 000 rows per statement) so the run stays in its
budget:

- `farm.weather_forecasts`: delete rows with `issued_at` older than `FORECAST_RETENTION_HOURS`
  (48 h), except the rows a stored assessment used: `not exists (select 1 from
  farm.spray_assessments s where s.grid_id = f.grid_id and s.forecast_issued_at = f.issued_at and
  s.for_hour = f.valid_at)`. That keeps about two days of issues plus, for each assessed hour,
  only the forecast rows its kept assessments used.
- `farm.spray_assessments`: delete rows with `for_hour` older than `SPRAY_DETAIL_RETENTION_DAYS`
  (30 days), except the newest per (`field_id`, `for_hour`) (by `assessed_at`, then `id`; the
  index `spray_assessments_field_id_for_hour_idx` serves it): what the farm was told last.

Check both with `EXPLAIN` on a 500-field fixture; if the forecast anti-join needs an index, add
`farm.spray_assessments (grid_id, forecast_issued_at, for_hour)` through `db/pending/weather.sql`.
The constants live in `src/domain/weather.ts` (easy to shorten if the 8 GB of Supabase Pro gets
tight). Geofence detection is not a job: it runs inside the fleet positions step.

**Data export/import (field-data):** rows with `source` `demo` or `sim` are never exported; ids of
synced rows are deterministic, so hand-entered rows that reference them survive
`data:export → db:reset → re-sync → data:import` (plan 1c done-when).

---

## 14. Decisions still open (defaults in force; easy to change)

| # | Default used | Where it lives |
|---|---|---|
| D4 | Spray thresholds above, **advisory, defaults pending Derrick's values** | `DEFAULT_SPRAY_THRESHOLDS`, `app.settings` `spray.thresholds`, `/admin/spray` |
| D6 | Deere is the boundary master for any field with `deere_field_id` (read-only in the app) | `boundaryEditPolicy`, `farm.boundary_change_requests` |
| D7 | Parcels: a synthetic fixture until a county or vendor file arrives | `gis:parcels`, `gis.parcel_imports.source = 'synthetic'` |
| D8 | Roles owner/manager/operator/driver/viewer; the wall and cab/truck iPads are shared devices (operator PIN), phones are personal | `ROLES`, `SHARED_DEVICE_KINDS`, `farm.devices.role` |

---

## 15. As integrated (Oct 29, 2026)

The seven builder branches are merged into `claude/m1-see-it`; the worktrees and `m1/*` branches
are gone. What the integration settled, where the builders' reports asked:

- **Schema:** `db/pending/weather.sql` and `db/pending/imagery.sql` are migration
  `0004_m1_integration` (the retention index on `farm.spray_assessments (grid_id,
  forecast_issued_at, for_hour)`, mirrored in `src/db/schema/farm.ts`, and
  `app.mvt_parcels(z, x, y, with_owners)`). `db/pending/` holds only its README again.
- **Auth (§4):** `/admin/*` uses `requireRole(ROLE_FOR.admin)` through `src/app/admin/_lib/guard.ts`
  (the admin cookie is still a provisional owner on the PC); `/board` and `/m` call
  `requirePageSession`; starting the Deere connect flow outside sim needs a manager. The
  launchers and bootstrap print `authBannerLines`; the demo seed adds the demo people.
- **Roles kept as contracted:** `markMachineDown` and `enterSoilTemp` stay `driver` (two tasks
  said operator; `docs/decisions.md` D8 says how to change it).
- **Parcels (§3.2, §5.3, §7.4):** the tiles route picks the owners variant by the session's role
  (`TileLayerDef.sqlForRole`), and `GET /api/layers` gives that variant its own `?v=` suffix
  (`.o`), so a shared browser never reuses one person's owner tiles for the next.
  `GET /api/fields/<id>` redacts `parcels[].ownerName/ownerMailing` below manager on the server.
- **`GET /api/layers`:** as built by soils: public rows for everyone (also signed out), private
  rows from `viewPrivate`; never a 401. MVT rows carry the tiles route's version.
- **Field panel (§8, §12):** tabs in order Overview, History, Soils, Parcels, Spray. The panel
  takes `config` and `map` besides `fieldId`/`variant`/`onClose`, and `GET /api/fields/<id>`
  names the session's role in `X-Farm-Role`. A notes save bumps `fields.updated_at`, which moves
  the fields tiles' `?v=` (new page loads only).
- **Board layout (§12):** `src/ui/board/BoardScreen.tsx` composes everything around one map;
  panels read `--dock-right/left/bottom/gap` from `.mapArea`. Field taps are ignored while a tile
  line is drawn; the rail's fleet toggle drives `fleetVisible`. WarRoomMap only runs deck.gl's
  GPU pick when a machine is drawn near the tap (`src/ui/map/fleet/pick.ts`), and paces the
  gliding fleet's frames (`src/ui/map/fleet/redraw.ts`): every deck frame repaints the whole map,
  so while machines glide it redraws once the fastest machine on screen has moved or turned about
  half a device pixel (at most a second apart), instead of every animation frame. New fixes,
  selection and the fleet toggle still draw on the next frame; `window.__map.fleet()` returns
  the frame last drawn.
- **Jobs (§13):** a job may name its `connector`; `JOBS_DEMO_CADENCE` applies only while that
  connector is sim, replay or off, and the config no longer refuses it next to a live connector.
  `weather.nws` drops its cached grid cells when the weather source changes
  (`app.settings` `weather.grid_source`).
- **Spray assessments (§3.1):** `writeAssessments` uses `on conflict … do update set assessed_at`
  only when a newer row for that field and hour exists (weather's report): "newest by
  assessed_at" is what the farm was last told. Staleness (`forecast_stale`) is added at read time
  (since migration 0006 counted from the last NWS check, §5.4).
- **Replay (§10):** two fixtures stretch "anchor = the instant treated as now" so machines move:
  the Deere breadcrumbs anchor at the start of a 30-minute period (`shiftStepSeconds` 1800) and
  the Samsara positions are a closed loop of 120 cursor-keyed pages (`shiftStepSeconds` 1). The
  Deere stand-in now sends breadcrumbs in the documented shapes too.
- **Data export (§13):** who-did-it columns (`entered_by`, `created_by`, `down_by`, …) are declared
  per table; a link to a person or device the target database doesn't have is imported as null
  with a note instead of failing the import. `farm.app_users` and `farm.devices` with source
  `app` travel in the file (never the enrollment code hash).
- **Shared helpers:** one `isSameOriginRequest` (`src/platform/http/origin.ts`), also on tile-line
  writes; server actions accept 4 MB bodies (`next.config.ts`).
- **Seed:** `tools/seed/extras.ts` (demo people, soils from a cached SSURGO run or the synthetic
  fixture, synthetic parcels unless a real file was imported, the online NAIP row) after the
  demo farm, which now has one field-entrance geofence per field.

### 15.1 Review fixes (Oct 29, 2026)

What the review of the integrated build changed in these contracts:

- **Auth (§4):** a person identity on their enrolled phone carries the phone's epoch
  (`deviceEpoch`, claim `dep`); `signInPerson(cookies, appUserId, epoch, deviceId, deviceEpoch)`.
  PIN hashes are peppered from `SESSION_SECRET` (`scrypt-p1$…`; legacy hashes rewritten at the
  next good sign-in). Switch user returns a shared device to its home (`/board`, `/m`).
- **Tiles (§7.4):** migration `0005_m1_review`: `app.mvt_fields` adds layer `fields_label`, one
  point per field (id, name, acres, tenure, client); field names and customer names are labelled
  from it. A role-dependent layer's URL whose `?v=` names the other variant is served
  `private, no-store`.
- **Layers (§7.1, §6):** `StyleLayerDef.styleSourceId` names a base-style source the row's URL
  re-points (setTiles); the rail's feed reloads `GET /api/layers` on `fields/updated` with
  `boundary` or `identity`, so open maps follow imports and edits. The `fields` and `fleet`
  built-ins carry legends; panels on the board mark themselves `data-dock` for the map's fit.
- **Weather (§5.4):** the strip's spray counts and hour dots and `FieldDetail.spray` apply
  `withStaleness` at read time, like the map.
- **Data export (§13):** the demo crew's sign-ins travel as an overlay (switched off, role,
  epoch, a PIN changed in the app); the demo seed writes `landlord_party_id` and
  `client_party_id` on insert only.
- **Imports (§13):** zips are unpacked under limits (`tools/import/zip-vectors.ts`), a `.dbf`
  without a `.cpg` and a CSV that isn't UTF-8 are read as Windows-1252; `gis:parcels` and
  `import:tile` read File Geodatabases through GDAL; a real parcel file retires the synthetic
  parcels of its counties.
- **NAIP (§9, plan §5):** the online `naip` row reads the cached `USGSImageryOnly` tiles
  (z11-16); `exportImage` serves the AOI close-ups only.
