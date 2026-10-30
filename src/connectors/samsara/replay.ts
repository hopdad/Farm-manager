/**
 * Samsara replay fixtures (contracts-m1 §10, docs/contracts-1f.md §8): the doc-derived ones
 * (./fixtures/build.ts; 1f: the fleet-faults builder owns this file and adds its `faults`
 * fixture here). Recorded fixtures (./replay-recorded.ts) are NOT in this list (1f fix): their
 * ids are hashed, so only the contract and conformance tests read `samsaraRecordedFixtures`.
 * Imported statically so the JSON ships in the build; the clients load this module only in
 * replay mode (src/connectors/endpoints.ts `replayFetch`).
 */
import type { ReplayFixture } from '../replay';
import positions from './fixtures/doc-derived/positions/01-locations-feed.json';
import stats from './fixtures/doc-derived/stats/01-stats-feed.json';

/** The doc-derived fixtures (./fixtures/build.ts; ./fixtures/fixtures.test.ts checks them). */
export const samsaraDocDerivedFixtures = [positions, stats] as unknown as ReplayFixture[];

export const samsaraReplayFixtures: readonly ReplayFixture[] = [...samsaraDocDerivedFixtures];
