# Instructions for the agent on Derrick's PC

You are a coding agent (e.g. Claude Code) running on Derrick's **Windows PC**, in the repository
clone at `C:\dev\farm-manager`. Most of this project is built by a cloud agent on a Linux
machine. That machine can't do some things:
- it can't reach some public data sites (the Protomaps basemap builds, `api.weather.gov`, NRCS
  Soil Data Access, the USGS NAIP image service);
- it has no Windows;
- it has no wall display, phones or shop Wi-Fi;
- it can't do a browser sign-in to Derrick's vendor accounts.

Your job is those parts. Read `docs/status.md` first: it says what is built and what is open.
The plan is `docs/build-plan.md`, and the code-level rules are `docs/contracts.md` and
`docs/contracts-m1.md`.

**This round starts at "Round 2" just below.** Sections 1-4 are the standing reference.

## Round 2 (updated Oct 31, 2026): start here

Round 2 hasn't been started yet. `main` now has your section 2 results, the cloud's follow-up to
them, and (since Oct 31) the soil type map. Read `docs/status.md`, "Oct 30, 2026: cloud
follow-up to the PC checks" and "Oct 31, 2026: soil type map", for what changed. Work on a
branch `pc/round2` made from `main` (slice 1e gets its own branch, step D). Record each step's
result in one new dated entry under `## PC findings` in `docs/status.md`.

### A. Update

```powershell
cd C:\dev\farm-manager
git checkout main
git pull
pnpm install
pnpm run bootstrap
```

Pass when bootstrap ends with "Ready." and its migrations line says `7 of 7 applied`. The new
one is `0006_m1_forecast_checked`; the soil map added none. Then `pnpm db:check` says "all PASS". Leave Node as it is (24.13 works: the code no longer depends on
its Windows-1252 decoder); updating Node is Derrick's call.

### B. Re-check live weather (section 2, check 2)

The "forecast stale" caution now counts from the app's last successful NWS check, not from when
NWS issued the forecast.

1. In `.env.local`, uncomment `CONNECTOR_WEATHER=live` (`NWS_USER_AGENT` is already set), then
   restart `pnpm dev`.
2. Live weather runs at :00 and :30 (the 30-second demo cadence never applies to a live source).
   Switching the source looks the cells up again, so wait for one complete run.
3. Pass when, after that run:
   - **Board:** the weather strip has no "Forecast stale" badge.
   - **Field panel:** a field's Spray tab reads "NWS forecast issued <time>, checked <time>", with
     no "forecast stale" reason. Real reasons such as gusts can still show.
   - **`/admin/spray`:** shows "issued …, checked …".
   - **Next run:** the "checked" time moves on 30 minutes later.
   - **Evidence:** paste this into the status entry:

     ```powershell
     docker compose exec db psql -U postgres -c "select id, forecast_checked_at, forecast_checked_issue from farm.weather_grids order by id limit 5"
     ```
4. Leave weather on `live` only if Derrick wants it. Otherwise comment the line out again
   (demo step 4, the wind slider, needs `sim`) and restart.

Don't wait 2 hours to see the outage warning. The cloud's tests cover it: with no NWS check for
more than 2 hours, every view says "Forecast not checked with NWS for N h".

### B2. Soil map walk-through and fleet inventory (with Derrick)

The soil type map is on `main` now (merged Oct 31; it needs no extra setup). With **Soils** on in
the layer rail, a picker under the toggle colours the soils by:

- **Soil type:** outlines and map unit symbols, no fill. Soil names join the symbols when zoomed
  in close (zoom 16).
- **Drainage** (the default), **Hydrologic group**, **Farmland class**, and **Productivity**
  (NCCPI, the national crop productivity index).

Labels start at zoom 13. Below the legend, "In this view" lists the map units on screen (from
zoom 12). With soils on, a tap outside any field opens a **map unit sheet**: drainage,
hydrologic group, farmland class and productivity, the components with their percent, and the
official series description (a QR code on the wall, a link on phones). In a field's **Soils**
tab, each map unit symbol opens the same sheet.

1. Walk Derrick through it on the board and on his phone (`/m`):
   - try each colour mode;
   - zoom in until the names show;
   - tap a map unit outside a field;
   - scan the wall's QR code with his phone;
   - open a field's Soils tab and tap a symbol.
2. Ask him, and write his answers in the status entry:
   - Which modes would he actually use, and which should be the default on the wall and on
     phones?
   - On the wall, are the labels readable or cluttered? Are the colours and legends readable
     from across the room?
   - What's missing? Phase B (on this PC after 1e, section 3 item 1) adds texture, slope, tile
     drainage ratings, organic matter, pH and CEC. Which of those matter most to him?

Then take a **fleet inventory**. The cloud is building connectors for:

- **trucks:** Samsara, Motive, Geotab, and Terminal (one connection that covers many other ELD
  brands, for hired haulers);
- **machines:** Deere, CNH (Case IH and New Holland), the ISO 15143-3 "AEMP" standard (Kubota
  and other brands), and Samsara gateways on machines;
- **pickups:** Ford and Ram, through the truck telematics vendor's Ford Pro or Stellantis link.

Ask Derrick for each truck and machine: make, model, model year, and what telematics or app it
already has (for example JDLink, Case IH AFS Connect, FordPass or Ford Pro, Uconnect, an ELD
brand in each semi, or none). For hired haulers, ask which ELD each one runs, if he knows.

- **Status entry:** counts only, by brand and telematics, e.g. "3 Deere with JDLink, 1 Case IH
  combine with AFS Connect, 2 Ford F-250 (FordPass), 4 semis on <ELD>".
- **Full list:** it's Derrick's farm data, so it stays out of git. Keep it in
  `data/raw/fleet-inventory.txt` (gitignored).

### C. Windows re-checks of this round's changes

| # | Check | How | Pass when |
|---|---|---|---|
| C1 | Tests on this PC | `pnpm lint`, `pnpm typecheck`, `pnpm test`, then `pnpm test:db` **three times** | All pass. Report the counts. A failure in `src/connectors/nws/weather-job.db.test.ts` matters most: its clock was the likely cause of the one-off failure in section 2 |
| C2 | What `db:up` asks Docker after a failed start | `docker compose config --images` | It prints `supabase/postgres:17.11.0.008`. Don't stop or break Docker to test the failure messages unless Derrick wants to |
| C3 | Check 5's new command | Ctrl+C in `pnpm dev`, then `Get-CimInstance Win32_Process -Filter "Name='node.exe'" \| Where-Object CommandLine -like '*farm-manager*'` | It lists nothing |
| C4 | e2e on the PC | `pnpm test:e2e e2e/weather.spec.ts e2e/m1-demo.spec.ts --project=wall` with weather on `sim` | All pass |
| C5 | Soil map e2e on Windows | `pnpm test:e2e e2e/soils-map.spec.ts --project=wall` | All pass |
| C6 | Soil labels on the real soils | Under `pnpm pilot` (`pnpm dev` compiles each route on its first request, so it can't be timed), signed in on `/board`: turn Soils on, zoom to about 14 over the farm, pan a few times, then zoom to 16. Time the `/api/soils/labels` requests in the browser's Network tab, or with a short Playwright script | Record the first and the later times in the status entry. The cloud could only time synthetic soils. The first request on the real soils should take under about 1 s and repeats much less, because label points are remembered. Report anything over about 2 s |

If something fails, fix it on `pc/round2` when the fix is clear and small. Otherwise describe
it, with the output, in the status entry. Push `pc/round2` when A-C (and B2) are done.

Don't pull or test `claude/m1-1f`: it's the cloud's work in progress on slices 1f and 1f.2 (live
Deere, fault codes, sync health, and the other truck, machine and pickup connectors). It changes
the database (migration `0007`), and Derrick will say when it's on `main`. After that pull, run
`pnpm db:seed demo` once, as the merge notes will also say.

### D. Then slice 1e (lidar and crop history) on the PC

Do section 3, item 1, on a branch `pc/slice-1e`, with these specifics:

- **Answer the plan's 1e questions first** (plan §8, the "1e" bullet: the CSB release format and
  size, the latest CDL year, and whether WhiteboxTools runs in Docker here). Put the answers in the
  status entry before building.
- **Order:**
  1. `gis:cdl` first. It's county-wide, small and quick, and it gives rotation history.
  2. `gis:csb`.
  3. `gis:dem`. It downloads about 18 GB: check free disk space (`Get-PSDrive C`) and tell Derrick
     before downloading.
  4. Terrain stats.
  5. The demo swap to CSB shapes.
  6. Flow paths last. If they fight you, they move to 4b with a note in `docs/decisions.md` (plan
     §6 says so).
- **Schema:** never edit `db/migrations/` or `src/db/schema/`. Put new tables in
  `db/pending/pc-1e.sql`, following the rules in `db/pending/README.md` (idempotent; `gis`
  schema; EPSG:4326 with GiST). Then `pnpm db:pending` applies them to your database, and the
  tests apply them on their own. Describe the Drizzle mirror you'd want in the status entry.
  The cloud agent turns the file into the next free migration number and writes the mirror
  when it merges. (Slice 1f, being built in the cloud on `claude/m1-1f`, takes `0007`, so 1e's tables become
  `0008` or later.)
- **Data:**
  - Raw downloads go under `data/raw/` (gitignored), and work files in the `gis_work` volume.
  - Cache every CropScape download: it has had outages and certificate problems.
  - Never commit full rasters. Commit only small test fixtures (a CDL clip, a 1 km² DEM tile;
    plan §7), so CI tests the loaders without the internet. The pre-clipped CDL for the demo
    fields is the plan's one exception.
- **Rules from plan §5:**
  - Warp every 3DEP tile to EPSG:3078 before mosaicking: Lenawee mixes UTM 16 and 17.
  - Count CDL pixels in EPSG:5070.
  - Give raster PMTiles content-addressed names (`hillshade.<sha8>.pmtiles`), registered in
    `gis.map_layers`.
  - GDAL and pmtiles run in Docker, like the other `gis:*` loaders. Follow how
    `tools/gis/naip.ts` and `tools/gis/soils.ts` are built.
- **Push pieces as they land.** For example, push when `gis:cdl` and its tests pass, record it in
  status, and tell Derrick the cloud can review and merge it. Don't hold everything for one big
  push.
- **Done when:** plan §6 1e "Done when" holds on this PC.

### E. Cleanup (only if Derrick says so)

These remote branches are merged and can go:

```powershell
git push origin --delete pc/section2-checks
git push origin --delete claude/fix-e2e-flakes
git push origin --delete claude/m0-win-debug
git push origin --delete claude/pc-followups
git push origin --delete claude/soil-map
git push origin --delete claude/pc-agent-docs
```

The cloud's proxy can't delete branches, so this has to happen on the PC (or on GitHub's
website).

## Ground rules

- **Shell:** PowerShell, one command per line (Windows PowerShell 5.1 has no `&&`). Node **24**
  and pnpm **12** (`node -v`, `pnpm -v`). Docker Desktop must be running. If PowerShell refuses
  `pnpm` with "running scripts is disabled", type `pnpm.cmd` instead; don't change Derrick's
  execution policy without asking him.
- **Branches:** work on a branch named `pc/<topic>` made from `main`, and push it. Merge into
  `main` only when Derrick asks. Never force-push `main`.
- **Never commit:**
  - `.env` and `.env.local`;
  - anything under `.data/` or `data/raw/`;
  - Derrick's real farm data (boundaries, landlords, customers, parcels with owner names);
  - vendor tokens or recorded responses that still contain secrets.

  Real data stays in the database and the gitignored folders.
- **Checks before every push:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:db`,
  `pnpm build`, plus the e2e specs you touched (`pnpm exec playwright install chromium` once).
  Unit tests must pass with **no** env files, as on CI.
- **Match the code:** keep the existing style and seams. Config is read only in
  `src/config.ts`, and only `src/platform/**` may import `@supabase/*`. Every job is an
  idempotent HTTP call.
- **Recording what you did:** when you finish a task, add a dated entry under
  `## PC findings` in `docs/status.md` (create the heading if missing) saying what you ran, what
  happened and what you changed, then commit and push. The cloud agent reads that file.

## 1. Get the demo running

```powershell
cd C:\dev\farm-manager
git fetch origin
git checkout main
git pull
pnpm install
pnpm run bootstrap
pnpm dev
```

Expect:
- **Bootstrap** ends with "Ready." and a summary. A first run downloads the database image
  (1-3 minutes) and the offline basemap. On an install that already has M0, it applies
  migrations `0003`-`0006` and adds the M1 demo data; one that already has M1 gets just the new
  ones (`0006`). No `pnpm db:reset` is needed.
- **`pnpm dev`** prints an **Owner** link the first time (`http://localhost:3000/login/setup?code=…`).
  Tell Derrick to open it on the PC and set his name and PIN; don't pick a PIN for him.
- **The board** is at `http://localhost:3000/board`: fields around Adrian and Blissfield, the
  combines and semis moving, the weather strip and the layer rail.

Then walk the README section **"M1 demo (what to look at)"** with Derrick. For the wall kiosk
and phones, follow README **"First run: sign in"** and `docs/kiosk.md`.

If bootstrap or dev fails, read the message: most come with the fix. The README
**"Troubleshooting"** table covers Docker not running, ports in use, a database password
mismatch, OneDrive and the firewall. Fix real bugs in code on a `pc/` branch.

## 2. Verify what the cloud could not

Do these with Derrick at the PC. Record each result in `docs/status.md`.

| # | Check | How | Pass when |
|---|---|---|---|
| 1 | Real basemap | `pnpm gis:basemap --refresh` | It downloads a Protomaps extract (no "synthetic test basemap" badge on the board) and the board shows real roads and town names |
| 2 | Live weather | In `.env.local` set `CONNECTOR_WEATHER=live` and `NWS_USER_AGENT="farm-manager (<Derrick's email>)"`, then restart `pnpm dev` | The strip shows a real NWS forecast for the demo fields within a few minutes, and `/admin/connectors` shows the weather stream OK |
| 3 | Real soils | `pnpm gis:soils` (NRCS Soil Data Access, Lenawee MI091 and Monroe MI115) | It finishes without errors; tapping a field's **Soils** tab shows real map units with percentages summing to about 100 |
| 4 | NAIP close-ups | `pnpm gis:naip` | It builds the AOI imagery; the aerial-photo layer shows sub-meter photos offline |
| 5 | Ctrl+C on Windows | Stop `pnpm dev` with Ctrl+C, then run `Get-CimInstance Win32_Process -Filter "Name='node.exe'" \| Where-Object CommandLine -like '*farm-manager*'` (a bare `Get-Process node` also lists other Node apps, such as Claude's plugins) | It lists nothing: no node processes are left from the app, the clock or the stand-in |
| 6 | Production build | `pnpm pilot`, then repeat demo steps 3-4 | Same behaviour as `pnpm dev` |
| 7 | Phone on shop Wi-Fi | Open `http://<pc-ip>:3000/m` on a phone; if blocked, add the firewall rule `pnpm dev` prints | The phone shows the same machines as the wall within 2 seconds |
| 8 | Wall kiosk | The two PowerShell commands on `/admin/devices` ("On this PC (wall kiosk)") | The kiosk opens straight onto the board, not the sign-in page |
| 9 | Offline | Unplug the router's internet (WAN) cable while the PC and phone stay on Wi-Fi | Everything works except the online aerial photos, which say "offline" |
| 10 | Windows tests | `pnpm test`, `pnpm test:db`, `pnpm test:e2e e2e/m1-demo.spec.ts --project=wall` | All pass on the PC |

When a real service answers differently from the fixtures the cloud built against, fix the
loader or client so it handles the real response. Also update the fixture so the cloud's tests
stay honest:
- keep it small;
- strip anything private;
- add a note on where it came from.

## 3. Building that needs the PC

Take these in order. Check `docs/status.md` first, in case the cloud agent already built part
of one.

1. **Slice 1e: lidar and crop history** (plan §5 rows for 3DEP, CDL and Crop Sequence
   Boundaries; plan §6 1e).
   - The heavy GIS work runs here by design. It uses the GDAL and pmtiles containers in Docker
     and the `gis_work` volume, and downloads about 18 GB of lidar for both counties (only the
     tiles touching the area of interest).
   - If the cloud has built the loaders (`pnpm gis:dem`, `pnpm gis:cdl`, `pnpm gis:csb`), run
     them on the real data and fix what breaks.
   - If not, build them per the plan, with small test fixtures. Mind the plan's warning about
     Lenawee's mixed UTM zones 16 and 17 (warp every tile to EPSG:3078 before mosaicking).
   - Done when the plan's 1e done-when holds on the PC.
   - **Then, in the same branch or a `pc/soils-b` branch: soil properties (soil map Phase B).**
     Extend `gis:soils` to pull, per map unit, the properties Derrick's research
     (`docs/research/soil-types-and-prescriptions.md`) says the soil map and a future
     prescription engine need:
     - from `muaggatt`: drainage, hydrologic group, flooding, water-table depth, AWS;
     - from `component`: slope, hydric, capability class;
     - depth-weighted 0-30 cm horizons: OM, pH, CEC, AWC, sand/silt/clay and texture class;
     - subsoil pH: Blount and Del Rey run acid, which changes lime targets;
     - NCCPI corn, soybean and small grain.

     Rules:
     - Key everything to `mukey`, never series names (Lenawee's 1961 survey uses legacy names).
     - An empty SDA response is a failure, not "no data".
     - Stay under SDA's 100,000-row cap per query.
     - Record the survey save date and re-pull when it changes.
     - Label every value "typical for these soils, not a soil test" wherever it's shown.

     Schema goes in `db/pending/pc-soils-b.sql`; the cloud folds it into a migration. Report
     which interpretations are actually rated in MI091 and MI115.
2. **Derrick's own data** (stays local, never committed):
   - his Operations Center boundary export: `pnpm import:boundaries <file>`;
   - crop history: `pnpm import:seasons <csv>`, with the template in `tools/import/templates/`;
   - landlords and customers: **/admin/parties**;
   - parcel files from the counties: `pnpm gis:parcels <file>`.

   When his fields are in, hide the demo farm with **/admin/fields → Hide demo fields**.
3. **Deere sandbox (slice 1f)**, once Derrick has a Deere developer account.
   - The OAuth sign-in redirects to the PC, so it has to happen here.
   - Follow plan §5 for Deere and §6 1f: switch `CONNECTOR_DEERE=sandbox`, connect, then
     confirm fields, machines and flags appear.
   - Record scrubbed fixtures with `pnpm connectors:record` if it exists (or build that
     command per plan §5) so the cloud's tests match real Deere responses.
   - Never point the PC at Derrick's production Deere organization without his say-so.
4. **Wall PC hardening (slice 1g):** start the kiosk on boot with Task Scheduler, reload it when
   realtime has been stale for more than 5 minutes, and set the display's sleep and Windows
   Update hours. Use `docs/kiosk.md` for the details and write the runbook steps into it.

## 4. When you stop

- Push your branch.
- Update `docs/status.md` with your entry under "PC findings" and the next open item.
- Give Derrick a short summary: what works, what failed and was fixed, what still needs him.
