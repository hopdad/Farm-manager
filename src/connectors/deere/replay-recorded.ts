/**
 * Recorded Deere replay fixtures (1f, owner: sync-health; docs/contracts-1f.md §8, decision 3):
 * the scrubbed copies `pnpm connectors:record deere --scrub` writes under
 * src/connectors/deere/fixtures/recorded/<stream>/, imported statically here (never the raw
 * recordings: those stay in data/raw/recorded/, gitignored). A separate list (1f fix): replay
 * mode never serves it (its ids are hashed, so the board would show nothing it knows); the
 * contract and conformance tests read it. Empty until a recording exists.
 */
import type { ReplayFixture } from '../replay';

export const deereRecordedFixtures: readonly ReplayFixture[] = [];
