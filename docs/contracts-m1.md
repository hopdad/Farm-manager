# Contracts for M1 "See it" (parallel builders)

Oct 29, 2026 · written by the M1 contracts stage · companion to `docs/build-plan.md` (§6 M1, slices
1a-1d) and `docs/contracts.md` (M0; **still binding** except where this page says otherwise)

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
| **auth** | 1a `LocalAuth`: device and manager sessions, operator PIN on shared devices with lockout, roles, kiosk device session (D8), enrollment, people and device admin, `src/proxy.ts`, `pnpm pilot` + kiosk instructions | `src/platform/auth/**` except `types.ts`, `src/app/login/**`, `src/app/enroll/**`, `src/app/admin/people/**`, `src/app/admin/devices/**`, `src/proxy.ts`, `e2e/auth*.spec.ts`, `e2e/support/auth.ts` | 3101 / 4011 | `farm_dev_auth` |
| **field-panel** | 1a tap a field: boundary, acres, owner or landlord, 5 seasons, open jobs (placeholder), notes; wall side panel (72 px targets), phone bottom sheet; < 200 ms | `src/ui/fields/**` except `tabs.ts`, `tab-registry.ts` and the other builders' tab files, `src/app/api/fields/**`, `src/db/queries/fields.ts`, `e2e/field-panel*.spec.ts` | 3102 / 4012 | `farm_dev_field_panel` |
| **field-data** | 1c `import:boundaries`, `import:seasons`, landlords/customers/crew admin + CSV, `data:export` / `data:import`, boundary edit/split/merge for non-Deere fields with lineage, "change this in Ops Center" requests | `scripts/import-boundaries.ts`, `scripts/import-seasons.ts`, `scripts/data-export.ts`, `scripts/data-import.ts`, `tools/import/**` except `tools/import/tile*.ts`, `src/app/admin/parties/**`, `src/app/admin/fields/**`, `src/ui/fields/tabs/history*.tsx`, `src/db/queries/parties.ts`, `e2e/field-data*.spec.ts` | 3103 / 4013 | `farm_dev_field_data` |
| **fleet** | 1a fleet panel (moving, idle, down, stale, position-source badge), mark down with a reason from a phone, geofence enter/exit in the positions job, doc-derived replay fixtures for Deere and the ELD | `src/ui/fleet/**`, `src/app/api/machines/**`, `src/domain/geofence*.ts`, `src/jobs/geofences*.ts`, `src/connectors/*/replay*.ts`, `src/connectors/*/fixtures/**` (except `nws`), `e2e/fleet-panel*.spec.ts`, **plus (assigned here, §1.2)** `src/jobs/fleet.ts`, `src/db/queries/fleet.ts`, `src/connectors/endpoints.ts`, `src/connectors/{deere,samsara,motive}/**`, `src/connectors/doc-derived.ts` | 3104 / 4014 | `farm_dev_fleet` |
| **weather** | 1b `weather.nws` job (grid lookup cached, hourly forecast with `issued_at`, observations, sim fallback), weather strip, soil temperature entry, spray go/no-go v0, thresholds page | `src/connectors/nws/**` (its fixtures and replay too), `src/sim/vendors/nws/**`, `src/jobs/weather*.ts`, `src/domain/spray*.ts`, `src/ui/weather/**`, `src/app/api/weather/**`, `src/app/admin/spray/**`, `e2e/weather*.spec.ts` | 3105 / 4015 | `farm_dev_weather` |
| **soils** | 1c `gis:soils` (county load + per-boundary clip), soils layer, field soils tab; 1d the layer rail and `GET /api/layers` | `tools/gis/soils*.ts`, `src/ui/map/layers/soils*.ts`, `src/ui/map/rail/**`, `src/app/api/layers/**`, `src/ui/fields/tabs/soils*.tsx`, `e2e/soils*.spec.ts`, `e2e/layers*.spec.ts` | 3106 / 4016 | `farm_dev_soils` |
| **imagery** | 1d storage write side (signed PUT, 4 MB, no overwrites), NAIP online layer + AOI close-up PMTiles, parcels import (D7) + private parcels layer + parcel tab, tile-line import and draw tool | `src/platform/storage/**` **new files only** (the write side; never break the reader), `tools/gis/naip*.ts`, `tools/gis/parcels*.ts`, `tools/import/tile*.ts`, `src/ui/map/layers/{naip,parcels,tile}*.ts`, `src/ui/map/draw/**`, `src/ui/fields/tabs/parcel*.tsx`, `src/app/api/tile-lines/**`, `e2e/imagery*.spec.ts`, **plus (assigned here, §1.2)** the PUT handler in `src/app/api/storage/[bucket]/[...key]/route.ts` | 3107 / 4017 | `farm_dev_imagery` |

### 1.1 Integrator-owned (shared) files

Builders don't edit these; they list what to add in their report. Two exceptions, the **one-line
registries**: a builder may add exactly its own import line and its own entry, nothing else (the
integrator resolves the trivial merge conflicts):

- `src/ui/fields/tab-registry.ts` (`FIELD_PANEL_TABS`, §8)
- `src/ui/map/layers/registry.ts` (`LAYER_DEFS`, §7)

Everything else shared stays untouched: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
`db/migrations/**`, `src/db/schema/**`, `src/config.ts`, `src/jobs/registry.ts`,
`src/ui/board/**`, `src/app/board/**`, `src/app/m/**`, `src/ui/map/*.ts(x)` (the map shell,
`style.ts`, `WarRoomMap.tsx`), `src/app/api/tiles/**`, `src/app/api/fleet/**`,
`src/app/api/realtime/**`, `src/platform/realtime/**`, `src/sim/**` (except
`src/sim/vendors/nws/**`), `tools/vendor-sim/**`, `scripts/{bootstrap,db,env,seed}.ts`,
`tools/{dev,pilot}.ts`, `src/app/admin/connectors/**`, `src/app/admin/_*/**`, `README.md`,
`.github/**` and **every contract file** of this page:
`src/platform/auth/types.ts`, `src/domain/{weather,fields,soils,parcels,map-layers,farm}.ts`,
`src/ui/fields/tabs.ts`, `src/ui/map/layers/{types,apply,visibility,builtin,test-fixtures}.ts`,
`src/platform/storage/types.ts`, `src/connectors/replay.ts`, `src/connectors/types.ts`,
`src/platform/realtime/types.ts`, this file.

### 1.2 Existing files assigned in M1

M0 files no builder is listed for belong to the integrator, except these, which only one builder
needs and is therefore given: **fleet** gets `src/jobs/fleet.ts` (geofence detection inside the
positions step, replay wiring), `src/db/queries/fleet.ts`, `src/connectors/endpoints.ts`,
`src/connectors/{deere,samsara,motive}/**` and `src/connectors/doc-derived.ts`; **imagery** gets
the storage route's new `PUT` handler (keep `GET`/`HEAD` byte-for-byte). The **weather** builder
puts its NWS endpoint function in `src/connectors/nws/` (not `endpoints.ts`) and its
"doc-derived, confirm" entries in `src/connectors/nws/doc-derived.ts` (the integrator appends them
to the admin list).

Placeholders you replace, keeping their exports: `src/platform/auth/server.ts` and
`src/platform/auth/testing.ts` (auth: `getSession`, `requireRole`, `authErrorResponse`,
`runWithSession`, `sessionOverride`, `makeSession`), `src/sim/vendors/nws/routes.ts` (weather:
`nwsModule`).

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
  `requireRole(min)` FIRST, on the server (§4). The browser's claims count for nothing.
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
| `farm.weather_grids` (1b) | PK `id` = `'<WFO>/<x>,<y>'` (CHECKed), `wfo`, `grid_x`, `grid_y`, `stations` jsonb `WeatherStation[]` nearest first, `geom` Polygon null, `time_zone`, `looked_up_at` | the cached NWS cell |
| `farm.field_weather_grids` (1b) | PK `field_id`, `grid_id`, `point` (the point looked up), `looked_up_at` | redo when the boundary moves |
| `farm.weather_forecasts` (1b) | PK (`grid_id`, `issued_at`, `valid_at`); `temp_f`, `dewpoint_f`, `rh_pct`, `wind_mph`, `gust_mph`, `wind_dir`, `pop_pct`, `qpf_in`, `sky_pct`, `mixing_height_ft`, `transport_wind_mph`, `source` ('nws'), `fetched_at` | one row per hour per issue; `valid_at` = hour start UTC |
| `farm.weather_observations` (1b) | PK (`station_id`, `observed_at`); `geom` Point, `temp_f`, `dewpoint_f`, `rh_pct`, `wind_mph`, `gust_mph`, `wind_dir`, `precip_last_hour_in`, `source`, `fetched_at` | |
| `farm.soil_temp_readings` (1b) | `field_id` null, `observed_at`, `depth_in` (default 2), `temp_f`, `source` (manual, station, probe), `source_id`, `geom`, `entered_by`, `device_id`, `note` | |
| `farm.spray_assessments` (1b) | `field_id`, `for_hour` (whole hour, CHECK), `verdict` (go, caution, no_go), `reasons` jsonb `SprayReason[]`, `inputs` jsonb, `rules_version`, `forecast_issued_at`, `grid_id`, `assessed_at` | insert-only audit trail; unique **nulls not distinct** (field, hour, rules_version, forecast_issued_at): insert `on conflict on constraint spray_assessments_run_key do nothing` |
| `farm.field_lineage` (1c) | `parent_field_id`, `child_field_id` (≠ parent), `kind` (split, merge), `effective_on`, `note`, `created_by` | unique (parent, child) |
| `farm.boundary_change_requests` (1c) | `field_id`, `proposed_geom` MultiPolygon null, `note`, `requested_by`, `requested_at`, `resolved_at`, `resolved_by`, `resolution` (set together: CHECK) | D6: an edit attempted on a Deere field lands here |
| `gis.soil_mapunits` (1c) | PK `mukey`; `areasymbol`, `musym`, `muname`, `dominant_component`, `drainage_class`, `hydgrp`, `farmland_class`, `nccpi` (0-1), `components` jsonb `SoilComponent[]`, `survey_version`, `loaded_at` | |
| `gis.soil_polygons` (1c) | `mukey` → mapunits (cascade), `areasymbol`, `geom` MultiPolygon (valid!), `source` ('ssurgo'), `source_id` (SDA `mupolygonkey`, or `areasymbol:mukey:<sha8 of WKB>`), `loaded_at` | reloads converge on (source, source_id) |
| `gis.field_soils` (1c) | PK (`boundary_id`, `mukey`); `acres`, `pct` (0-100 of the boundary), `computed_at` | **written only by** `gis.rebuild_field_soils` |
| `farm.tile_lines` (1d) | `field_id` null, `geom` MultiLineString, `kind` (main, submain, lateral, unknown), `size_in`, `depth_ft`, `installed_on`, `origin` (installer_drawing, deere_tile_plow, manual), `installer`, `notes`, `source` (app, import, demo, deere), `source_id`, `source_ref`, `created_by` | drawn lines: source `app`, origin `manual` |
| `gis.parcel_imports` (1d) | `source` ('synthetic', a county, a vendor), `county_fips`, `received_on`, `license_note`, `file_name`, `sha256`, `feature_count`, `imported_at`, `notes` | |
| `gis.parcels` (1d) | `import_id` → imports (cascade), `county_fips`, `parcel_no` (unique together), `owner_name`, `owner_mailing`, `property_address`, `acres` (the file's), `gis_acres` (trigger, geodesic), `attrs` jsonb, `geom` MultiPolygon | **PRIVATE** (owner names). Use `parcelId()` for ids |
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
- **The placeholder until auth lands:** a request with the M0 admin cookie (`farm_admin`, never
  valid in production) is a provisional **owner** ("Admin key"); every other request is the
  provisional `ANONYMOUS_VIEWER`. So `requireRole('viewer')` passes for everyone today, and
  `requireRole('driver')`+ needs the admin cookie: in e2e, `unlockAdmin(context)` from
  `e2e/support/admin.ts`. When the auth builder's code lands, signed-out requests get 401.
- **Already guarded** (so they start enforcing the day auth lands): `/api/tiles` for private
  layers (fields, parcels, tile_lines), `/api/fleet`, `/api/realtime` (all `requireRole('viewer')`).
  The auth builder must make `/board`, `/m` and the e2e suite carry sessions (kiosk device
  session, `e2e/support/auth.ts`), replace `assertAdmin` on `/admin/*` with
  `requireRole('manager')` (or keep the admin key as a manager bootstrap on the PC: say which),
  and keep `src/proxy.ts` off `/api/tiles`, `/api/jobs`, `/api/webhooks`, `/api/oauth`,
  `/api/realtime` (never 3xx; `e2e/routes.spec.ts`).
- **Provider adapter** (auth builder implements `local.ts`; `supabase.ts` at MD):

  ```ts
  type AuthIdentity =
    | { kind: 'device'; deviceId: string; epoch: number }
    | { kind: 'person'; appUserId: string; epoch: number; deviceId: string | null };
  interface AuthProvider {
    readonly kind: 'local' | 'supabase';
    identify(cookies: CookieJar): Promise<AuthIdentity | null>;
    signInDevice(cookies, deviceId, epoch): Promise<void>;
    signInPerson(cookies, appUserId, epoch, deviceId | null): Promise<void>;
    signOut(cookies): Promise<void>;
  }
  ```
  `epoch` is the row's `session_epoch` at issue time: an identity whose epoch is below the row's
  current one is revoked. Cookies: httpOnly, `SameSite=Lax`, `Secure` = `cfg.cookieSecure`
  (follows `PUBLIC_URL`, never `NODE_ENV`), signed with `SESSION_SECRET` (jose). Sign-in must
  work over `http://<lan-ip>` under `pnpm pilot` (plan 1a done-when).
- **PIN hashing:** `node:crypto` scrypt with a per-user random salt, compared with
  `timingSafeEqual`; no dependency. Lockout state lives in the row (`failed_pins`,
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
normalized number) and `normalizeParcelNo`.

### 5.4 Weather and spray (`weather.ts`)

- NWS: `GridRef { id, wfo, x, y }`, `gridId(wfo, x, y)`, `parseGridId`, `WeatherStation`,
  `HourlyForecast` (US units; null = layer absent), `ForecastIssue { grid, issuedAt, hours }`,
  `Observation`. Ports `ForecastSource` / `SoilTempSource` are in `src/connectors/types.ts`.
- Strip view model: `WeatherStrip { builtAt, grid, issuedAt, fetchedAt, stale
  (WEATHER_STALE_MINUTES = 120), mode, now, days (today + 3, America/Detroit), hours (≤ 36, each
  with its `spray` verdict), soilTemp: SoilTempView (with ageMinutes) | null, spray counts }`.
- Go/no-go v0 (**advisory**): `SPRAY_VERDICTS` go, caution, no_go; `worstVerdict()`;
  `SprayReason { code, verdict, message, value?, threshold? }` with `SPRAY_REASON_CODES`
  (wind_high, wind_caution, wind_low, gust_high, rain_expected, inversion_risk, no_forecast,
  forecast_stale); `SprayAssessmentView`.
- **D4 thresholds (defaults pending Derrick's values):** `SprayThresholds` with
  `DEFAULT_SPRAY_THRESHOLDS` = wind no-go > 10 mph, caution > 8, too calm < 3, gusts > 15,
  rain-free 4 h (pop ≥ 50 % or qpf ≥ 0.01 in → no-go), inversion heuristic (wind < 3 mph, sky ≤
  30 %, within 2 h of sunrise/sunset or at night → caution); `sprayThresholdsSchema` (zod);
  `SPRAY_THRESHOLDS_SETTING_KEY`; `SprayThresholdsSetting { thresholds, isDefault, updatedAt,
  updatedBy }`; `parseSprayThresholdsSetting`; `sprayRulesVersion(thresholds)` =
  `'v0-<fnv8>'` (bump `SPRAY_RULES` when the rules change). The strip and the admin page say
  "advisory, defaults pending Derrick's values" while `isDefault`.

### 5.5 Map layers (`map-layers.ts`)

`MAP_LAYER_FORMATS`, `CACHE_POLICIES`, `LAYER_KEY_RE`, `LayerLegend`/`LegendItem` (+
`legendSchema`), `MapLayerRow` (+ `mapLayerRowSchema`), `ResolvedMapLayer` (+ `url`),
`MapLayersResponse`.

---

## 6. Realtime topics (`src/platform/realtime/types.ts`)

| Topic / event | Payload | Published by | Subscribers do |
|---|---|---|---|
| `fleet` / `tick` | `FleetTick` (M0) | fleet jobs | draw |
| `fleet` / `machine` | `MachineStatusPayload { machineId, status, downReason, downAt, by }` | fleet: after marking down/up (in the same transaction) | patch the machine; the next tick agrees |
| `admin` / `clock`, `sync.status` | M0 | runtime | M0 |
| `fields` / `updated` | `{ fieldId, parts: FieldPart[] }` | field-panel (notes), field-data (boundary, seasons, parties, lineage), soils (`soils` after a load: one per field or `invalidate`), weather (`spray`) | panels showing that field refetch `GET /api/fields/<id>`; maps refetch field tiles when `boundary` or `identity` |
| `weather` / `updated` | `{ gridIds, issuedAt }` | weather job | strips refetch |
| `spray` / `assessed` | `{ forHour, fieldIds, counts }` | weather job | refetch verdicts (a big farm gets `invalidate` instead: the same) |
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
  map), `fleetVisible` (the board passes `useLayerVisible('fleet', true)`), `onFieldTap(fieldId |
  null)` (machines win when both are under the finger; the board opens the field panel).

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
- **No bucket overwrites:** identical bytes at an existing key are a no-op (a retried upload);
  different bytes → `StorageConflictError`. `put()` writes a temp file and renames (atomic).
- Entry point: `getStorageWriter()` in `src/platform/storage/writer.ts` (new file);
  `getStorage()` (the reader) is unchanged. Only `src/platform/**` touches the filesystem.
- Adapter contract tests (plan §7): signed PUT accepted once and expired/forged refused, 4 MB limit,
  no overwrite in `tiles`, path guard; written so the Supabase adapter (MD) runs the same suite.

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
`<FleetPanel variant />` and the mark-down sheet; weather `<WeatherStrip variant />` and a soil
temperature entry form for `/m`; soils `<LayerRail map variant />`; imagery the draw tool
(`src/ui/map/draw/**`). To see your work on `/board` or `/m` you may add **one minimal mount**
there: one import line and one element (plus the one prop it needs, e.g. `onFieldTap`), no
layout or style changes, so the merge stays trivial; say so in your report. The integrator owns
the final layout, the 72 px wall targets, and the wiring between pieces (`onFieldTap` → panel,
`onMapReady` → rail, `useLayerVisible('fleet')` → `fleetVisible`).

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

**Jobs the integrator registers** (`src/jobs/registry.ts`): `weather.nws` (`*/30 * * * *`, with
a `demoEvery` for the sim, plan §1) from `src/jobs/weather.ts`, which also assesses spray for the
coming hours. Geofence detection is not a job: it runs inside the fleet positions step.

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
