# Build status

Nov 6, 2026. Update this file at the end of each build session.

## Branches

| Branch | State |
|---|---|
| `main` | M0 + M1 (slices 1a-1d), the e2e flake fixes, the follow-up to the PC checks (`claude/pc-followups`, below), the soil type map (`claude/soil-map`, merged Oct 31, below) slices 1f + 1f.2 (`claude/m1-1f`, merged Oct 31, below), and on Nov 3 the nightly CI fix, the date sweep and D23, "this season" follows the growing year (`claude/fix-clock-tests`, `claude/date-fixes`, `claude/growing-year`, below). Work from here; the PC agent follows `PC-AGENT.md`. |
| `claude/m2-2a` | **Slice 2a (job board + drag-to-assign), in progress.** From `main` at `729dd7c`. The foundation stage is done (Nov 6, below): `docs/contracts-2a.md`, migration `0008_m2a_job_board`, the shared seams and stubs, the demo jobs. Next: the four builders (`m2a/jobs-api`, `m2a/board`, `m2a/job-forms`, `m2a/rights-usage`) in worktrees off this branch, then the integration. Not pushed yet. |
| `claude/growing-year` | D23, "this season" follows the growing year, and its review fixes (5 of 8 findings confirmed and fixed). CI fully green at `801a616` (run 86: Linux, e2e with the replay step, Windows). Fast-forwarded into `main` on Nov 3. Safe to delete. |
| `claude/date-fixes` | The Nov 3 date sweep: boundary dates in the farm's time zone, replay crop years. Merged into `main` on Nov 3 (CI green on Linux and Windows). Safe to delete. |
| `claude/fix-clock-tests` | The fix for the Nov 2 nightly CI failure (`832bec9`). Merged into `main` on Nov 3. Safe to delete. |
| `claude/m1-1f` | Slices 1f and 1f.2: seven builders, integration, two review rounds (20 findings: 14 fixed, 6 rejected with reasons) and two CI test fixes. CI fully green at `3b951d4` (run 70: Linux, e2e with the replay step, Windows). Merged into `main` on Oct 31. Safe to delete. |
| `claude/1f-followups` | After the 1f merge: the sim Deere grant fix, two e2e timing fixes, and these docs (PC-AGENT round 2, status, README). CI fully green at `1dc586c` (run 74: Linux, e2e with the replay step, Windows). Fast-forwarded into `main` on Oct 31. Safe to delete. |
| `claude/soil-map` | Soil type map Phase A. Two reviews (12 findings, all fixed); CI fully green at `44d7779`; merged into `main` on Oct 31. Safe to delete. |
| `claude/pc-agent-docs` | PC-AGENT.md round 2 docs, already in `main`. Safe to delete. |
| `claude/pc-followups` | Derrick's `pc/section2-checks` plus the cloud follow-up to its findings (below). CI fully green at `3f5976e`; merged into `main` on Oct 30. Safe to delete. |
| `pc/section2-checks` | The PC agent's section 2 results and its Windows-1252 CSV fix. Merged through `claude/pc-followups`; safe to delete. |
| `claude/m0-foundation` | M0 done. CI green on Linux, Windows and e2e at `7f492dc`. |
| `claude/m1-see-it` | M1 slices 1a-1d built, reviewed (36 findings fixed) and verified on an M0 upgrade. CI fully green at `4492708` (Linux, Windows, e2e and e2e in replay mode). Then the polish commits (see below). |
| `claude/fix-e2e-flakes` | The two e2e failures of CI run 25 (see below). Merged into `main`; safe to delete. |
| `claude/m0-win-debug` | Temporary diagnostic branch. Safe to delete on GitHub. |

## Finished after the save

The M1 verifier's polish items are done (commits `8d629f3`..`f4dfe72`, on top of the two WIP commits): the wall kiosk enrolls on a localhost link from /admin/devices with exact PowerShell commands; README "Coming from M0" (three migrations, no `db:reset`); a plain bootstrap keeps an installed synthetic basemap; the stale reset-owner note; the way back from `--hide-demo`; the seasons example now fills the imported prospect fields. Lint, typecheck, unit (also in a clean clone with no env files), DB tests, build and the auth/M1/M0 e2e specs passed locally. Full GitHub CI on the new head was started on Oct 30.

## CI run 25's e2e failures (Oct 30, `claude/fix-e2e-flakes`)

- `weather.spec.ts` "wind slider", the empty admin notice: a real UX bug. The admin forms took their notice from useActionState, which React commits only with the action's whole router transition (the page revalidatePath re-renders into the response, plus any router refresh started meanwhile, such as LiveRefresh's on the realtime events the action itself causes). On a busy machine the answer arrived in ~150 ms and the notice 5 to 15 s later. Every admin form now reports the answer from the submit itself (`src/app/admin/_components/controls.tsx`; /admin/people and /admin/devices use the same controls), and says so when the server can't be reached. The spec reproduces the old failure on purpose in its last step (a refresh held behind the action) and allows the server round trip 20 s.
- `imagery.spec.ts` "tile lines": never three software-WebGL boards at once (the viewer's board is checked and closed before the second manager's opens); the M0 demo closes its phone map when its test ends.

Lint, typecheck, unit (also in a clean clone with no env files), DB tests, build, both specs 5 times each on the wall project, the M0 and M1 demo specs and the full e2e suite (106 passed, 36 skipped) passed locally against `pnpm pilot --skip-build`.

## Not verifiable from the cloud build machine

Its proxy blocks the real Protomaps basemap, live NWS weather, real SSURGO soils and NAIP close-ups. All four passed on Derrick's PC on Oct 29 (PC findings below). Live weather needs one re-check after the staleness change (Next).

## Nov 6, 2026: slice 2a started (`claude/m2-2a`, foundation)

The job board and drag-to-assign (plan §6 M2 2a), built like 1f: one foundation stage, then four
parallel builders (jobs-api, board, job-forms, rights-usage), then the integration. The contract
is `docs/contracts-2a.md`; its decisions are rows 2a-1 … 2a-13 in `docs/decisions.md`
(defaults, easy to change). What the foundation landed:

- **Migration `0008_m2a_job_board`:** `farm.products`, `farm.jobs` (with `version` for
  optimistic concurrency and `planned_window`, the plan's `window`), `farm.job_assignments`,
  `farm.job_products`, `farm.data_rights_agreements`, `farm.job_request_links` and
  `app.usage_events`, mirrored in `src/db/schema/{farm,app}.ts`. The jobs **publish triggers**
  come from the jobs-api builder (`db/pending/jobs-api.sql`) and will be folded into the next
  migration (likely `0009`). **Slice 1e on the PC takes the next free number after those**
  (PC-AGENT.md).
- **Seams:** the vocabulary and the status-machine signatures (`src/domain/work-jobs.ts`), the
  API contract (`src/ui/work/contract.ts`, every route under `/api/v1/**`, all answering 501
  until their builder lands), `ROLE_FOR.planJobs` (manager) and `updateOwnJobStatus` (driver),
  the `jobs` realtime topic, `@dnd-kit/core` 6.3.1 and `@dnd-kit/utilities` 3.2.2, the job
  board's mount in BoardScreen (an empty jobs band on the wall, an inert "Jobs" pill on phones),
  a hidden Jobs tab in the field panel, `/admin/products` and `/admin/usage` (stubs, in the nav),
  the usage writer already called from `/board`, `/m` and the PIN sign-in, the Deere data-rights
  gate already called in the four per-org loops (allows everything until rights-usage lands),
  `/r/<token>` as a public path, `e2e/support/drag.ts` (trusted CDP touch drags), `data:export`
  of the new tables, the `usage.prune` job (stub), the machine chips' "Deere" badge field.
- **Demo seed:** 8 products, 10 jobs across the four lanes (an unassigned spray job on a
  Halvorsen field and a phoned-in request with no field yet, for the done-when; SP2 left free),
  the Halvorsen data-rights agreement. After pulling: `pnpm db:migrate` and `pnpm db:seed demo`.
- **MD note:** the `realtime.messages` RLS policies must cover the new `jobs` topic.

## Nov 3, 2026: nightly CI red from Nov 2, and a date sweep

The nightly runs of Nov 2 and 3 (77, 78) failed three storage writer unit tests on Linux and
Windows: a test pinned its clock at 2026-11-02 12:00 UTC while two calls used the real clock, so
its 2 h upload grants read expired once the real date passed. Fixed on `main` (`832bec9`, CI green
on Linux and Windows), together with the conformance test, which would have failed from Jan 1
(the Deere stand-in has no new-season operations before the spring planting).

A sweep for anything else that breaks on a coming date: the unit suite at shifted clocks (-30
days to +3 years; nothing else), and four reviewers over the DB tests, the e2e specs and the stand-in,
and product code (crop-year rollover, the 2027 clock changes). Fixed on `claude/date-fixes`:

- The field panel's boundary "since" date and two boundary-conflict messages took the UTC date, a
  day ahead every evening from 7 PM (8 PM in summer): a boundary saved Dec 31 at 8 PM read "since
  Jan 1". `farmDate()` (`src/domain/farm.ts`) gives the farm's date.
- Replay fixtures can name `cropYearKeys`: a 4-digit year there moves by whole crop years with the
  anchor. The Deere operations fixtures use it for `cropSeason`, so a 2027 replay serves 2027's
  operations (it said 2026 forever). `e2e/m1f-replay.spec.ts` now checks rows only replay writes,
  not sim leftovers on CI's shared database.

Decided by Derrick the same day (D23, "the season should follow the growing year") and built on
`claude/growing-year`: an operation keeps the crop season Deere gives it; a field's "this season"
is the newest of the two synced seasons with operations on it (so in January it is still last
season, and a field seeded to wheat in October moves to next year by itself); `deere.ops` syncs
two seasons (Jan-Jul last season and this one, Aug-Dec this one and next) with the budget cap
counting both listings; the stand-in files the scenario's work under the season being harvested
and each season's plantings under that season, so the demo and `e2e/deere-ops.spec.ts` hold all
year. Replay's `cropYearKeys` now move at Aug 1 too, not Jan 1: a replay in January 2027 serves
2026's operations, as the stand-in does. Review fixes on the same branch: the budget cap measures
a field's cost from the same runs as the fields they checked (it halved down to 1 field after
the change, then overshot the share); the stand-in lists the newer season's plantings (the
October wheat under next year, each field's spring planting under the new season); History
dates show the year when it isn't the season's. CI fully green at `801a616` (run 86: Linux, e2e
with the replay step, Windows); fast-forwarded into `main` on Nov 3. No new migration.

## Oct 31, 2026: slices 1f and 1f.2 (merged into `main`)

What 1f delivered (details: `docs/build-plan.md` 1f "As built", `docs/contracts-1f.md`):

- **Deere** (sim, replay, and the sandbox/live code paths): fields, boundaries (the owning org's
  Deere boundary becomes current, the old one history), farms and customer parties, flags as
  read-only pins (rail toggle, popup on the board and the phone), Equipment API machines with
  engine hours, this crop season's field operations in the History tab (coverage, products,
  machines, operator), the `ag2` scope, org isolation with Deere Connections approval links, the
  home org, the call budget split (`fleet.deere` paced, `deere.ops` capped).
- **Fault codes and stats** in one model (J1939, OBD-II, OEM; snapshot and delta reports, the 24 h
  age-out, OBD-II cleared per module): the fleet panel's fault badge, "Critical fault: mark down?"
  for drivers, vendor + mode badges, hours / odometer / fuel / DEF with "not reported", the kind
  badge, and a Deere machine's last working position (panel, map and board card).
- **Every telematics vendor at once** (1f.2): Samsara (vehicles, faults, the vehicle list, asset
  gateways), Motive, MyGeotab, Terminal, CNH FieldOps (OAuth, its own stand-in), the generic
  ISO 15143-3 client (Kubota, Trackunit, Deere's and Samsara's feeds), Ford and Ram pickups;
  `/admin/vehicles` for kinds set by hand.
- **Sync health:** `/admin/connectors` with calls per source, stream and mode, the budget, the
  Deere grant and scopes, orgs, dead letters (requeue, discard), the capability matrix, the
  doc-derived list and the sim knobs (org approval, truck fault codes); `connectors:record
  --scrub` with a conformance test; `test:live` suites that skip without credentials.
- **Merge work:** migration `0007` holds everything (fleet-faults' pending table became
  `machine_faults.module`); the map's taps run machine > pin > field > soil map unit; `data:import`
  keeps a hand boundary as history under the re-synced Deere one (decision 7); the decision rows
  are in `docs/decisions.md` "Slice 1f merge".

After pulling: `pnpm run bootstrap`. It applies `0007`, re-seeds the demo farm (the mixed fleet)
and replaces a simulated Deere sign-in from before 1f, which lacks `ag2`. By hand instead:
`pnpm db:migrate`, `pnpm db:seed demo`, `pnpm vendor-sim:connect`.

The integrator's last pass found two gaps in the done-when tests and closed them: §B.8.4's
"`CONNECTOR_ELD=replay` shows the alias warning and replays Samsara" had only a test that skips
unless the app runs with that key, and CI set `CONNECTOR_SAMSARA` instead (CI's replay step now
sets Samsara through `CONNECTOR_ELD=replay`, and `e2e/m1f-replay.spec.ts` checks the warning while
Samsara replays); and the replay spec's Deere and Samsara checks could pass on rows the sim suite
had synced before (the sim and replay worlds share their Deere ids; CI runs the replay step after
the sim suite on the same database), so each now waits for its stream's first successful run in
replay.

Checks at the integration head, locally (dev database reset and reseeded on the folded `0007`,
DB test template rebuilt): `pnpm lint` (1021 files) and `pnpm typecheck` clean; `pnpm test` 1958
passed (242 files); `pnpm test:db` 497 passed (78 files); `pnpm build` OK; `pnpm db:lint`
(migrations from zero in a brand-new database, twice; the second run a no-op) PASS; `drizzle-kit
generate`: no schema changes. The full e2e suite against `pnpm pilot --skip-build`, twice, no
retries: 161 passed, 79 skipped, 0 failed each time (15.6 and 15.4 min; the skips are the
phone-project copies of wall-only specs, the replay specs and the alias test under sim, and the
phone-only tests on the wall). CI's replay step exactly as CI runs it (`CONNECTOR_DEERE`,
`CONNECTOR_ELD`, `CONNECTOR_MOTIVE`, `CONNECTOR_GEOTAB`, `CONNECTOR_TERMINAL`, `CONNECTOR_AEMP` =
replay; `fleet-panel-replay`, `fleet-panel`, `m1f-replay`, `trucks-replay`, `pickups-replay`,
wall): 12 passed, twice, the second time straight after the sim suite.

**Review round 1** (correctness, security and vendors, UX; each finding then checked by a separate
agent): 17 findings, 11 confirmed and fixed, 6 rejected as far-fetched or already covered (one
machine with Samsara snapshot faults and another vendor's delta faults at once; a replay e2e that
could pass on failed events, which the replay DB tests already catch; an operation Deere moves to
another field showing under the old one until its next sync; a vendor redirect carrying the API key
to another host; the 72 px touch rule applied to map pins; codes left over on a dev database after a
replay run by hand):

- Fault codes from delta feeds (AEMP, CNH, Terminal, Motive, Geotab) now age out against the time
  each faults run checked through, after a run that caught up: 24 h for a feed with no "cleared"
  signal, a 7-day backstop for feeds that send one. Before, a code that stopped recurring never
  closed, so a stuck critical code kept offering "mark down?".
- Samsara OBD-II codes on any module can clear (an explicit empty list clears them all); a code a
  newer reading leaves out starts the 24 h age-out.
- A Deere machine reads "last working position" only once a successful Deere poll lands 3 min
  or more after its newest breadcrumb, so a working machine no longer flips to idle while it waits
  for the next poll. While the Deere feed fails or goes quiet, no machine reads parked: its machines
  go stale. When the last Deere run failed, the panel and the wall's status strip also say "John
  Deere: not connected since 9:17 AM" (the phone's strip: "John Deere offline").
- The recording scrubber hashes nested ids (Samsara's `externalIds`) and keeps fault vocabulary
  (`spnId`, `fmiId`, `txId`) as sent.
- Faults at a glance: critical, then warning machines lead their group; the panel summary counts
  critical and warning machines and the strip shows "N critical faults"; the wall card shows the
  fault tag; the worst code's meaning is its own line under the badge and the tag (touch screens
  have no hover text).
- The Motive, Geotab and Terminal e2e specs close the codes they raise; a faults stream that
  changes mode closes its source's codes.
- `/admin/connectors` judges each stream against its source's job schedule instead of a flat
  10 min, so a healthy hourly stream no longer reads stale.
- AEMP's last-known positions say "Last known position from Kubota (AEMP)", with no speed or
  heading.

**Review round 2**, on the fixes: 3 findings, all fixed:

- The snapshot guard is now per machine and source (`farm.machine_fault_snapshots`): the stand-in's
  newer readings can no longer hide a live account's older active codes after a switch to live.
- Turning a faults stream off and back on in the same mode brings back the codes the vendor still
  holds as active; a switch to another account (sim, replay, sandbox, live) closes them for good.
- Fast streams (Samsara positions, Deere locations) are judged by the job that runs them, not
  their source's slowest (hourly) job: they read stale 10 min after they stop, not up to 2 h later.

Migration `0007` grew in review (`machine_faults.age_out_seconds` and `closed_by`, the
`machine_fault_snapshots` table), amended in place since it wasn't on `main` yet. Checks at the
reviewed head: lint (1025 files), typecheck, `pnpm test` 1980 passed (244 files), `pnpm test:db`
510 passed (78 files), build, full e2e 161 passed / 79 skipped / 0 failed, replay step 12 passed,
migrations from zero, drizzle generate with no changes. One e2e run before that had a single
failure that passed alone and on the rerun: `deere-fields.spec.ts:256` on the phone (the flag
popup didn't open after a tap). Watch for it.

**CI fixes:** two unit tests that call the stand-in's `machineAt` (it replays the scenario from
its start after each reset, over 5 s on a GitHub runner) get 30 s, and the in-process stand-in now
keeps idle sockets 65 s: at 5 s, a test that blocked the process past 5 s let the server close a
socket just as the next request reused it (ECONNRESET in CI run 68; reproduced locally, 3 resets in
12 before, none after). CI fully green at `3b951d4` (run 70: Linux, e2e with the replay step,
Windows). Its e2e had one test that failed and then passed on the retry: `field-panel.spec.ts:261`
on the wall (tap to panel within 200 ms; the first try hit the 60 s test timeout). The follow-up's
first CI run (72) failed it on every try, and `map-fleet.spec.ts:79` once: both were test timing on
the slower runner, fixed on `claude/1f-followups`. The tap test moves the map six times, about 8 s
a move and tap on CI's software WebGL since 1f put the mixed fleet and pins on the board, so it
now gets 120 s (its budget is the timing measured in the page, unchanged). The marker test stamped
its tick "now", and a glide lasts the gap between two fixes: the board's 15.6 s load made a 15.6 s
glide that outlasted the wait. Its tick is now 5 s after the snapshot fix.

**After the merge:** bootstrap's sim connector step now replaces a stored simulated Deere grant that
lacks a scope the app asks for. A PC connected before 1f has one without `ag2`, so `deere.ops`
(this season's operations) failed on every run after the pull; the doc check for this merge found
it. `tools/vendor-sim/connect.db.test.ts` covers it (fails on the old code).

## Oct 31, 2026: soil type map (Phase A, `claude/soil-map`)

With Soils on, the layer rail's picker colours the soils by soil type (outlines and map unit
symbols; names from zoom 16), drainage (default), hydrologic group, farmland class or
productivity (NCCPI on fixed breaks); switching only repaints. Labels come from
`GET /api/soils/labels` (one point per polygon, the largest inscribed circle's centre, cached per
soils version) from zoom 13. "In this view" lists the map units on screen from zoom 12. A tap
outside any field opens the map unit sheet (`GET /api/soils/mapunits/<mukey>`): key values,
components, the series description as a QR code on the wall kiosk (a link on phones, with a
"no internet" note when the WAN is down). Both routes need a viewer session. No migration.
Phase B (texture, slope, interpretations, OM/pH/CEC) is the PC's, after 1e.

## Next

- On the PC: `PC-AGENT.md` "Round 2" (not started yet), in this order:
  - A: update and bootstrap (migrations `0006` and `0007`; bootstrap re-seeds the demo fleet and
    replaces the old simulated Deere sign-in);
  - B: re-check live weather;
  - B2: soil map walk-through and fleet inventory with Derrick;
  - C: Windows re-checks, now including the soil map (C5, C6) and slice 1f (C7, C8);
  - D: slice 1e on `pc/slice-1e`, pushed in pieces for the cloud to review and fold into the next
    free migration (1f took `0007`, 2a takes `0008` and likely `0009` for its triggers: 1e takes
    the next free number after those when it merges);
  - E: branch cleanup, if Derrick agrees.
- Then Derrick's own data (PC-AGENT.md section 3, item 2).
- **Done (Nov 3, D23):** "this season" follows the growing year, so the History tab no longer
  goes blank from Jan 1 and `e2e/deere-ops.spec.ts` passes all year (`claude/growing-year`, merged
  into `main` Nov 3; see Nov 3 above). The season switcher and the rolling field timeline wait (D23).
- In the cloud, per `docs/build-plan.md` §6 and D22: the war board next (M2 2a job board and
  drag-to-assign, **started Nov 6 on `claude/m2-2a`**: the four builders of
  `docs/contracts-2a.md`, then the integration; then 2b morning meeting, Work Plans and go/no-go
  v1), then the rest of 1g, then 2c, then MD. The Deere season backfill is deferred to after MD.
- Vendors go from stand-ins to real accounts as Derrick's sign-ups land (Deere developer account
  first; PC-AGENT.md section 3, item 3). `connectors:record` knows only Deere and Samsara; CNH's
  README entry asks for a staging recording, so a CNH recorder comes before CNH goes past `sim`.
- Open decisions with their current defaults: `docs/decisions.md` (D4 spray thresholds, D8
  testers and devices). D3 (telematics vendors) was replaced Oct 30 and is built: Samsara,
  Motive, Geotab and Terminal for trucks, Deere, CNH, AEMP and Samsara gateways for machines; what
  connects first waits on Derrick's fleet inventory (PC-AGENT.md B2).

## PC findings

### Oct 29, 2026: PC-AGENT.md section 1 and section 2 checks (Derrick's PC, branch `pc/section2-checks`)

Setup notes (section 1):
- Derrick's first copy was a GitHub "Download ZIP" on the Desktop (no `.git`); recloned to `C:\dev\farm-manager` per README. Contents matched `main` at `8d15699`.
- Global pnpm was 9.15.4, which fails with "packages field missing or empty" on our `pnpm-workspace.yaml`; upgraded to 12.16.1 (`npm i -g pnpm@12.16.1`).
- PowerShell's default execution policy blocks npm's `pnpm.ps1` shim ("running scripts is disabled"). `pnpm.cmd` works without touching the policy. Worth a README Troubleshooting row.
- First bootstrap failed mid image pull with `unexpected EOF` because Docker Desktop restarted to self-update; bootstrap blamed "is port DB_PORT free?", which was misleading. Rerun after Docker came back: "Ready." with the M1 demo data.

Section 2 results:
1. **Real basemap: pass.** Bootstrap's `gis:basemap` fetched a real Protomaps extract (build `20261029.pmtiles`, 24.5 MB, bbox -84.45,41.65,-83.1,42.15, maxzoom 15). Derrick confirmed real roads and town names and no synthetic badge on the board.
2. **Live weather: pass.** `CONNECTOR_WEATHER=live` plus a real `NWS_USER_AGENT` in `.env.local`. The first live `weather.nws` run: 33 DTX grid cells, 33 forecasts, 31 observations, 520 spray assessments, no error. Derrick confirmed the strip and `/admin/connectors`. Real-vs-fixture finding: NWS gridpoint forecasts are often several hours old (`forecastIssuedAt` 20:24Z at 01:07Z = 283 min), so the `forecast_stale` caution (threshold 120 min) fires on every hour with live data. Not changed; needs a decision (raise the threshold, or measure age from NWS `generatedAt` instead of `updateTime`?). Tonight's no-go verdicts were real (gusts 19.6 mph > 15). *Decided and changed on Oct 30: see the cloud follow-up below.*
3. **Real soils: pass.** `pnpm gis:soils`: MI091 201 map units / 21,724 polygons, MI115 80 / 9,721; 281 new map units, 31,445 polygons, 14 units and 605 polygons of the synthetic set retired. All 40 demo fields sum to 100.0%. Derrick confirmed the Soils tab.
4. **NAIP close-ups: pass.** `pnpm gis:naip`: 10,723 tiles at z12-17 for the demo boundaries + 1 mile, 91.3 MB, installed `tiles/naip/aoi.1c077748.pmtiles`; the online layer registered. Derrick confirmed sharp close-ups on the aerial layer.
5. **Ctrl+C on Windows: pass.** Derrick pressed Ctrl+C in the `pnpm dev` terminal: "[dev] stopping", vendor-sim and clock shut down on SIGINT, ports 3000/4010 free, no node process with `farm-manager` in its command line left. Notes: a bare `Get-Process node` also lists unrelated node apps (here Claude desktop plugins), so judge by command line. Run via `pnpm.cmd`, cmd adds a "Terminate batch job (Y/N)?" prompt after the app has already stopped; harmless.
6. **Production build: pass.** `pnpm pilot` built and served (`next start`, first build ~10 min on this PC including a long quiet stretch before "Compiled"; the cached rebuild took seconds). Demo steps 3-4 behaved as under `pnpm dev`. Note: with `CONNECTOR_WEATHER=live`, demo step 4 (simulated wind on /admin/spray) can't change the board, because the app isn't reading the stand-in (the action says so). Weather was put back to `sim` for steps 3-4.
7. **Phone on shop Wi-Fi: pass.** `http://192.168.4.107:3000/m` on Derrick's phone under `pnpm pilot`. Amy's demo PIN; Down on a combine reached the wall within 2 s; Back up worked.
8. **Wall kiosk: pass.** The two commands from /admin/devices "On this PC (wall kiosk)" (Chrome in `C:\Program Files`): enrolled as Shop wall, then `--kiosk` opened straight onto the board.
9. **Offline: pass.** Router WAN unplugged with the PC, wall kiosk and phone on shop Wi-Fi under `pnpm pilot`: the board, phone and offline layers kept working; only the online aerial photos said "offline".
10. **Windows tests: pass after one fix.** First run: lint and typecheck OK; `pnpm test` 1 failure, `pnpm test:db` 2 failures.
    - **Fixed: Windows-1252 CSV decoding.** `tools/import/parties-csv.test.ts` failed with `'José O\u0092Brien'`: Node 24.13.0's `TextDecoder('windows-1252')` (on this PC; `.encoding` still says `windows-1252`) decodes 0x80-0x9F as ISO-8859-1, so an Excel-saved parties or seasons CSV would import with curly quotes, en dashes, € and ™ as invisible C1 controls. `decodeCsvBytes` (`tools/import/csv.ts`) now maps 0x80-0x9F with the WHATWG table itself (checked against Python's cp1252) and no longer relies on the Node build; new unit test over the whole range.
    - `test:db`'s 2 failures (a `farm.weather_forecasts` count in a weather test) happened once, right after `pnpm pilot` was stopped; 4 later runs were 305/305. Likely the closing pilot's weather job writing to the same database; not reproduced, not changed. *Oct 30: each test file has its own database, so not the pilot; see the cloud follow-up below.*
    - Final: lint, typecheck, `pnpm test` (1,294 passed, 2 skipped), `pnpm test:db` (305), `pnpm build`, and `pnpm test:e2e e2e/m1-demo.spec.ts --project=wall` (5/5; phone→wall 114 ms; tap→panel 23-39 ms) all pass.

Left as found: `.env.local` has `NWS_USER_AGENT` set and `CONNECTOR_WEATHER=live` commented out (weather back on sim for the demo).

Next open items: decide the `forecast_stale` threshold for live NWS (check 2); README Troubleshooting rows for pnpm 9 ("packages field missing or empty") and PowerShell's execution policy blocking `pnpm.ps1`; then PC-AGENT.md section 3 (slice 1e lidar and crop history). *The first two are done (Oct 30, below).*

### Oct 30, 2026: cloud follow-up to the PC checks (branch `claude/pc-followups`)

- **Windows-1252 CSV fix:** merged as is. Shapefile attributes (boundaries, county parcels) were never affected: parsedbf decodes in streaming mode, which Node 24.13 gets right. A test now plays 24.13's one-shot bug on any Node, so CI would catch a switch to one-shot decoding.
- **Check 2, live weather staleness: changed.** Staleness now counts from the last successful NWS check of the cell, not from when NWS issued the forecast: `farm.weather_grids.forecast_checked_at` plus `forecast_checked_issue` (migration `0006`). The check vouches only for the issue it confirmed: a row still built from a replaced issue counts from its own issue time.
  - More than 120 min without a check is stale ("Forecast not checked with NWS for 3 h").
  - An issue older than 18 h is stale anyway.
  - The views also drop a stale caution stored during an outage once the same issue is confirmed again.
  - The spray rules version is now `v0.1`. Defaults are in `docs/decisions.md` ("Forecast stale").
- **`test:db`'s 2 failures:** not the pilot. More likely a UTC-hour boundary in `src/connectors/nws/weather-job.db.test.ts`, whose clock started at an arbitrary `Date.now()`. Two failures were reproduced that way, but not the exact one seen. The test's clock now starts 2 minutes into an hour.
- **Bootstrap after a cut-off image download:** `db:up` now says which case it is, instead of always "is port DB_PORT free?":
  - Docker stopped answering;
  - the image didn't finish downloading;
  - DB_PORT is taken by another program or reserved by Windows (with the URLs in `.env.local` to change too).
- **Docs:**
  - README Troubleshooting rows: pnpm 9 or 10; `pnpm.cmd` when PowerShell blocks `pnpm.ps1`; a cut-off image download; cmd's "Terminate batch job".
  - README also notes how long the first `pnpm pilot` build takes.
  - PC-AGENT.md: check 5 now looks for this app's node processes by command line, and suggests `pnpm.cmd`.
- **Review:** two rounds, all findings fixed.
  - A 30-agent review found 20 issues (about ten distinct).
  - A second round on those fixes found 6 more. Among them: NWS serving an older cached issue no longer makes the newest one look unchecked. The check is now written in the spray pass's transaction, so screens don't flicker to stale when a new issue lands. `db:up` can no longer hang on a Docker daemon that stopped answering.
- **Checks:** all passed locally on Linux:
  - lint and typecheck;
  - `pnpm test` (1,316) and `pnpm test:db` (308);
  - `pnpm build`;
  - the full e2e suite against `pnpm pilot --skip-build` (114 passed, 36 skipped).
