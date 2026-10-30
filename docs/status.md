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
