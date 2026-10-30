/**
 * deere-ops's Deere replay fixtures (1f, docs/contracts-1f.md §8): the historical seeding and
 * harvest operations of 2022-2026 on the demo fields (per-season exchanges, `noShift: true` for
 * historical instants) and anything else deere.ops and deere:backfill need. Files go under
 * src/connectors/deere/fixtures/doc-derived/<stream>/3x-<name>.json (numbers 30-39 are this
 * builder's). ../replay.ts lists these right after the recorded ones, so a season-specific
 * exchange wins over the 1a operations fixture that ignores `cropSeason`. Empty until the builder
 * adds some.
 */
import type { ReplayFixture } from '../../replay';

export const deereOpsReplayFixtures: readonly ReplayFixture[] = [];
