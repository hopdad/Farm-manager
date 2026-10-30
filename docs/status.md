# Build status

Oct 29, 2026, evening. Update this file at the end of each build session.

## Branches

| Branch | State |
|---|---|
| `main` | M0 + M1 (slices 1a-1d), merged from `claude/m1-see-it` on Oct 30 at `393e5b9`. Work from here; the PC agent follows `PC-AGENT.md`. |
| `claude/m0-foundation` | M0 done. CI green on Linux, Windows and e2e at `7f492dc`. |
| `claude/m1-see-it` | M1 slices 1a-1d built, reviewed (36 findings fixed) and verified on an M0 upgrade. CI fully green at `4492708` (Linux, Windows, e2e and e2e in replay mode). Then the polish commits (see below). |
| `claude/m0-win-debug` | Temporary diagnostic branch. Safe to delete on GitHub. |

## Finished after the save

The M1 verifier's polish items are done (commits `8d629f3`..`f4dfe72`, on top of the two WIP commits): the wall kiosk enrolls on a localhost link from /admin/devices with exact PowerShell commands; README "Coming from M0" (three migrations, no `db:reset`); a plain bootstrap keeps an installed synthetic basemap; the stale reset-owner note; the way back from `--hide-demo`; the seasons example now fills the imported prospect fields. Lint, typecheck, unit (also in a clean clone with no env files), DB tests, build and the auth/M1/M0 e2e specs passed locally. Full GitHub CI on the new head was started on Oct 30.

## Not verifiable from the cloud build machine

Its proxy blocks these, so they still need a check on the Windows PC: the real Protomaps basemap, live NWS weather (`CONNECTOR_WEATHER=live`), real SSURGO soils (`pnpm gis:soils`), NAIP close-ups (`pnpm gis:naip`).

## Next

- Derrick's demos on the PC: M0 (README "M0 demo"), then M1 (README "M1 demo").
- Open decisions with their current defaults: `docs/decisions.md`.
- Then M1 slices 1e (lidar, crop history), 1f (live connectors, sync health) and 1g (replay, hardening), per `docs/build-plan.md` §6.

## PC findings

### Oct 29, 2026: PC-AGENT.md section 1 and section 2 checks (Derrick's PC, branch `pc/section2-checks`)

Setup notes (section 1):
- Derrick's first copy was a GitHub "Download ZIP" on the Desktop (no `.git`); recloned to `C:\dev\farm-manager` per README. Contents matched `main` at `8d15699`.
- Global pnpm was 9.15.4, which fails with "packages field missing or empty" on our `pnpm-workspace.yaml`; upgraded to 12.16.1 (`npm i -g pnpm@12.16.1`).
- PowerShell's default execution policy blocks npm's `pnpm.ps1` shim ("running scripts is disabled"). `pnpm.cmd` works without touching the policy. Worth a README Troubleshooting row.
- First bootstrap failed mid image pull with `unexpected EOF` because Docker Desktop restarted to self-update; bootstrap blamed "is port DB_PORT free?", which was misleading. Rerun after Docker came back: "Ready." with the M1 demo data.

Section 2 results:
1. **Real basemap: pass.** Bootstrap's `gis:basemap` fetched a real Protomaps extract (build `20261029.pmtiles`, 24.5 MB, bbox -84.45,41.65,-83.1,42.15, maxzoom 15). Derrick confirmed real roads and town names and no synthetic badge on the board.
2. **Live weather: pass.** `CONNECTOR_WEATHER=live` plus a real `NWS_USER_AGENT` in `.env.local`. The first live `weather.nws` run: 33 DTX grid cells, 33 forecasts, 31 observations, 520 spray assessments, no error. Derrick confirmed the strip and `/admin/connectors`. Real-vs-fixture finding: NWS gridpoint forecasts are often several hours old (`forecastIssuedAt` 20:24Z at 01:07Z = 283 min), so the `forecast_stale` caution (threshold 120 min) fires on every hour with live data. Not changed; needs a decision (raise the threshold, or measure age from NWS `generatedAt` instead of `updateTime`?). Tonight's no-go verdicts were real (gusts 19.6 mph > 15).
3. **Real soils: pass.** `pnpm gis:soils`: MI091 201 map units / 21,724 polygons, MI115 80 / 9,721; 281 new map units, 31,445 polygons, 14 units and 605 polygons of the synthetic set retired. All 40 demo fields sum to 100.0%. Derrick confirmed the Soils tab.
4. **NAIP close-ups: pass.** `pnpm gis:naip`: 10,723 tiles at z12-17 for the demo boundaries + 1 mile, 91.3 MB, installed `tiles/naip/aoi.1c077748.pmtiles`; the online layer registered. Derrick confirmed sharp close-ups on the aerial layer.
5. **Ctrl+C on Windows: pass.** Derrick pressed Ctrl+C in the `pnpm dev` terminal: "[dev] stopping", vendor-sim and clock shut down on SIGINT, ports 3000/4010 free, no node process with `farm-manager` in its command line left. Notes: a bare `Get-Process node` also lists unrelated node apps (here Claude desktop plugins), so judge by command line. Run via `pnpm.cmd`, cmd adds a "Terminate batch job (Y/N)?" prompt after the app has already stopped; harmless.
6. **Production build: pass.** `pnpm pilot` built and served (`next start`, first build ~10 min on this PC including a long quiet stretch before "Compiled"; the cached rebuild took seconds). Demo steps 3-4 behaved as under `pnpm dev`. Note: with `CONNECTOR_WEATHER=live`, demo step 4 (simulated wind on /admin/spray) can't change the board, because the app isn't reading the stand-in (the action says so). Weather was put back to `sim` for steps 3-4.
7. **Phone on shop Wi-Fi: pass.** `http://192.168.4.107:3000/m` on Derrick's phone under `pnpm pilot`. Amy's demo PIN; Down on a combine reached the wall within 2 s; Back up worked.
8. **Wall kiosk: pass.** The two commands from /admin/devices "On this PC (wall kiosk)" (Chrome in `C:\Program Files`): enrolled as Shop wall, then `--kiosk` opened straight onto the board.
9. **Offline: pass.** Router WAN unplugged with the PC, wall kiosk and phone on shop Wi-Fi under `pnpm pilot`: the board, phone and offline layers kept working; only the online aerial photos said "offline".
10. **Windows tests: pass after one fix.** First run: lint and typecheck OK; `pnpm test` 1 failure, `pnpm test:db` 2 failures.
    - **Fixed: Windows-1252 CSV decoding.** `tools/import/parties-csv.test.ts` failed with `'José O\u0092Brien'`: Node 24.13.0's `TextDecoder('windows-1252')` (on this PC; `.encoding` still says `windows-1252`) decodes 0x80-0x9F as ISO-8859-1, so an Excel-saved parties or seasons CSV would import with curly quotes, en dashes, € and ™ as invisible C1 controls. `decodeCsvBytes` (`tools/import/csv.ts`) now maps 0x80-0x9F with the WHATWG table itself (checked against Python's cp1252) and no longer relies on the Node build; new unit test over the whole range.
    - `test:db`'s 2 failures (a `farm.weather_forecasts` count in a weather test) happened once, right after `pnpm pilot` was stopped; 4 later runs were 305/305. Likely the closing pilot's weather job writing to the same database; not reproduced, not changed.
    - Final: lint, typecheck, `pnpm test` (1,294 passed, 2 skipped), `pnpm test:db` (305), `pnpm build`, and `pnpm test:e2e e2e/m1-demo.spec.ts --project=wall` (5/5; phone→wall 114 ms; tap→panel 23-39 ms) all pass.

Left as found: `.env.local` has `NWS_USER_AGENT` set and `CONNECTOR_WEATHER=live` commented out (weather back on sim for the demo).

Next open items: decide the `forecast_stale` threshold for live NWS (check 2); README Troubleshooting rows for pnpm 9 ("packages field missing or empty") and PowerShell's execution policy blocking `pnpm.ps1`; then PC-AGENT.md section 3 (slice 1e lidar and crop history).
