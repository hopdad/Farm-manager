/**
 * Samsara replay fixtures (contracts-m1 §10, docs/contracts-1f.md §8), recorded first
 * (./replay-recorded.ts, sync-health: `pnpm connectors:record samsara --scrub`), then the
 * doc-derived ones (./fixtures/build.ts; 1f: the fleet-faults builder owns this file and adds
 * its `faults` fixture here). Imported statically so the JSON ships in the build; the clients
 * load this module only in replay mode (src/connectors/endpoints.ts `replayFetch`).
 */
import type { ReplayFixture } from '../replay';
import positions from './fixtures/doc-derived/positions/01-locations-feed.json';
import stats from './fixtures/doc-derived/stats/01-stats-feed.json';
import { samsaraRecordedFixtures } from './replay-recorded';

/** The doc-derived fixtures (./fixtures/build.ts; ./fixtures/fixtures.test.ts checks them). */
export const samsaraDocDerivedFixtures = [positions, stats] as unknown as ReplayFixture[];

export const samsaraReplayFixtures: readonly ReplayFixture[] = [
  ...samsaraRecordedFixtures,
  ...samsaraDocDerivedFixtures,
];
