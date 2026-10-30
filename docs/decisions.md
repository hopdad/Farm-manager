# Decisions still open, and the defaults M1 uses meanwhile

Oct 29, 2026 · for Derrick · companion to `docs/build-plan.md` §8 ("Decisions only you can make")

The build doesn't wait on these. Each default below is in force today, is easy to change, and
lives in **one** place (named here). To change one, tell us the value in plain words ("spray
no-go above 12 mph", "drivers may not mark machines down"); most are a one-line change, and the
ones marked *self-serve* you can change yourself on an admin page.

## The numbered decisions

| # | What we assumed | Where it lives | What to tell us |
|---|---|---|---|
| **D3** ELD vendor | **Samsara.** The trucks run on the simulated Samsara feed; doc-derived Samsara fixtures drive `CONNECTOR_ELD=replay`. Motive has no replay fixtures (its paths aren't confirmed), so `ELD_VENDOR=motive` + replay stops with a clear message | `ELD_VENDOR` in `.env.local` (default `samsara`); `src/connectors/samsara/`, `src/connectors/motive/` | Samsara or Motive, and the install date. Then we record real responses (`connectors:record`, 1f) |
| **D4** Spray go/no-go thresholds | **Advisory label starting points, not yours:** no-go above **10 mph** sustained wind, caution above **8**, "too calm" below **3**; no-go with gusts above **15 mph**; no-go when rain (chance ≥ **50 %** or ≥ **0.01 in**) falls in the spray hour or the next **4 h**; inversion risk (wind below **3 mph**, sky ≤ **30 %**, within **2 h** of sunrise/sunset or at night) is a caution. Every screen says *"Advisory, defaults pending Derrick's values"* until you save your own | `DEFAULT_SPRAY_THRESHOLDS` in `src/domain/weather.ts`; your values in `app.settings` key `spray.thresholds`; *self-serve* on **/admin/spray** (managers and the owner). Saving re-runs the assessment at once | Your numbers for each line above (from your labels and licence), or "keep these". v1 (2b) adds buffers to sensitive sites and product label rules |
| **D5** Soil temperature source | **Manual probe readings** typed on a phone (a driver or above), shown on the strip with their age. NWS has no soil temperature | `/m` → weather chip → *Log a soil temperature*; `farm.soil_temp_readings` | Which station or probe (MSU Enviroweather? a probe with an API?). Built in 2b |
| **D6** Boundary master | **Deere is the master** for every field that has a Deere field id: its boundary and name are read-only in the app; an edit becomes a *"change this in Ops Center"* request (kept with the drawing). Fields with no Deere id (prospects, customers not in Ops Center) can be drawn, edited, split and merged here, with lineage. File imports never touch a Deere-synced boundary. By the same rule, tile lines that come from Deere are read-only | `boundaryEditPolicy` in `src/domain/fields.ts`; `importMayUpdate` in `src/db/queries/boundaries.ts`; `farm.boundary_change_requests` | "Deere is the master" (keep), or "this database is the master" (we'd add the write-back to Ops Center in M2) |
| **D7** Parcels | **A synthetic parcel layer** (293 fictional parcels around the demo farm, owners made up) until a real file arrives. The demo seed loads it only when no county or vendor file has been imported, so it never replaces real data, and a real county or vendor file retires the synthetic parcels of its counties (`--replace` or not) | `tools/gis/fixtures/parcels/synthetic-parcels.geojson`; `gis.parcel_imports.source = 'synthetic'`; load a real file with `pnpm gis:parcels <file or ArcGIS layer URL>` | When the Lenawee (and Monroe) files arrive, or which vendor to buy. Column names are guesses until we see a real file (`--map` overrides them) |
| **D8** Roles and devices | Roles, lowest first: **viewer < driver < operator < manager < owner**. The **wall** and **cab/truck iPads are shared screens** (people tap their name and enter a PIN); **phones are personal** (a phone is enrolled *for* a person). A device on its own: wall = viewer, cab iPad = operator, truck iPad = driver. Name + PIN on a personal browser is for managers and the owner only. **You are the owner** (the one-time setup link `pnpm dev` prints). Who may do what: see the next table | `ROLES`, `ROLE_FOR`, `PIN_RULES` in `src/platform/auth/types.ts`; `DEFAULT_DEVICE_ROLE`, `PERSON_SIGN_IN_MIN_ROLE` in `src/platform/auth/policy.ts`; people and devices *self-serve* on **/admin/people** and **/admin/devices** | Who tests this winter, each person's role, which screens are shared. Any rule in the next table you want different |
| **D9** Raw GPS retention | Not applied yet (the retention job is slice 1g); the plan's default stays **90 days raw, daily tracks forever** | build-plan §8 | Keep 90 days, or another number |

### D8 in detail: who may do what (all checked on the server)

| Action | Needs at least | Where it lives |
|---|---|---|
| See the board, fields, fleet, weather, soils, parcel shapes, tile lines | viewer | `ROLE_FOR.viewPrivate` |
| Mark a machine down / back up (phone) | **driver** | `ROLE_FOR.markMachineDown` |
| Log a soil temperature | **driver** | `ROLE_FOR.enterSoilTemp` |
| Edit field notes; boundaries, seasons, contacts; draw tile lines; spray thresholds; admin pages | **manager** | `ROLE_FOR.editFieldNotes`, `editFieldData`, `editTileLines`, `editSprayThresholds`, `admin` |
| See parcel **owner names and mailing addresses** (tiles and the Parcels tab) | **manager** | `PARCEL_OWNERS_MIN_ROLE` in `src/db/queries/parcels-access.ts` |
| Add people, enroll devices | manager (owner for managers and owners) | `ROLE_FOR.managePeople`, `manageDevices`, `manageManagers` |

Two builders were asked for "operator and up" for marking machines down and logging soil
temperatures; the binding contract said **driver**, so drivers (truck drivers) can do both. If
you want only field operators and up, it is one word each in `ROLE_FOR`.

**PINs:** 4-8 digits, obvious ones refused (`1111`, `1234`, `1212`…), stored as a peppered
scrypt hash (the pepper comes from `SESSION_SECRET` in `.env.local`, so a copied database or a
`data:export` file can't be used to work PINs out); 5 wrong PINs lock that
person for 15 minutes, each further lockout in a row twice as long, up to a day; someone signed
in on a shared screen is signed out after 12 hours without use. A personal phone or computer
stays signed in 30 days (renewed while used), an enrolled screen a year (until revoked).
Enrollment codes last 1 hour and work once. (`PIN_RULES`, `SESSION_TTL_SECONDS` in
`src/platform/auth/cookies.ts`.)

**Demo people:** eight demo crew members have sign-ins with PINs derived from this install's
secret (Amy Kovach is the demo manager); `pnpm dev` and `pnpm db:seed demo` print them. Switch
them off on **/admin/people** (or `pnpm auth:demo-people --off`) before real use.

## Slice 1f defaults: live connectors and sync health (Oct 30, 2026)

Defaults the 1f build uses until you say otherwise (`docs/contracts-1f.md` §10 has the detail).
Each lives in one place, named here; the builders create the files named in *Where*.

| # | What we assumed | Where it lives | What to tell us |
|---|---|---|---|
| **1f-1** Season backfill vs. your rows | `pnpm deere:backfill --seasons=2022-2026` writes a field's crop year when it has no season for that year, or the existing one came from the demo or from Deere. It **never replaces a season you typed or imported** unless you add `--replace`; every season it skipped is listed in its report. `import:seasons` keeps its `--replace-deere` | `scripts/deere-backfill.ts`, `src/db/queries/deere-seasons.ts` | Whether Operations Center should win over your own records (then we flip the default) |
| **1f-2** Truck fault severity (Samsara) | **Critical** = the red stop lamp. **Warning** = the amber warning or protect lamp, the emissions lamp, the check-engine light, a confirmed code. **Info** = a pending code. A report with no codes and no lamps clears the truck's faults. A critical fault **never marks a truck down by itself**: it offers *"Critical fault: mark down?"* to drivers and up, which opens the usual sheet with the reason filled in | `src/connectors/samsara/` (mapper), `src/domain/fault-codes.ts` | Which codes your mechanic wants to see as critical, or "only the red lamp" (the default) |
| **1f-3** Recorded vendor answers | `pnpm connectors:record <source>` saves real answers only under `data/raw/recorded/` (never in git). `--scrub` writes a made-anonymous copy for the tests: names become stable pseudonyms, ids are hashed, coordinates are moved into the demo area, tokens are dropped, and a check proves no real id or name is left. Your farm's data is never committed. In 1f no recording is committed at all (the tests record the simulator into a temporary folder); a scrubbed recording from your PC later replaces the made-from-the-docs example it overlaps. Because its ids are hashed, it checks the code, not the demo board | `scripts/connectors-record.ts` | Nothing, unless you want recordings kept somewhere else |
| **1f-4** Deere call budget | `DEERE_DAILY_CALL_BUDGET` in `.env.local`, empty by default. Empty: the Deere jobs keep their schedule (positions every 2 minutes) and `/admin/connectors` says "limit unknown". Set: the Deere jobs plan on **80 %** of it, counting only real (sandbox or live) calls. The positions job gets 80 % minus what the other Deere jobs used the day before (never less than 10 %, never faster than every 2 minutes); the field-operations job checks fewer fields per run (the ones checked longest ago first) to fit what is left. The page shows the split and warns when the jobs other than positions alone use more than 80 % | `src/config.ts`, `src/connectors/deere/call-shares.ts`, `src/jobs/fleet-deere.ts`, `src/jobs/deere-ops.ts` | The daily limit Deere gives your app, once you have one |
| **1f-5** Deere organizations that haven't approved the app | An organization that still needs approval in Deere *Connections* (its listing carries a connections link, or it answers "forbidden") is **skipped**, never breaks the others, and shows on `/admin/connectors` with its approval link; right after you sign in to Deere, the sign-in page lists them too, each with an "Approve in Deere Connections" button that brings you back to `/admin/connectors`. Simulated organizations are kept apart from real ones, so they never show as connected once you switch to your Deere account. Customers' organizations are connected only after a data-rights agreement (plan 2a, D17): the page says so; your own organization is never blocked | `src/connectors/deere/orgs.ts`; `ingest.connector_orgs`; `/admin/connectors` | Nothing now; at 2a, which customers have signed |
| **1f-6** Deere sign-in callback | Normally `http://localhost:3000/api/oauth/deere`. If Deere won't accept localhost, set `DEERE_REDIRECT_URI` to a public HTTPS page made from `docs/deere-callback.html`, which passes the sign-in on to the PC (sign in from the PC itself, so its browser cookie matches) | `src/config.ts` (`DEERE_REDIRECT_URI`); `docs/deere-callback.html` | Whether Deere accepted the localhost address (plan Week 0); if not, where the page will live (D13) |
| **1f-7** Deere boundaries and new fields (D6) | A Deere boundary **becomes the field's current boundary** (a new version marked Deere, made only when the shape or the source changes); the boundary that was current (imported, drawn, the demo's, or an older Deere one) becomes history. Only the boundary from the organization that owns the field counts: a customer's organization that also sees the field never takes over. A field you imported with its Deere id is matched to it, never duplicated, and the sync never changes what you typed by hand (tenure, landlord, county, notes, a hidden field). A Deere field the app doesn't know yet lands in the farm with Deere's farm name (or "Home farm" when Deere has none), with tenure **"not set"** until you set it on `/admin/fields` (the map draws it grey) | `src/connectors/deere/fields/`, `src/db/queries/deere-fields.ts`; `TENURES` in `src/domain/farm.ts` | Keep, or keep your own boundaries for some fields |
| **1f-8** Which Deere organization is yours | `DEERE_HOME_ORG_ID` in `.env.local`, empty by default. Empty: the simulator and replay use their own home organization; with your Deere account, the app takes the only organization you are a member of, and if there are several, `/admin/connectors` asks you to set it. Machines come only from your organization (a customer's equipment never shows on your fleet panel); farms read from any other organization belong to that organization's customer | `src/config.ts`; `src/connectors/deere/orgs.ts` (`deereHomeOrg`) | Your organization's id once you connect, if you have more than one |

## Smaller defaults we picked (change any by telling us)

| Area | Default | Where |
|---|---|---|
| Weather in the demo | Simulated NWS (`CONNECTOR_WEATHER=sim`). Live NWS: README "Live weather" | `.env.local` |
| Demo cadence | `JOBS_DEMO_CADENCE=on` speeds the simulated feeds (trucks every 5 s, Deere 15 s, weather 30 s). It now applies per job only while that job's source is simulated or replayed; a live source keeps its real schedule (trucks 30 s, Deere 2 min, weather 30 min) | `src/jobs/registry.ts` (`connector` per job), `src/jobs/schedule.ts` |
| Weather cells | Each field's NWS grid cell is looked up once and re-checked after 30 days or when its boundary moves; switching weather source (sim / replay / live) forgets the cached cells | `GRID_LOOKUP_MAX_AGE_DAYS`, `switchGridSource` in `src/db/queries/weather.ts` |
| Weather storage | Forecast issues kept 48 h (plus the hours a stored verdict used); verdict detail 30 days (plus the last word for each field and hour) | `FORECAST_RETENTION_HOURS`, `SPRAY_DETAIL_RETENTION_DAYS` in `src/domain/weather.ts` |
| Forecast stale | A spray verdict adds *"forecast stale"* (caution), and the strip says so, when the app hasn't reached NWS for a field's forecast for **2 h**, counted from the last successful check, not from when NWS issued the forecast (live NWS often leaves a forecast unchanged for hours, so that made every hour stale). A forecast **older than 18 h** is stale anyway (NWS updates every forecast at least twice a day). Both are defaults you can change | `WEATHER_STALE_MINUTES`, `FORECAST_ISSUE_MAX_AGE_MINUTES` in `src/domain/weather.ts` |
| Field colours on the map | The current hour's verdict | `src/ui/weather/SprayFieldState.tsx` |
| Deere flags on the map | Refresh once per Deere sync run (hourly; every 45 s in the demo), not flag by flag: the sync brings them in bulk. Pins drawn on phones (2c) will refresh one at a time | `docs/contracts-1f.md` §5.2 |
| Geofence visits | A visit ends at the first fix outside, or after a 30-minute gap in fixes; each field gets an entrance geofence on the road (80 m along, stopping short of the crop) | `VISIT_MAX_GAP_SECONDS` in `src/domain/geofence.ts`; `src/sim/farm/geofences.ts` |
| Fleet animation on the map | Markers glide between fixes; while they glide the map redraws once the fastest machine on screen has moved about half a pixel (at most a second apart), not 60 times a second: same look, far less work for the wall PC's graphics | `MIN_STEP_DEVICE_PX`, `MAX_REDRAW_INTERVAL_MS` in `src/ui/map/fleet/redraw.ts` |
| Machine-down reasons | One tap: Breakdown, Flat tire, Hydraulic leak, Electrical, Engine, Scheduled service; or typed (200 characters) | `src/ui/fleet/` |
| Boundary file import | Same name overlapping ≥ 50 % = the same field; a differently named field overlapping ≥ 80 % = the same field; slivers under 0.1 ac skipped; farm "Home farm" unless the file or `--farm` says; tenure "custom" when the farm has a customer, else "owned" | `DEFAULT_MIN_NAME_OVERLAP`, `DEFAULT_MIN_SHAPE_OVERLAP`, `DEFAULT_IMPORT_FARM` in `src/db/queries/boundaries.ts` |
| Split / merge | A merge closes gaps up to 5 m; at most 10 pieces; dates are Detroit time (today = now, an earlier day = its midnight) | `MERGE_GAP_M`, `MAX_SPLIT_PIECES` in `src/db/queries/lineage.ts` |
| Soils | NCCPI = NRCS rule *"NCCPI - National Commodity Crop Productivity Index (Ver 3.0)"*, averaged over a map unit's rated components by percent; drainage class and hydrologic group from the dominant component. Until `pnpm gis:soils` has run once, a **synthetic** soils layer covers the demo farm (labelled as such) | `tools/gis/soils-sql.ts`, `tools/gis/soils-model.ts`; `tools/seed/extras.ts` |
| Aerial photos | Online: the National Map's cached imagery tiles (`USGSImageryOnly`, as plan §5 says; cached to zoom 16, enlarged above; needs the internet, says "offline" without it). Saved NAIP close-ups for your area (`exportImage`): zoom 12-17, at most 60,000 tiles, area = `data/aoi.geojson` or your fields plus 1 mile. The Michigan NAIP year and the cache's deepest zoom are unconfirmed (neither USGS host was reachable from the build machine; `--vintage`, `NAIP_ONLINE_MAXZOOM`) | `pnpm gis:naip`; `tools/gis/naip*.ts` |
| Spray verdict history | Every verdict detail kept 30 days; after that the last verdict for each field and hour is kept **forever** (about 20 MB per field per year at today's row size, so roughly 3 GB a year at 150 fields: watch it against Supabase's 8 GB disk at MD). Tell us how many years of hourly spray verdicts are worth keeping (a seasons' worth, or as long as records must be kept) | `SPRAY_DETAIL_RETENTION_DAYS` in `src/domain/weather.ts`; `pruneWeather` in `src/db/queries/weather.ts` |
| Uploads | Admin uploads (boundary zips, CSVs) up to 4 MB; bigger files through the CLIs | `next.config.ts` |
| Field panel | The Overview tab shows the last 5 seasons read-only; History edits them | `src/ui/fields/tabs/` |

## What else we need from you (not decisions, just facts)

- Your fields: an **Operations Center boundary export** (zip) and your **crop history** (the
  template `tools/import/templates/seasons.csv`, or your APH records): README "Your own data".
- Landlords and customers with phone numbers (the contacts template, or type them in on
  **/admin/parties**).
- The column names of your tile installer's drawings or Deere tile plow export.
