/**
 * deere-ops's Deere replay fixtures (1f, docs/contracts-1f.md §8): this crop season's operations
 * on the demo fields (per-season exchanges with `query: { cropSeason }`) and anything else
 * deere.ops needs. Files go under src/connectors/deere/fixtures/doc-derived/<stream>/3x-<name>.json
 * (numbers 30-39 are this builder's). ../replay.ts lists these right after the recorded ones, so
 * a season-specific exchange wins over the 1a operations fixture that ignores `cropSeason`. (The
 * 2022-2026 historical seasons and their `noShift` option belong to the deferred Deere season
 * backfill: docs/contracts-1f.md "Deferred: Deere season backfill".) Empty until the builder adds
 * some.
 */
import type { ReplayFixture } from '../../replay';

export const deereOpsReplayFixtures: readonly ReplayFixture[] = [];
