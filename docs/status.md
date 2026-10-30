# Build status

Oct 29, 2026, evening. Update this file at the end of each build session.

## Branches

| Branch | State |
|---|---|
| `main` | M0 + M1 (slices 1a-1d), merged from `claude/m1-see-it` on Oct 30 at `393e5b9`. Work from here; the PC agent follows `PC-AGENT.md`. |
| `claude/m0-foundation` | M0 done. CI green on Linux, Windows and e2e at `7f492dc`. |
| `claude/m1-see-it` | M1 slices 1a-1d built, reviewed (36 findings fixed) and verified on an M0 upgrade. CI fully green at `4492708` (Linux, Windows, e2e and e2e in replay mode). Then the polish commits (see below). |
| `claude/fix-e2e-flakes` | From `main`: the two e2e failures of CI run 25 (see below). |
| `claude/m0-win-debug` | Temporary diagnostic branch. Safe to delete on GitHub. |

## Finished after the save

The M1 verifier's polish items are done (commits `8d629f3`..`f4dfe72`, on top of the two WIP commits): the wall kiosk enrolls on a localhost link from /admin/devices with exact PowerShell commands; README "Coming from M0" (three migrations, no `db:reset`); a plain bootstrap keeps an installed synthetic basemap; the stale reset-owner note; the way back from `--hide-demo`; the seasons example now fills the imported prospect fields. Lint, typecheck, unit (also in a clean clone with no env files), DB tests, build and the auth/M1/M0 e2e specs passed locally. Full GitHub CI on the new head was started on Oct 30.

## CI run 25's e2e failures (Oct 30, `claude/fix-e2e-flakes`)

- `weather.spec.ts` "wind slider", the empty admin notice: a real UX bug. The admin forms took their notice from useActionState, which React commits only with the action's whole router transition (the page revalidatePath re-renders into the response, plus any router refresh started meanwhile, such as LiveRefresh's on the realtime events the action itself causes). On a busy machine the answer arrived in ~150 ms and the notice 5 to 15 s later. Every admin form now reports the answer from the submit itself (`src/app/admin/_components/controls.tsx`; /admin/people and /admin/devices use the same controls), and says so when the server can't be reached. The spec reproduces the old failure on purpose in its last step (a refresh held behind the action) and allows the server round trip 20 s.
- `imagery.spec.ts` "tile lines": never three software-WebGL boards at once (the viewer's board is checked and closed before the second manager's opens); the M0 demo closes its phone map when its test ends.

Lint, typecheck, unit (also in a clean clone with no env files), DB tests, build, both specs 5 times each on the wall project, the M0 and M1 demo specs and the full e2e suite (106 passed, 36 skipped) passed locally against `pnpm pilot --skip-build`.

## Not verifiable from the cloud build machine

Its proxy blocks these, so they still need a check on the Windows PC: the real Protomaps basemap, live NWS weather (`CONNECTOR_WEATHER=live`), real SSURGO soils (`pnpm gis:soils`), NAIP close-ups (`pnpm gis:naip`).

## Next

- Derrick's demos on the PC: M0 (README "M0 demo"), then M1 (README "M1 demo").
- Open decisions with their current defaults: `docs/decisions.md`.
- Then M1 slices 1e (lidar, crop history), 1f (live connectors, sync health) and 1g (replay, hardening), per `docs/build-plan.md` §6.
