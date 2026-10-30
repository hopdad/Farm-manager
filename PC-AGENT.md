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
  migrations `0003`-`0005` and adds the M1 demo data; no `pnpm db:reset` is needed.
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
