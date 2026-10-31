# Farm Ops

Farm Ops is the operations software described in [`farm-ops-software-spec.md`](farm-ops-software-spec.md):
one database keyed on fields, machines and jobs, fed by John Deere Operations Center, the trucks'
and machines' telematics (Samsara, Motive, MyGeotab, Terminal, CNH FieldOps and the standard
ISO 15143-3 "AEMP" feed for other brands) and public data, and shown on a touch "war-room" map on
the shop wall and on phones. Until it is solid it runs entirely on your Windows PC with Docker
Desktop: Next.js on Node, Supabase's own Postgres image in Docker, and a local **vendor
stand-in** that answers like each of those vendors and the National Weather Service for one
simulated farm (40 fields around Adrian and Blissfield, a mixed fleet of Deere, Case IH, Kubota
and RoGator machines, the farm's semis and pickups, three hired haulers' trucks, 3 elevators), so
the real connector code runs without any vendor account.

The plan is [`docs/build-plan.md`](docs/build-plan.md); the code-level agreements are
[`docs/contracts.md`](docs/contracts.md) (M0) and [`docs/contracts-m1.md`](docs/contracts-m1.md)
(M1). The defaults in force for the decisions only you can make (spray thresholds, roles, the
boundary master, parcels…) are in [`docs/decisions.md`](docs/decisions.md). Sign-in, the wall
kiosk and the cab iPads: [`docs/kiosk.md`](docs/kiosk.md).

This is milestone **M1 "See it"**, slices 1a-1d: tap a field, the fleet panel and sign-in (1a),
the weather strip with an advisory spray go/no-go (1b), your own fields, people, crop history and
soils (1c), and imagery, parcels, tile maps and the layer rail (1d); plus slice **1f** (live
connectors and sync health: Deere fields, flags, machines and this season's operations, fault
codes, `/admin/connectors`) and **1f.2** (every telematics vendor at once, pickups). The 1f
agreements are [`docs/contracts-1f.md`](docs/contracts-1f.md).

**After pulling slice 1f:** `pnpm run bootstrap` (or `pnpm db:migrate`), then
`pnpm db:seed demo` once (the mixed fleet's machines and vendor links land in your database;
H1's Motive link moves under its hauler's company), then `pnpm dev` as usual.

**Working on the PC with a coding agent?** Point it at [`PC-AGENT.md`](PC-AGENT.md): how to launch the demo, what to verify on Windows, and the building that has to happen on the PC.

## What's new in M1

- **Sign-in (1a).** You become the owner with a one-time link; managers sign in with their name
  and a PIN; the wall and cab/truck iPads are enrolled once and people switch on them with a PIN;
  a crew member's phone is enrolled for that person. Admin pages need a manager. Details:
  [`docs/kiosk.md`](docs/kiosk.md).
- **Tap a field (1a).** Its panel opens beside the map on the wall and as a bottom sheet on a
  phone: acres, tenure, landlord or customer with tap-to-call, notes (managers edit), the last 5
  seasons, and tabs for **History**, **Soils**, **Parcels** and **Spray**.
- **Fleet panel (1a).** Every machine grouped moving / idle / down / stale, with where its
  position comes from (ELD, Deere, cab) and how old it is. A driver or above marks a machine
  **down** with a reason from a phone; the wall shows it within 2 seconds. Machines entering and
  leaving elevators, the shop and field entrances are recorded (geofences).
- **Weather strip and spray go/no-go (1b).** Now, today and 3 days (rain, wind, gusts,
  temperature), the next 12 hours with a spray dot each, and soil temperature from phone
  readings. Every field gets an **advisory** go / caution / no-go with its reasons; turn on
  *Spray go/no-go* in the layer rail to colour the fields. Thresholds: **/admin/spray**.
- **Your own data (1c).** Import your Operations Center boundaries and crop history, add
  landlords, customers and crew (forms or CSV), draw, split and merge fields that aren't in Ops
  Center, real SSURGO soils with NCCPI, and back everything up with `pnpm data:export`.
- **Layers (1d).** A rail down the left side: fields, spray, soils, aerial photos (online, or
  saved for your area), drainage tile, parcels (owners for managers only), the live fleet and
  custom-work customers. Managers draw tile lines with the **Tile** tool.

## What's new in slice 1f (live connectors) and 1f.2 (every vendor)

- **Deere fields, flags and machines.** The `deere.fields` job reads your Deere farms, fields,
  boundaries, flags and equipment (hourly; every 45 s in the demo). Each field gets its owning
  org's Deere boundary as the current version (the old one is kept as history), a field Deere
  has that the app doesn't lands with tenure "not set" (drawn grey; the demo has one, *New
  Ground 80*), flags show as read-only pins (the **Deere flags** toggle in the layer rail; tap one
  for its popup), and machines get their engine hours.
- **This season's operations.** A field's **History** tab lists this crop year's planting,
  spraying and harvest from Operations Center: acres (and the part inside the field), yield,
  products and rates, machines and operator, coverage mapped or not, and whether Deere may still
  change it.
- **Fault codes and stats on the fleet panel.** Each row shows where its position comes from
  ("Samsara · sim", "Kubota (AEMP) · sim", "John Deere · replay"), its kind (and "set by hand"),
  engine hours, odometer, fuel and DEF ("not reported" where the vendor's route doesn't send
  one), and its worst active fault code. A critical code offers drivers **"Critical fault: mark
  down?"**; it never marks a machine down by itself. A Deere machine that stopped working shows
  its **last working position** instead of a stale alarm.
- **Every vendor at once.** Samsara, Motive, MyGeotab and Terminal for trucks; John Deere, CNH
  FieldOps and the standard ISO 15143-3 feed (Kubota, Trackunit, Deere's and Samsara's) for
  machines; Samsara's asset gateways for machines with no API; Ford and Ram pickups through
  Samsara's carmaker links. Each has its own setting (below); all run together.
- **`/admin/connectors`** (manager): calls per vendor today and yesterday, the Deere call budget,
  the Deere sign-in and its scopes, each Deere organization's approval, dead letters (requeue or
  discard), every connection's mode and what it can report (the capability matrix), the
  assumptions still to confirm against a real account, and in sim the knobs (make an org need
  approval, give a truck a critical code). **`/admin/vehicles`** (manager): set a vehicle's kind
  (semi, pickup, service truck) by hand; vendor tags never change it after that.

## Windows quickstart

### Prerequisites (one time)

| Item | What to do |
|---|---|
| PowerShell | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once (the default policy blocks `pnpm.ps1`). Windows PowerShell 5.1 has no `&&`, so the commands below are one per line. |
| Git + GitHub sign-in | `winget install Git.Git GitHub.cli`, then `gh auth login` (the repository is private). |
| Node **24** | The Node 24 MSI (`node-v24.x.x-x64.msi`) from <https://nodejs.org/dist/latest-v24.x/>, or `winget install --id OpenJS.NodeJS.LTS --version 24.22.1 --exact`. **Not** the "LTS" button: that is Node 26 now, and the install refuses any Node but 24. |
| pnpm 12 | `npm i -g pnpm@12` (pnpm then switches itself to the exact version this repo pins). |
| Docker Desktop | Already installed. Check *Settings → General → Use the WSL 2 based engine* is on, and that Docker Desktop is **running** before `bootstrap`. |
| Chrome | For the wall display and phones. `pnpm exec playwright install chromium` once if you want to run the end-to-end tests. |
| Disk | About 15 GB free (Docker's WSL disk grows and doesn't shrink on its own). |
| Where to clone | `C:\dev\farm-manager` (a Dev Drive is ideal). **Never under OneDrive** (Desktop and Documents are often synced): synced folders lock `node_modules` and `.next`. |

### Commands

```powershell
# PowerShell, one command per line
git clone https://github.com/hopdad/Farm-manager.git C:\dev\farm-manager
cd C:\dev\farm-manager
pnpm install
pnpm run bootstrap   # one time, safe to re-run (`setup` is a built-in pnpm command, so it isn't named that)
pnpm dev             # app + clock + vendor stand-in -> http://localhost:3000/board
```

`pnpm run bootstrap` checks Node, Docker, the ports and the folder; writes `.env` (database
password and port) and `.env.local` (app secrets and URLs, plus the demo tuning); starts the
database (the first boot takes 1-3 minutes); migrates; seeds the demo farm (with its crew's
sign-ins, a synthetic soils layer and synthetic parcels); downloads the offline basemap (a
Protomaps extract of SE Michigan plus its fonts and sprites); connects the simulated Deere
account; and prints the board, sign-in and phone URLs. It only does what's missing.

**Coming from M0:** `git checkout main`, `git pull`, `pnpm install`,
`pnpm run bootstrap`. It applies the new migrations (`0003`-`0006`) and its demo seed adds
the M1 extras to the demo farm you already have (demo sign-ins, soils, parcels, field
entrances), keeping everything else. No `pnpm db:reset` needed (it would wipe what you typed
in). Then sign in and enroll the wall once: "First run" below (the M0 kiosk now lands on the
sign-in page until it is enrolled).

## First run: sign in

1. `pnpm dev` prints an **Owner** link the first time:
   `http://localhost:3000/login/setup?code=…`. Open it **on the PC**, enter your name and a PIN
   only you know: you are the owner. After that `pnpm dev` prints where to sign in instead.
2. **The wall display (this PC):** on **/admin/devices** add a device of kind *Wall display*.
   The kiosk is a Chrome with its own profile on `localhost`, and a sign-in belongs to one
   profile and one address, so don't click the panel's link or scan its QR code (those are for
   other screens). Instead, once, close the kiosk if it is running (Alt+F4), then paste the
   panel's **On this PC (wall kiosk)** command into PowerShell; it opens the kiosk's profile on
   the code over `localhost` (your code in place of `K7QD2M9XPA`):

   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --no-first-run "--user-data-dir=$env:LOCALAPPDATA\farm-kiosk" "http://localhost:3000/enroll?code=K7QD2M9XPA"
   ```

   Press **Enroll as** *(the wall's name)*: the board opens; close that window. From then on
   start the wall with:

   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --no-first-run --force-device-scale-factor=2 "--user-data-dir=$env:LOCALAPPDATA\farm-kiosk" http://localhost:3000/board
   ```

   (The board is laid out for 1920 x 1080 CSS px: `2` for a 4K panel, `1` for a 1080p one.
   Alt+F4 leaves kiosk mode.) Anyone at the wall taps the name chip (top right) to sign in
   with their PIN.
3. **Cab iPads, truck iPads, crew phones:** the same page; a phone is added *for* a person and
   signs in as them. Step by step: [`docs/kiosk.md`](docs/kiosk.md).
4. **Demo PINs.** The eight demo crew members have sign-ins (Amy Kovach is the demo manager).
   Their PINs are made from this install's secret, so they are not in the repo: `pnpm dev`,
   `pnpm db:seed demo` and `pnpm auth:links` print them. Switch them off before real use
   (**/admin/people**, or `pnpm auth:demo-people --off`).
5. On the PC only, the **Admin** link `pnpm dev` prints still opens the admin pages as the
   owner without a PIN (handy for the demo; never valid in production).

Forgot the owner PIN: `pnpm auth:reset-owner` prints a one-time reset link (30 minutes).

## Daily commands

| Command | Does |
|---|---|
| `pnpm dev` | The vendor stand-in, `next dev` on all addresses (phones on the Wi-Fi can reach it) and the job clock. Each start begins the simulated harvest day afresh at 8:30 a.m. Prints the board, sign-in, demo PINs, admin and phone URLs and where the data comes from. Ctrl+C stops everything. |
| `pnpm dev --scenario=spray-windy --speed=30` | Another scenario (`harvest-day`, `planting-day`, `spray-windy`, `breakdown`, `bad-morning`, `winter-idle`); `--speed=30` runs a farm day in about 30 minutes. `--from-start`, `--resume`, `--no-clock`, `--port=<n>` as before. |
| `pnpm pilot` | The production build (`next build` + `next start`) with the same stand-in and clock: the wall display and phones. The first build can take about 10 minutes on a laptop, with a long quiet stretch before "Compiled"; later builds are much faster. `--skip-build` reuses the last build. |
| `pnpm clock` | The job clock on its own. Its pause toggle is on `/admin/connectors`. |
| `pnpm run bootstrap` | Re-run after `git pull`: new migrations, missing env keys, the basemap. |
| `pnpm db:reset` | Rebuild the app schemas and re-seed the demo farm. **Run `pnpm data:export` first** once real data exists. |
| `pnpm data:export [--out file.json]` | Everything typed in or imported (fields, boundaries, seasons, contacts, people, devices, notes, tile lines, your spray thresholds) to `.data/exports/farm-data-<time>.json`. |
| `pnpm data:import <file.json> [--dry-run]` | Put an export back (after a reset, or on a new PC). All or nothing; running it twice changes nothing. |
| `pnpm auth:links` / `auth:reset-owner` / `auth:demo-people [--off]` | Print the sign-in links and demo PINs / a one-time owner reset link / add the demo crew's sign-ins (`--off` switches them off; a manager switches one back on at **/admin/people**). |
| `pnpm db:nuke` | Delete the local database volume and start clean (re-runs the image's init). |
| `pnpm db:down` / `pnpm db:up` | Stop / start the database container; data stays. |
| `pnpm gis:basemap` | Fetch or refresh the offline basemap (`--refresh` for the newest build). |
| `pnpm sim:scenario harvest-day --speed 60 --assert` | Run a scenario day headless and check it. |
| `pnpm test` / `pnpm test:db` / `pnpm test:e2e` | Unit tests / database tests / Playwright (starts `pnpm pilot` itself, or uses the app already on port 3000). The e2e suite adds switched-off "E2E …" people and devices to your dev database; they can't sign in between runs. |
| `pnpm db:seed demo` | Re-seed the demo farm into an existing database without a reset (after pulling a slice that changes the demo fleet). |
| `pnpm vendor-sim:connect` | Connect (or check) every connector that runs in sim against the stand-in; bootstrap runs it. |
| `pnpm connectors:record deere --scrub` | With a real Deere account (sandbox): record each endpoint the app calls into `data\raw\recorded` (never committed) and, with `--scrub`, an anonymized copy for the tests. Review a scrubbed file before adding it to `src/connectors/deere/replay-recorded.ts`. `samsara` works the same way. |
| `pnpm test:live` | The live checks against real vendor accounts (sandbox); each suite skips and says why when its credentials aren't set. Never in CI. |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | What CI runs. |

## Your own data

Everything below writes to your PC's database only. Real farm data is never committed.

| What | How |
|---|---|
| **Field boundaries** from Operations Center | Export the boundary shapefile from Ops Center (a .zip), then `pnpm import:boundaries C:\path\export.zip --dry-run` to see what it would do, and again without `--dry-run`. Also takes a .shp (with its .dbf/.prj next to it) or GeoJSON. Options: `--farm "Name"`, `--tenure owned\|cash_rent\|share\|custom`, `--county 26091\|26115`, `--hide-demo` (switches the demo fields off; **/admin/fields → Show demo fields** switches them back on, and **Hide demo fields** off again), `--name-attr COL` if it picks the wrong column. Fields with a Deere id stay read-only in the app (D6). Or upload the file on **/admin/fields** (up to 4 MB). |
| **Crop history** (5 seasons) | Fill in `tools/import/templates/seasons.csv` (field, crop_year, crop, variety, planted_on, harvested_on, yield_bu_ac; Excel's CSV is fine), then `pnpm import:seasons C:\path\seasons.csv`. Or upload it on **/admin/fields**, and correct a season in a field's **History** tab. |
| **Landlords, customers, crew** | **/admin/parties**: add one at a time, or import `tools/import/templates/parties.csv`; link a landlord to fields and a customer to farms there. |
| **Fields not in Ops Center** (prospects, customers) | **/admin/fields → Draw a new field**; open a field to edit its shape, split it with a line, or merge it with a neighbour (history follows). |
| **Soils** (SSURGO, both counties) | `pnpm gis:soils` once (needs the internet; behind a proxy: `$env:NODE_USE_ENV_PROXY=1` first). It downloads Lenawee (MI091) and Monroe (MI115) from NRCS Soil Data Access into `data\raw\soils`, loads them, and clips every field. Later: `--offline` reloads the last download with no network, `--refresh` downloads again. Until then the board shows a **synthetic** soils layer around the demo fields (labelled as such). |
| **Parcels** (D7) | `pnpm gis:parcels C:\path\parcels.zip --county 26091 --source lenawee-county --received-on 2026-12-01` (shapefile, GeoPackage, GeoJSON, an Esri File Geodatabase folder or zip, or an ArcGIS FeatureServer layer URL; `--replace` retires parcels the new file no longer has; `--map 'parcel=PIN,owner=OWNER1'` if the columns aren't detected, quoted in PowerShell). Until a real file arrives the board shows **synthetic** parcels with made-up owners; a real file replaces the synthetic parcels of its county. Owner names are shown to managers and the owner only. |
| **Aerial photos** | Online NAIP works whenever the internet does. To save close-ups of your area for offline use: `pnpm gis:naip` (needs the internet; `--maxzoom 16` for a smaller download, `--vintage "NAIP 2024"` to label the year). The area is `data\aoi.geojson` if you make one, else your fields plus a mile. |
| **Tile maps** | Managers draw lines with the **Tile** button (bottom right of the board). Installer drawings or a Deere tile plow export: `pnpm import:tile C:\path\tile.zip --origin installer_drawing` (`--field "Name"` to pin a field, `--size 6 --depth 3` when the file has no such columns). |
| **Backups** | `pnpm data:export` (keep the file somewhere safe), `pnpm data:import <file>` to restore. The demo farm, the simulator and anything a sync brings in are not in the file: they come back by themselves, with the same ids. PINs in the file only work with this PC's `SESSION_SECRET` (in `.env.local`, which the file never holds): restoring on a new PC, keep a copy of `.env.local` too, or set the PINs again (the owner's: `pnpm auth:reset-owner`). |

## Live weather (NWS)

The demo uses a simulated National Weather Service. For the real forecast of your fields, put
these two lines in `.env.local` (your contact goes in the User-Agent, as NWS asks), then restart
`pnpm dev` or `pnpm pilot`:

```
CONNECTOR_WEATHER=live
NWS_USER_AGENT="farm-manager (your email or website)"
```

The first run looks up each field's NWS grid cell (about 40 calls, once), then refreshes every
30 minutes even while `JOBS_DEMO_CADENCE=on` speeds up the simulated fleet. Switching back to
`sim` forgets the cached cells again. The forecast is stored, so the strip keeps working when
the internet drops (it says "Forecast stale" once NWS hasn't been reached for 2 hours).

## Connectors (slices 1f and 1f.2)

Every vendor has its own setting in `.env.local`; they all run at once. Unset, a vendor is `sim`
on the PC (the stand-in answers like it) and `off` on a production server. `replay` runs the real
client on fixtures written from the vendor's published API documents (no account); `sandbox` and
`live` use your credentials.

| Setting | Vendor (what it brings) | Modes | Credentials for sandbox / live |
|---|---|---|---|
| `CONNECTOR_DEERE` | John Deere Operations Center: machine breadcrumbs, fields, boundaries, flags, equipment and engine hours, this season's operations | sim, replay, sandbox, live | `DEERE_CLIENT_ID`, `DEERE_CLIENT_SECRET` (then sign in at `/api/oauth/deere`); optional `DEERE_REDIRECT_URI`, `DEERE_HOME_ORG_ID`, `DEERE_DAILY_CALL_BUDGET`, `DEERE_API_BASE`, `DEERE_EQUIPMENT_API_BASE` |
| `CONNECTOR_SAMSARA` | Samsara: the semis and pickups (positions, hours, odometer, fuel, fault codes), the vehicle list (tags), the RoGator's asset gateway | sim, replay, sandbox, live | `SAMSARA_API_TOKEN` |
| `CONNECTOR_MOTIVE` | Motive (a hired hauler): positions, stats, fault codes | sim, replay, sandbox, live | `MOTIVE_API_KEY` (the hauler's read-only key scoped to your trucks; a TEST MODE key for sandbox); optional `MOTIVE_API_BASE` |
| `CONNECTOR_GEOTAB` | MyGeotab (a hired hauler): positions, stats, fault codes | sim, replay, sandbox, live | `GEOTAB_DATABASE`, `GEOTAB_USERNAME`, `GEOTAB_PASSWORD` (a service account); optional `GEOTAB_SERVER` |
| `CONNECTOR_TERMINAL` | Terminal (one aggregator for haulers on other ELDs): positions, stats, fault codes, its providers | sim, replay, sandbox, live | `TERMINAL_SECRET_KEY`; optional `TERMINAL_CONNECTION_TOKEN` (pins one hauler), `TERMINAL_API_BASE` |
| `CONNECTOR_AEMP` | The standard ISO 15143-3 feed of every other brand (Kubota, Trackunit, Deere's and Samsara's): last-known positions, hours, fuel, DEF, fault series | sim, replay, sandbox, live | `AEMP_PROVIDERS` (below) |
| `CONNECTOR_CNH` | CNH FieldOps (Case IH, New Holland): positions, the fleet snapshot, caution and fault codes | sim, sandbox, live (no replay) | `CNH_CLIENT_ID`, `CNH_CLIENT_SECRET`, `CNH_SUBSCRIPTION_KEY` (then sign in at `/api/oauth/cnh`); optional `CNH_REDIRECT_URI`, `CNH_AUTH_BASE`, `CNH_API_BASE`, `CNH_AUDIENCE`, `CNH_CONNECTION` |

`VEHICLE_KIND_TAGS` names the vendor tags that make a vehicle a semi, pickup or service truck
(default `semi:Semi,pickup:Pickup,service_truck:Service truck`). `FLEET_STALE_SECONDS_LAST_KNOWN`
(3 h) is when a last-known snapshot counts as stale. An older `.env.local` with `CONNECTOR_ELD` /
`ELD_VENDOR` still works: those set the named vendor's key only, and `/admin/connectors` says
which line to write instead.

**The mixed fleet in sim.** `pnpm dev`, open `/board`: within about 30 s every vendor's machines
are on the map and the fleet panel, each with its vendor badge: the Deere combines, carts,
sprayer and planter (John Deere), the semis S1-S4 and the pickups PU1 (Ford) and PU2 (Ram)
(Samsara; their hours and odometer read "not reported"), the RoGator SP2 (Samsara's asset
gateway), the Case IH combine C3 and tractor T1 (CNH FieldOps), the Kubota loader L1 (AEMP, a
last-known position drawn fainter), and the hired semis H1 (Motive), H2 (MyGeotab) and H3
(Omnitracs XRS through Terminal). On `/admin/connectors` (manager) press **Critical engine code**
next to a semi under *Simulated truck fault codes*: its row turns red within seconds, and on a
driver's phone it offers "Critical fault: mark down?". Tap a field and open **History** for this
season's operations; turn on **Deere flags** in the rail and tap a pin. More stand-in knobs:
`pnpm dev --scenario=breakdown` (S3 gets a red-stop engine code at 9:40); the vendor stand-ins'
`/_control/vendor/<vendor>/…` routes (Motive, Geotab, Terminal and CNH fault codes, AEMP faults,
Deere's full-day sprayer coverage at `/_control/vendor/deere/ops/full-day`) are listed in each
`src/sim/vendors/<vendor>/control-types.ts`.

**The mixed fleet in replay.** Put these lines in `.env.local` and restart:

```
CONNECTOR_DEERE=replay
CONNECTOR_SAMSARA=replay
CONNECTOR_MOTIVE=replay
CONNECTOR_GEOTAB=replay
CONNECTOR_TERMINAL=replay
CONNECTOR_AEMP=replay
```

The fleet panel's badges then read "· replay" (one mode notice per connection that isn't live),
the Deere fields, flags, machines and operations come from the fixtures, S3 shows a critical
fault and S2 a warning; CNH, which has no replay mode, keeps its stand-in. Delete the lines to go
back to the simulation. CI runs the replay specs this way.

**John Deere on the PC (sandbox).** With a Deere app from developer.deere.com:
`CONNECTOR_DEERE=sandbox`, `DEERE_CLIENT_ID` and `DEERE_CLIENT_SECRET` in `.env.local`. In the
app profile register both `http://localhost:3000/api/oauth/deere` and
`http://localhost:3000/admin/connectors` as Redirect URIs (if Deere refuses localhost, publish
[`docs/deere-callback.html`](docs/deere-callback.html) on an HTTPS page, register that page, and
set `DEERE_REDIRECT_URI` to it: it forwards the sign-in to the PC). Open
`http://localhost:3000/api/oauth/deere` and allow `offline_access ag1 ag2 eq1` (a grant made
before Oct 31 lacks `ag2`: sign in again). The callback page lists the organizations that still
need approval, each with an **Approve in Deere Connections** link that brings you back to
`/admin/connectors`. If you belong to more than one organization, set `DEERE_HOME_ORG_ID` (the
page asks). `DEERE_DAILY_CALL_BUDGET` (Deere API calls a day) makes the Deere jobs plan on 80 %
of it; unset, the page says "limit unknown". Then `pnpm connectors:record deere --scrub` and
`pnpm test:live`. Never point it at your production Deere organization without deciding to.

**Other vendors' sandboxes.** MyGeotab: create the free demo database at
my.geotab.com/registration.html, add a user with Authentication type *Service Account* (view
only, whole-fleet scope), then `CONNECTOR_GEOTAB=sandbox` with `GEOTAB_DATABASE`,
`GEOTAB_USERNAME` and `GEOTAB_PASSWORD`. Motive: a hauler's read-only, group-scoped, expiring key
in `MOTIVE_API_KEY` (sandbox = a TEST MODE key on the same host). Terminal: a customer account's
`TERMINAL_SECRET_KEY` with `CONNECTOR_TERMINAL=sandbox`. CNH FieldOps: a developer account at
develop.cnh.com (a company email), register `http://localhost:3000/api/oauth/cnh` (or
`CNH_REDIRECT_URI`) on the app, `CONNECTOR_CNH=sandbox` with the client id, secret and
subscription key, sign in at `/api/oauth/cnh`; CNH needs a staging recording before sandbox or
live use (`pnpm test:live` is the smoke test for it). `AEMP_PROVIDERS` is one JSON line listing
the ISO 15143-3 feeds, for example:

```
AEMP_PROVIDERS=[{"id":"samsara","baseUrl":"https://api.samsara.com/beta/aemp","auth":"bearer","token":"<samsara token>","format":"json","idElement":"EquipmentID"},{"id":"deere","baseUrl":"https://sandboxaemp.deere.com","auth":"deere_oauth","format":"xml","minIntervalSeconds":3600},{"id":"trackunit","baseUrl":"https://<trackunit host>/aemp","auth":"oauth2","clientId":"<id>","clientSecret":"<secret>","tokenUrl":"https://<trackunit token url>","faultsPath":"/Fleet/Equipment/ID/{id}/Faults/{start}/{end}/{page}","minIntervalSeconds":960},{"id":"kubota","baseUrl":"<from your dealer>","auth":"basic","username":"<user>","password":"<password>"}]
```

(`deere_oauth` reuses the Deere sign-in, live host `https://partneraemp.deere.com`; Kubota's host
and credentials come from the dealer, only for KubotaNOW machines.)

## Ports

| Port | What | Reachable from |
|---|---|---|
| 3000 | the app (`PUBLIC_URL` in `.env.local`) | the LAN: phones and the wall display |
| 4010 | vendor stand-in (`VENDOR_SIM_URL`) | this PC only (loopback) |
| 15432 | Postgres (`DB_PORT` in `.env`) | this PC only (loopback) |
| 3443 | `pnpm pilot:https` (slice 2c, not yet) | the LAN |

## Pages

- `http://localhost:3000/board`: the war room (wall display, touch: pan, pinch, rotate; tap a
  field or a machine).
- `http://<pc-ip>:3000/m`: the phone view (`pnpm dev` prints the exact URLs). A phone that isn't
  signed in lands on the sign-in page.
- `/login`: sign in (managers: name + PIN; shared screens: the PIN pad). `/enroll`: where an
  enrollment link lands.
- `/admin/fields`, `/admin/parties`, `/admin/spray`, `/admin/people`, `/admin/devices`,
  `/admin/connectors` (every connection, its calls, mode and capabilities; Deere sign-in and
  orgs; dead letters; the sim knobs), `/admin/vehicles` (vehicle kinds by hand),
  `/admin/realtime`: need a manager (or the PC's Admin link).
- `http://<pc-ip>:3000/api/health`: phone check; it should show `"ok":true`.

## M1 demo (what to look at)

1. `pnpm dev`; sign in as the owner (first run) or open the Admin link; open
   `http://localhost:3000/board`.
2. **Tap a field**: its panel opens at once (under 200 ms) with acres, landlord, notes and 5
   seasons; try the **History**, **Soils**, **Parcels** and **Spray** tabs. Tap empty map to
   close it.
3. **Fleet**: on a phone at `http://<pc-ip>:3000/m`, sign in (Amy Kovach's demo PIN), open
   **Fleet**, tap **Down** on a combine and pick a reason: the wall shows it down within 2
   seconds. Tap **Back up** to put it back. Same under `pnpm pilot`.
4. **Weather**: the strip at the bottom of the board. On **/admin/spray** drag the simulated
   wind to 20 mph and press **Apply to the simulated forecast**: within seconds every field turns no-go ("Wind 2x mph (limit
   10)"); turn on *Spray go/no-go* in the layer rail to see the colours. Set it back to 5.
5. **Your data**: `pnpm import:boundaries tools\import\templates\boundaries-example.geojson`
   (two made-up 80s, *Prospect South 80* and *Prospect North 80*, about 20 miles west-southwest
   of Adrian), then `pnpm import:seasons tools\import\templates\seasons-example.csv` (their
   crop years 2021-2025). Reload the board (F5): it opens on all the fields, the two prospects
   at its west edge. Zoom in and tap *Prospect South 80*: its panel lists the five seasons you
   imported (newest first), and so does its **History** tab. Upload
   `tools\import\templates\parties-example.csv` on **/admin/parties**. Then `pnpm data:export`,
   `pnpm db:reset`, `pnpm data:import <the file>`: everything is back.
6. **Layers**: soils, drainage tile, parcels and aerial photos from the rail. Unplug the
   router's internet (WAN) cable: everything but the online aerial photos keeps working, and
   those say "offline".

The same demo runs as an automated test: `pnpm test:e2e e2e/m1-demo.spec.ts --project=wall`.
The slice 1f/1f.2 demo (the mixed fleet, a critical code, pins, operations, `/admin/connectors`)
runs as `pnpm test:e2e e2e/m1f-mixed-fleet.spec.ts --project=wall`, and its replay twin as
`pnpm test:e2e e2e/m1f-replay.spec.ts --project=wall` against an app started with the replay
lines above.
The M0 demo (pause the simulation, "trucks API down", the phone within 2 s of the wall) still
runs as `pnpm test:e2e e2e/m0-demo.spec.ts --project=wall`.

The demo tuning `pnpm env:init` writes into `.env.local` (`JOBS_DEMO_CADENCE=on`,
`FLEET_STALE_SECONDS=60`, `FLEET_STALE_SECONDS_DEERE=900`) makes this quick. Delete those lines
for the plan's defaults (trucks every 30 s, stale after 10 minutes).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Docker running FAIL` in bootstrap, or `pnpm db:up` hangs | Start Docker Desktop and wait until it says *Engine running*, then re-run `pnpm run bootstrap`. Check *Use the WSL 2 based engine* is on. |
| `port 3000 is in use` / `port 15432 ... in use by another program` | Find the owner: `Get-NetTCPConnection -LocalPort 3000 \| Select-Object OwningProcess`, then `Get-Process -Id <pid>`. Stop it (an old `pnpm dev`, another Postgres), or move the app: `PUBLIC_URL=http://localhost:3001` in `.env.local` (database: `DB_PORT` in `.env` and the port in both database URLs in `.env.local`). |
| `the postgres password in .env does not match the database volume` | Restore your old `.env`, or start clean: `pnpm db:nuke` (deletes the local database), then `pnpm run bootstrap`. |
| `.env missing, but the database volume ... exists` (e.g. after a fresh clone) | Restore your old `.env`, or start clean: `pnpm env:init`, then `pnpm db:nuke` (deletes the local database), then `pnpm run bootstrap`. |
| Folder under OneDrive | Bootstrap refuses it. Clone to `C:\dev\farm-manager` and run there. |
| Phones can't open `http://<pc-ip>:3000/m` | Set the shop Wi-Fi profile to *Private* and allow Node.js on private networks when Windows asks, or once in an **admin** PowerShell: `New-NetFirewallRule -DisplayName 'farm-ops dev' -Direction Inbound -Protocol TCP -LocalPort 3000,3443 -Profile Private -Action Allow`. Pick the PC address of the Wi-Fi adapter from the list `pnpm dev` prints. If the PC's address changed, `pnpm env:init --refresh-origins` and restart `pnpm dev`. If you dismissed the Windows prompt (Cancel or No), Windows created Block rules for Node.js, and block rules beat any allow rule: remove them first in an **admin** PowerShell, `Get-NetFirewallRule \| Where-Object { $_.Name -like '*Query User*' -and $_.Name -like '*node.exe*' -and $_.Action -eq 'Block' } \| Remove-NetFirewallRule`, then add the Allow rule above. |
| `port 3000 is reserved by Windows`, `listen EACCES: permission denied 0.0.0.0:3000`, or Docker's `bind: An attempt was made to access a socket in a way forbidden by its access permissions` | The port sits in a range Windows reserved for Hyper-V/WSL/Docker (`netsh interface ipv4 show excludedportrange protocol=tcp` lists them). Pick a port outside them (`PUBLIC_URL` in `.env.local` for the app, `DB_PORT` in `.env` plus both database URLs for Postgres, `VENDOR_SIM_URL` for the stand-in), or release the reservations once in an **admin** PowerShell: `net stop winnat`, then `net start winnat`. |
| `offline basemap missing, run pnpm gis:basemap` | The Protomaps download failed. Check the internet connection and run `pnpm gis:basemap`. Behind a corporate proxy: `$env:NODE_USE_ENV_PROXY=1`, then `pnpm gis:basemap`. To carry on without it: `pnpm run bootstrap --synthetic-basemap` installs a small made-up test basemap (the board badges it). Later plain bootstraps try the real one again and replace it once Protomaps can be reached; until then they keep the synthetic one with a `WARN offline basemap kept ...` line and carry on (they never stop on it). `pnpm gis:basemap` does the same fetch on its own. |
| `running scripts is disabled on this system` (PowerShell blocks npm's `pnpm.ps1`) | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then open a new PowerShell. Or, without changing the policy, type `pnpm.cmd` wherever this README says `pnpm`. |
| `packages field missing or empty` at `pnpm install` | An older pnpm (9 or 10) is installed. `npm i -g pnpm@12`, open a new PowerShell, and check `pnpm -v` says 12. |
| `did not finish downloading` (the database image) or `unexpected EOF` during bootstrap | The download was cut off: the network dropped, or Docker Desktop restarted to update itself. Wait until Docker Desktop says *Engine running*, then run `pnpm run bootstrap` again; it carries on from there. |
| `Terminate batch job (Y/N)?` after Ctrl+C | Shown when pnpm was started as `pnpm.cmd`. The app has already stopped; answer `Y`. |
| Wrong Node version at `pnpm install` | Install Node 24 (see Prerequisites), open a new PowerShell, `pnpm install`. |
| The board or `/m` shows the sign-in page | Nobody is signed in on that browser, or its device was revoked. On the PC: open the Owner link (first run) or the Admin link `pnpm dev` printed. Elsewhere: sign in with a name and PIN (managers), or enroll the screen on **/admin/devices** ([`docs/kiosk.md`](docs/kiosk.md)). The wall kiosk right after enrolling: it was enrolled in another Chrome profile or on the LAN link; **New code** for the wall and run the panel's **On this PC (wall kiosk)** command (First run, step 2). |
| "Admin is locked" on an admin page | It needs a manager: sign in at `/login`, or open the Admin link `pnpm dev` printed (on the PC). |
| A PIN is refused with "locked" | Five wrong PINs lock that person for 15 minutes (longer if it keeps happening). A manager can **Unlock** them on **/admin/people**. |
| Forgot the owner PIN | `pnpm auth:reset-owner`, then open the link it prints on the PC within 30 minutes. |
| `pnpm gis:soils` says Soil Data Access can't be reached | Check the internet; behind a proxy `$env:NODE_USE_ENV_PROXY=1` first. SDA has a daily maintenance window: try again later. The synthetic soils stay until a download succeeds. |
| The Soils tab says "Synthetic test fixture, not survey data" | Real SSURGO hasn't been loaded yet: `pnpm gis:soils`. After `pnpm db:reset`, `pnpm gis:soils --offline` reloads your last download without the internet. |
| An import says a column wasn't found | `pnpm import:boundaries <file> --dry-run` lists what it detected; name the column with `--name-attr`, `--farm-attr`, `--id-attr` (shapefile column names are cut to 10 characters, e.g. `CLIENT_NAM`). |
| `data:import` stops with "NOTHING WRITTEN" | It lists each row that failed. Fix them, or `--partial` to keep what worked. A note (not an error) about a person "not in this database" means the row came back without saying who entered it. |
| The weather strip says "Simulated weather" | That's the default; see "Live weather" above. A strip that says "Forecast stale": is `pnpm dev` running, and does the PC have internet (live mode)? |
| The board shows "Fleet unavailable" or nothing moves | Is `pnpm dev` still running, and is the job clock running on `/admin/connectors` (not paused)? The simulation may be paused there too. |
| A page keeps reloading under `pnpm dev` | A Next 16 dev-cache glitch after `pnpm pilot` built the app; `pnpm dev` now clears `.next\dev` itself when a production build ran since its last start. If it still happens: Ctrl+C, `Remove-Item -Recurse -Force .next\dev`, `pnpm dev`. |

## Where things are

- `src/app`: pages and API routes (`board`, `m`, `login`, `enroll`, `admin/*`, `api/*`);
  `src/ui`: the map, the board, the field panel, the fleet panel, the weather strip, the layer
  rail and the tile tool.
- `src/platform/auth`: sign-in (sessions, PINs, devices); `src/sim` + `tools/vendor-sim`: the
  simulated farm and the vendor stand-ins; `src/connectors`: the Deere, Samsara, Motive,
  MyGeotab, Terminal, CNH, ISO 15143-3 (AEMP) and NWS clients, their replay fixtures and the
  vendor registry (`vendors.ts`: labels and what each route reports); `src/jobs`: scheduled jobs
  (one per connection).
- `db/migrations`: SQL for both your PC and Supabase. `scripts/` and `tools/`: bootstrap, the
  launchers, the clock, the importers (`tools/import`), the GIS loaders (`tools/gis`) and the
  seed. `e2e/`: Playwright specs.
- Local data lives in `.data/`, `data/raw/` and the Docker volume; real farm data is never
  committed.
