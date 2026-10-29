# Build status

Oct 29, 2026, evening. Update this file at the end of each build session.

## Branches

| Branch | State |
|---|---|
| `claude/m0-foundation` | M0 done. CI green on Linux, Windows and e2e at `7f492dc`. |
| `claude/m1-see-it` | M1 slices 1a-1d built, reviewed (36 findings fixed) and verified on an M0 upgrade. CI fully green at `4492708` (Linux, Windows, e2e and e2e in replay mode). The last commit is a **WIP** polish commit (see below). |
| `claude/m0-win-debug` | Temporary diagnostic branch. Safe to delete on GitHub. |

## In progress when saved (WIP commit on `claude/m1-see-it`)

Polish from the M1 verifier, changes made but checks not yet run:
1. Enrolling the wall PC itself: a localhost enrollment link for the kiosk profile, alongside the LAN link and QR for other devices (`src/platform/auth/kiosk.ts`, `/admin/devices`, README "First run", `docs/kiosk.md`).
2. README "Coming from M0": bootstrap applies three migrations (0003-0005), and no `pnpm db:reset` is needed.
3. Bootstrap with only the synthetic basemap and Protomaps unreachable: keep it with a warning instead of failing.
4. `docs/kiosk.md`: drop the stale reset-owner note (`pnpm auth:reset-owner` exists).
5. README: the way back from `--hide-demo` (/admin/fields, "Show demo fields").
6. README demo step 5: the seasons example and its text should agree.

To finish: run `pnpm lint`, `typecheck`, `test` (also in a clean clone with no env files, as CI does), `test:db`, `build`, `test:e2e`, then commit and push, and check CI (push runs Linux only; dispatch the workflow for Windows and e2e).

## Not verifiable from the cloud build machine

Its proxy blocks these, so they still need a check on the Windows PC: the real Protomaps basemap, live NWS weather (`CONNECTOR_WEATHER=live`), real SSURGO soils (`pnpm gis:soils`), NAIP close-ups (`pnpm gis:naip`).

## Next

- Derrick's demos on the PC: M0 (README "M0 demo"), then M1 (README "M1 demo").
- Open decisions with their current defaults: `docs/decisions.md`.
- Then M1 slices 1e (lidar, crop history), 1f (live connectors, sync health) and 1g (replay, hardening), per `docs/build-plan.md` §6.
