# Farm Ops

Farm Ops is the operations software described in [`farm-ops-software-spec.md`](farm-ops-software-spec.md):
one database keyed on fields, machines and jobs, fed by John Deere Operations Center, the trucks'
ELD (Samsara or Motive) and public data, and shown on a touch "war-room" map on the shop wall and
on phones. Until it is solid it runs entirely on your Windows PC with Docker Desktop: Next.js on
Node, Supabase's own Postgres image in Docker, and a local **vendor stand-in** that answers like
Deere, Samsara and the National Weather Service for one simulated farm (40 fields around Adrian
and Blissfield, 2 combines, 2 grain carts, 4 semis, 3 elevators), so the real connector code runs
without any vendor account.

The plan is [`docs/build-plan.md`](docs/build-plan.md); the code-level agreements are
[`docs/contracts.md`](docs/contracts.md) (M0) and [`docs/contracts-m1.md`](docs/contracts-m1.md)
(M1). The defaults in force for the decisions only you can make (spray thresholds, roles, the
boundary master, parcels…) are in [`docs/decisions.md`](docs/decisions.md). Sign-in, the wall
kiosk and the cab iPads: [`docs/kiosk.md`](docs/kiosk.md).

This is milestone **M1 "See it"**, slices 1a-1d: tap a field, the fleet panel and sign-in (1a),
the weather strip with an advisory spray go/no-go (1b), your own fields, people, crop history and
soils (1c), and imagery, parcels, tile maps and the layer rail (1d).

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
git checkout claude/m1-see-it   # until M1 is merged into main
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

**Coming from M0:** `git pull`, `git checkout claude/m1-see-it`, `pnpm install`,
`pnpm run bootstrap` (it applies the two new migrations), then `pnpm db:reset` once so the demo
farm gets its M1 extras (demo sign-ins, soils, parcels, field entrances). `db:reset` wipes the
app's data: if you typed anything in, `pnpm data:export` first and `pnpm data:import <file>`
after.

## First run: sign in

1. `pnpm dev` prints an **Owner** link the first time:
   `http://localhost:3000/login/setup?code=…`. Open it **on the PC**, enter your name and a PIN
   only you know: you are the owner. After that `pnpm dev` prints where to sign in instead.
2. **The wall display:** on **/admin/devices** add a *Wall display*; open the link (or scan the
   QR code) on the wall's browser once. Start it as a kiosk:
   `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --force-device-scale-factor=2 --user-data-dir=$env:LOCALAPPDATA\farm-kiosk http://localhost:3000/board`
   (the board is laid out for 1920 x 1080 CSS px: `2` for a 4K panel, `1` for a 1080p one).
   Anyone at the wall taps the name chip (top right) to sign in with their PIN.
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
| `pnpm pilot` | The production build (`next build` + `next start`) with the same stand-in and clock: the wall display and phones. `--skip-build` reuses the last build. |
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
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | What CI runs. |

## Your own data

Everything below writes to your PC's database only. Real farm data is never committed.

| What | How |
|---|---|
| **Field boundaries** from Operations Center | Export the boundary shapefile from Ops Center (a .zip), then `pnpm import:boundaries C:\path\export.zip --dry-run` to see what it would do, and again without `--dry-run`. Also takes a .shp (with its .dbf/.prj next to it) or GeoJSON. Options: `--farm "Name"`, `--tenure owned\|cash_rent\|share\|custom`, `--county 26091\|26115`, `--hide-demo` (switches the demo fields off), `--name-attr COL` if it picks the wrong column. Fields with a Deere id stay read-only in the app (D6). Or upload the file on **/admin/fields** (up to 4 MB). |
| **Crop history** (5 seasons) | Fill in `tools/import/templates/seasons.csv` (field, crop_year, crop, variety, planted_on, harvested_on, yield_bu_ac; Excel's CSV is fine), then `pnpm import:seasons C:\path\seasons.csv`. Or upload it on **/admin/fields**, and correct a season in a field's **History** tab. |
| **Landlords, customers, crew** | **/admin/parties**: add one at a time, or import `tools/import/templates/parties.csv`; link a landlord to fields and a customer to farms there. |
| **Fields not in Ops Center** (prospects, customers) | **/admin/fields → Draw a new field**; open a field to edit its shape, split it with a line, or merge it with a neighbour (history follows). |
| **Soils** (SSURGO, both counties) | `pnpm gis:soils` once (needs the internet; behind a proxy: `$env:NODE_USE_ENV_PROXY=1` first). It downloads Lenawee (MI091) and Monroe (MI115) from NRCS Soil Data Access into `data\raw\soils`, loads them, and clips every field. Later: `--offline` reloads the last download with no network, `--refresh` downloads again. Until then the board shows a **synthetic** soils layer around the demo fields (labelled as such). |
| **Parcels** (D7) | `pnpm gis:parcels C:\path\parcels.zip --county 26091 --source lenawee-county --received-on 2026-12-01` (shapefile, GeoPackage, GeoJSON, an Esri File Geodatabase folder or zip, or an ArcGIS FeatureServer layer URL; `--replace` retires parcels the new file no longer has; `--map 'parcel=PIN,owner=OWNER1'` if the columns aren't detected, quoted in PowerShell). Until a real file arrives the board shows **synthetic** parcels with made-up owners; a real file replaces the synthetic parcels of its county. Owner names are shown to managers and the owner only. |
| **Aerial photos** | Online NAIP works whenever the internet does. To save close-ups of your area for offline use: `pnpm gis:naip` (needs the internet; `--maxzoom 16` for a smaller download, `--vintage "NAIP 2024"` to label the year). The area is `data\aoi.geojson` if you make one, else your fields plus a mile. |
| **Tile maps** | Managers draw lines with the **Tile** button (bottom right of the board). Installer drawings or a Deere tile plow export: `pnpm import:tile C:\path\tile.zip --origin installer_drawing` (`--field "Name"` to pin a field, `--size 6 --depth 3` when the file has no such columns). |
| **Backups** | `pnpm data:export` (keep the file somewhere safe), `pnpm data:import <file>` to restore. The demo farm, the simulator and anything a sync brings in are not in the file: they come back by themselves, with the same ids. |

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
the internet drops (it shows how old the forecast is).

## Replay mode (Deere and the trucks from recorded fixtures)

`CONNECTOR_DEERE=replay` and `CONNECTOR_ELD=replay` in `.env.local` run the real Deere and
Samsara clients on fixtures written from the vendors' published API documents (no stand-in, no
account): the fleet panel says "Deere: replay · Samsara: replay". Delete the lines to go back
to the simulation.

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
  `/admin/connectors`, `/admin/realtime`: need a manager (or the PC's Admin link).
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
5. **Your data**: `pnpm import:boundaries tools\import\templates\boundaries-example.geojson` and
   `pnpm import:seasons tools\import\templates\seasons-example.csv` (two made-up fields west of
   the demo farm); upload `tools\import\templates\parties-example.csv` on **/admin/parties**.
   Then `pnpm data:export`, `pnpm db:reset`, `pnpm data:import <the file>`: everything is back.
6. **Layers**: soils, drainage tile, parcels and aerial photos from the rail. Unplug the
   router's internet (WAN) cable: everything but the online aerial photos keeps working, and
   those say "offline".

The same demo runs as an automated test: `pnpm test:e2e e2e/m1-demo.spec.ts --project=wall`.
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
| `offline basemap missing, run pnpm gis:basemap` | The Protomaps download failed. Check the internet connection and run `pnpm gis:basemap`. Behind a corporate proxy: `$env:NODE_USE_ENV_PROXY=1`, then `pnpm gis:basemap`. To carry on without it: `pnpm run bootstrap --synthetic-basemap` installs a small made-up test basemap (the board badges it; a later plain bootstrap replaces it). |
| `running scripts is disabled on this system` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then open a new PowerShell. |
| Wrong Node version at `pnpm install` | Install Node 24 (see Prerequisites), open a new PowerShell, `pnpm install`. |
| The board or `/m` shows the sign-in page | Nobody is signed in on that browser, or its device was revoked. On the PC: open the Owner link (first run) or the Admin link `pnpm dev` printed. Elsewhere: sign in with a name and PIN (managers), or enroll the screen on **/admin/devices** ([`docs/kiosk.md`](docs/kiosk.md)). |
| "Admin is locked" on an admin page | It needs a manager: sign in at `/login`, or open the Admin link `pnpm dev` printed (on the PC). |
| A PIN is refused with "locked" | Five wrong PINs lock that person for 15 minutes (longer if it keeps happening). A manager can **Unlock** them on **/admin/people**. |
| Forgot the owner PIN | `pnpm auth:reset-owner`, then open the link it prints on the PC within 30 minutes. |
| `pnpm gis:soils` says Soil Data Access can't be reached | Check the internet; behind a proxy `$env:NODE_USE_ENV_PROXY=1` first. SDA has a daily maintenance window: try again later. The synthetic soils stay until a download succeeds. |
| The Soils tab says "Synthetic test fixture, not survey data" | Real SSURGO hasn't been loaded yet: `pnpm gis:soils`. After `pnpm db:reset`, `pnpm gis:soils --offline` reloads your last download without the internet. |
| An import says a column wasn't found | `pnpm import:boundaries <file> --dry-run` lists what it detected; name the column with `--name-attr`, `--farm-attr`, `--id-attr` (shapefile column names are cut to 10 characters, e.g. `CLIENT_NAM`). |
| `data:import` stops with "NOTHING WRITTEN" | It lists each row that failed. Fix them, or `--partial` to keep what worked. A note (not an error) about a person "not in this database" means the row came back without saying who entered it. |
| The weather strip says "Simulated weather" | That's the default; see "Live weather" above. A strip that says the forecast is hours old: is `pnpm dev` running, and does the PC have internet (live mode)? |
| The board shows "Fleet unavailable" or nothing moves | Is `pnpm dev` still running, and is the job clock running on `/admin/connectors` (not paused)? The simulation may be paused there too. |
| A page keeps reloading under `pnpm dev` | A Next 16 dev-cache glitch after `pnpm pilot` built the app; `pnpm dev` now clears `.next\dev` itself when a production build ran since its last start. If it still happens: Ctrl+C, `Remove-Item -Recurse -Force .next\dev`, `pnpm dev`. |

## Where things are

- `src/app`: pages and API routes (`board`, `m`, `login`, `enroll`, `admin/*`, `api/*`);
  `src/ui`: the map, the board, the field panel, the fleet panel, the weather strip, the layer
  rail and the tile tool.
- `src/platform/auth`: sign-in (sessions, PINs, devices); `src/sim` + `tools/vendor-sim`: the
  simulated farm and the vendor stand-in; `src/connectors`: the Deere, Samsara, Motive and NWS
  clients and their replay fixtures; `src/jobs`: scheduled jobs.
- `db/migrations`: SQL for both your PC and Supabase. `scripts/` and `tools/`: bootstrap, the
  launchers, the clock, the importers (`tools/import`), the GIS loaders (`tools/gis`) and the
  seed. `e2e/`: Playwright specs.
- Local data lives in `.data/`, `data/raw/` and the Docker volume; real farm data is never
  committed.
