/**
 * deere-ops's Deere replay fixtures (1f, docs/contracts-1f.md §8): this crop season's operations
 * on the demo fields the 1a operations fixture doesn't answer (./fixtures.ts builds
 * src/connectors/deere/fixtures/doc-derived/operations/30-field-operations-2026.json; numbers
 * 30-39 are this builder's). ../replay.ts lists these first; none shadows a 1a exchange (each
 * names a field path the 1a fixture doesn't), so the uniqueness test holds. (The 2022-2026
 * historical seasons and their `noShift` option belong to the deferred Deere season backfill:
 * docs/contracts-1f.md "Deferred: Deere season backfill".) Imported statically so the JSON
 * ships in the build.
 */

import type { ReplayFixture } from '../../replay';
import operations2026 from '../fixtures/doc-derived/operations/30-field-operations-2026.json';

export const deereOpsReplayFixtures: readonly ReplayFixture[] = [
  operations2026,
] as unknown as ReplayFixture[];
