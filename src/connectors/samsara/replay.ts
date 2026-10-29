/**
 * Samsara replay fixtures (contracts-m1 §10), recorded first (none yet: `pnpm connectors:record`
 * arrives with 1f), then the doc-derived ones (./fixtures/build.ts). Imported statically so the
 * JSON ships in the build; the clients load this module only in replay mode
 * (src/connectors/endpoints.ts `replayFetch`).
 */
import type { ReplayFixture } from '../replay';
import positions from './fixtures/doc-derived/positions/01-locations-feed.json';
import stats from './fixtures/doc-derived/stats/01-stats-feed.json';

const recorded: ReplayFixture[] = [];

const docDerived = [positions, stats] as unknown as ReplayFixture[];

export const samsaraReplayFixtures: readonly ReplayFixture[] = [...recorded, ...docDerived];
