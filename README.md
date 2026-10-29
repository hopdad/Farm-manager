# Farm Ops

Farm Ops is the operations software described in [`farm-ops-software-spec.md`](farm-ops-software-spec.md):
one database keyed on fields, machines and jobs, fed by John Deere Operations Center, the trucks'
ELD (Samsara or Motive) and public data, and shown on a touch "war-room" map on the shop wall and
on phones. Until it is solid it runs entirely on your Windows PC with Docker Desktop: Next.js on
Node, Supabase's own Postgres image in Docker, and a local **vendor stand-in** that answers like
Deere and Samsara for one simulated farm (40 fields around Adrian and Blissfield, 2 combines, 2
grain carts, 4 semis, 3 elevators), so the real connector code runs without any vendor account.
The plan is [`docs/build-plan.md`](docs/build-plan.md); the code-level agreements are
[`docs/contracts.md`](docs/contracts.md). This is milestone **M0**: a moving war-room map with
every seam in place.

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
git checkout claude/m0-foundation   # until M0 is merged into main
pnpm install
pnpm run bootstrap   # one time, safe to re-run (`setup` is a built-in pnpm command, so it isn't named that)
pnpm dev             # app + clock + vendor stand-in -> http://localhost:3000/board
```

`pnpm run bootstrap` checks Node, Docker, the ports and the folder; writes `.env` (database
password and port) and `.env.local` (app secrets and URLs, plus the M0 demo tuning); starts the
database (the first boot takes 1-3 minutes); migrates; seeds the demo farm; downloads the offline
basemap (a Protomaps extract of SE Michigan plus its fonts and sprites); connects the simulated
Deere account; and prints the board, admin and phone URLs. It only does what's missing.

To get a new slice later: `git pull`, `pnpm install`, `pnpm run bootstrap`, `pnpm dev`.

## Daily commands

| Command | Does |
|---|---|
| `pnpm dev` | The vendor stand-in, `next dev` on all addresses (phones on the Wi-Fi can reach it) and the job clock. Each start begins the simulated harvest day afresh at 8:30 a.m., when every machine is at work. Ctrl+C stops everything. |
| `pnpm dev --scenario=spray-windy --speed=30` | Another scenario (`harvest-day`, `planting-day`, `spray-windy`, `breakdown`, `bad-morning`, `winter-idle`); `--speed=30` runs a farm day in about 30 minutes. `--from-start` begins harvest-day at its 7:00 a.m. start, `--resume` continues the saved sim day, `--no-clock` starts without scheduled jobs, `--port=<n>` another port. |
| `pnpm pilot` | The production build (`next build` + `next start`) with the same stand-in and clock: the wall display and phones. `--skip-build` reuses the last build. |
| `pnpm clock` | The job clock on its own. Its pause toggle is on `/admin/connectors`. |
| `pnpm run bootstrap` | Re-run after `git pull`: new migrations, missing env keys, the basemap. |
| `pnpm db:reset` | Rebuild the app schemas and re-seed the demo farm (never touches the `postgres` database's Supabase objects). |
| `pnpm db:nuke` | Delete the local database volume and start clean (re-runs the image's init). |
| `pnpm db:down` / `pnpm db:up` | Stop / start the database container; data stays. |
| `pnpm gis:basemap` | Fetch or refresh the offline basemap (`--refresh` for the newest build). |
| `pnpm sim:scenario harvest-day --speed 60 --assert` | Run a scenario day headless and check it. |
| `pnpm test` / `pnpm test:db` / `pnpm test:e2e` | Unit tests / database tests / Playwright (starts `pnpm pilot` itself, or uses the app already on port 3000). |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | What CI runs. |

## Ports

| Port | What | Reachable from |
|---|---|---|
| 3000 | the app (`PUBLIC_URL` in `.env.local`) | the LAN: phones and the wall display |
| 4010 | vendor stand-in (`VENDOR_SIM_URL`) | this PC only (loopback) |
| 15432 | Postgres (`DB_PORT` in `.env`) | this PC only (loopback) |
| 3443 | `pnpm pilot:https` (slice 2c, not in M0) | the LAN |

## Pages

- `http://localhost:3000/board`: the war room (wall display, touch: pan, pinch, rotate).
- `http://<pc-ip>:3000/m`: the phone view (bootstrap and `pnpm dev` print the exact URLs).
- `http://localhost:3000/admin/connectors`: sync health, the job clock, and the simulation
  controls (pause, speed, scenario, fault toggles). No sign-in in M0 (slice 1a adds it), so the
  admin pages are locked until you open the **Admin** link `pnpm dev` (or `pnpm pilot`) prints,
  `http://localhost:3000/admin/unlock?key=…`, once in that browser on the PC. Phones and other
  computers on the Wi-Fi can open `/board` and `/m` but not the admin pages.
- `http://<pc-ip>:3000/api/health`: phone check; it should show `"ok":true`.

## M0 demo (what to look at)

1. `pnpm dev`, then open `http://localhost:3000/board` (for the wall:
   `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --user-data-dir=$env:LOCALAPPDATA\farm-kiosk http://localhost:3000/board`).
2. The offline basemap with town and road labels, and about 40 demo fields coloured by tenure
   (owned, cash rent, share, custom work) around Adrian, Blissfield, Deerfield, Petersburg and
   Dundee. The simulated day opens at 8:30 a.m. in harvest-day: combines C1 and C2 harvesting,
   the semis S1-S4 hauling to the elevators, and the grain carts GC1 and GC2 showing up each
   time they unload a combine or dump into a truck (Deere reports a machine's position only
   while it is working, so carts move in bursts). Markers glide between updates (trucks every
   5 s, Deere every 15 s in the demo). **30x** on `/admin/connectors` speeds the day up.
3. On `/admin/connectors` (first open the **Admin** link `pnpm dev` printed; it unlocks the admin
   pages in that browser):
   - **Pause simulation**: every machine freezes in place and stays fresh (no stale badge).
     **Resume simulation**: they move again.
   - **trucks API down**: within about a minute the four semis turn grey and the board shows
     "4 stale"; the combines keep updating (Deere is still up). Turn it off: the trucks catch up
     within seconds.
4. A phone on the same Wi-Fi at `http://<pc-ip>:3000/m` shows the same trucks as the wall within
   2 seconds. Do it again under `pnpm pilot` (Ctrl+C `pnpm dev` first).
5. Unplug the router's internet (WAN) cable, keep the PC and the phone on the LAN (on the phone:
   Wi-Fi on, mobile data off): the basemap, the fields and the fleet keep running.
6. CI is green (the repository's Actions tab), and locally `pnpm lint`, `pnpm typecheck`,
   `pnpm test`, `pnpm test:db`, `pnpm build` and `pnpm test:e2e` pass.

The same demo runs as an automated test: `pnpm test:e2e e2e/m0-demo.spec.ts --project=wall`
(about 4 minutes; it restarts harvest-day from 7:00 a.m. at 30x, and puts the simulation back
afterwards).

The demo tuning `pnpm env:init` writes into `.env.local` (`JOBS_DEMO_CADENCE=on`,
`FLEET_STALE_SECONDS=60`, `FLEET_STALE_SECONDS_DEERE=900`) makes this quick. Delete those lines
for the plan's defaults (trucks every 30 s, stale after 10 minutes).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Docker running FAIL` in bootstrap, or `pnpm db:up` hangs | Start Docker Desktop and wait until it says *Engine running*, then re-run `pnpm run bootstrap`. Check *Use the WSL 2 based engine* is on. |
| `port 3000 is in use` / `port 15432 ... in use by another program` | Find the owner: `Get-NetTCPConnection -LocalPort 3000 \| Select-Object OwningProcess`, then `Get-Process -Id <pid>`. Stop it (an old `pnpm dev`, another Postgres), or move the app: `PUBLIC_URL=http://localhost:3001` in `.env.local` (database: `DB_PORT` in `.env` and the port in both database URLs in `.env.local`). |
| `the postgres password in .env does not match the database volume` (or `.env` missing but the volume exists) | Restore your old `.env`, or start clean: `pnpm db:nuke` (deletes the local database), then `pnpm run bootstrap`. |
| Folder under OneDrive | Bootstrap refuses it. Clone to `C:\dev\farm-manager` and run there. |
| Phones can't open `http://<pc-ip>:3000/m` | Set the shop Wi-Fi profile to *Private* and allow Node.js on private networks when Windows asks, or once in an **admin** PowerShell: `New-NetFirewallRule -DisplayName 'farm-ops dev' -Direction Inbound -Protocol TCP -LocalPort 3000,3443 -Profile Private -Action Allow`. Pick the PC address of the Wi-Fi adapter from the list `pnpm dev` prints. If the PC's address changed, `pnpm env:init --refresh-origins` and restart `pnpm dev`. If you dismissed the Windows prompt (Cancel or No), Windows created Block rules for Node.js, and block rules beat any allow rule: remove them first in an **admin** PowerShell, `Get-NetFirewallRule \| Where-Object { $_.Name -like '*Query User*' -and $_.Name -like '*node.exe*' -and $_.Action -eq 'Block' } \| Remove-NetFirewallRule`, then add the Allow rule above. |
| `port 3000 is reserved by Windows`, `listen EACCES: permission denied 0.0.0.0:3000`, or Docker's `bind: An attempt was made to access a socket in a way forbidden by its access permissions` | The port sits in a range Windows reserved for Hyper-V/WSL/Docker (`netsh interface ipv4 show excludedportrange protocol=tcp` lists them). Pick a port outside them (`PUBLIC_URL` in `.env.local` for the app, `DB_PORT` in `.env` plus both database URLs for Postgres, `VENDOR_SIM_URL` for the stand-in), or release the reservations once in an **admin** PowerShell: `net stop winnat`, then `net start winnat`. |
| `offline basemap missing, run pnpm gis:basemap` | The Protomaps download failed. Check the internet connection and run `pnpm gis:basemap`. Behind a corporate proxy: `$env:NODE_USE_ENV_PROXY=1`, then `pnpm gis:basemap`. To carry on without it: `pnpm run bootstrap --synthetic-basemap` installs a small made-up test basemap (the board badges it; a later plain bootstrap replaces it). |
| `running scripts is disabled on this system` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then open a new PowerShell. |
| Wrong Node version at `pnpm install` | Install Node 24 (see Prerequisites), open a new PowerShell, `pnpm install`. |
| `/admin/connectors` says "Admin is locked" | Open the **Admin** link (`http://localhost:3000/admin/unlock?key=…`) that `pnpm dev` or `pnpm pilot` printed, in the same browser. `pnpm run bootstrap` prints it too. |
| The board shows "Fleet unavailable" or nothing moves | Is `pnpm dev` still running, and is the job clock running on `/admin/connectors` (not paused)? The simulation may be paused there too. |
| A page keeps reloading under `pnpm dev` | A Next 16 dev-cache glitch after `pnpm pilot` built the app; `pnpm dev` now clears `.next\dev` itself when a production build ran since its last start. If it still happens: Ctrl+C, `Remove-Item -Recurse -Force .next\dev`, `pnpm dev`. |

## Where things are

- `src/app`: pages and API routes (`board`, `m`, `admin`, `api/*`); `src/ui`: the map and board.
- `src/sim`: the simulated farm and scenarios; `src/sim/vendors` + `tools/vendor-sim`: the
  vendor stand-in. `src/connectors`: the Deere, Samsara and Motive clients and the sync step;
  `src/jobs`: scheduled jobs.
- `db/migrations`: SQL for both your PC and Supabase. `scripts/` and `tools/`: bootstrap, the
  launchers, the clock, GIS and seed tools. `e2e/`: Playwright specs.
- Local data lives in `.data/` and the Docker volume; real farm data is never committed.
