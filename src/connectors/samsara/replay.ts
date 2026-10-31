/**
 * Samsara replay fixtures (contracts-m1 §10, docs/contracts-1f.md §8): the doc-derived ones
 * (./fixtures/build.ts; 1f: the fleet-faults builder owns this file and adds its `faults`
 * fixture here). Recorded fixtures (./replay-recorded.ts) are NOT in this list (1f fix): their
 * ids are hashed, so only the contract and conformance tests read `samsaraRecordedFixtures`.
 * Imported statically so the JSON ships in the build; the clients load this module only in
 * replay mode (src/connectors/endpoints.ts `replayFetch`).
 */
import type { ReplayFixture } from '../replay';
import { samsaraEquipmentReplayFixtures } from './equipment-replay';
import faults from './fixtures/doc-derived/faults/01-fault-codes-feed.json';
import positions from './fixtures/doc-derived/positions/01-locations-feed.json';
import stats from './fixtures/doc-derived/stats/01-stats-feed.json';
import { samsaraVehiclesReplayFixtures } from './vehicles-replay';

/**
 * The doc-derived fixtures (./fixtures/build.ts; ./fixtures/fixtures.test.ts checks them): the
 * positions loop, the stats feed and (1f) the fault-codes feed. The stats and faults exchanges
 * name their `types`, so neither answers the other's call whatever the order.
 */
export const samsaraDocDerivedFixtures = [positions, stats, faults] as unknown as ReplayFixture[];

/**
 * Everything CONNECTOR_SAMSARA=replay serves: the vehicle feeds (fleet-faults), then 1f.2's
 * equipment feeds (machines, ./equipment-replay.ts) and vehicle list (terminal-pickups,
 * ./vehicles-replay.ts). No two exchanges across the list answer the same request.
 */
export const samsaraReplayFixtures: readonly ReplayFixture[] = [
  ...samsaraDocDerivedFixtures,
  ...samsaraEquipmentReplayFixtures,
  ...samsaraVehiclesReplayFixtures,
];
