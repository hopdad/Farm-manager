/**
 * Deere replay fixtures (contracts-m1 §10, docs/contracts-1f.md §8), in match order (first match
 * wins):
 *   1. recorded (./replay-recorded.ts, sync-health: `pnpm connectors:record deere --scrub`);
 *   2. deere-ops's (./ops/replay.ts: historical seasons, before the 1a operations fixture that
 *      ignores `cropSeason`);
 *   3. deere-data's (./fields/replay.ts: farms, equipment, hours …);
 *   4. the 1a doc-derived ones (./fixtures/build.ts).
 * Imported statically so the JSON ships in the build; the clients load this module only in
 * replay mode (src/connectors/endpoints.ts `replayFetch`). Integrator-owned in 1f: builders add
 * fixtures in their own lists, never here.
 */
import type { ReplayFixture } from '../replay';
import { deereFieldsReplayFixtures } from './fields/replay';
import boundaries from './fixtures/doc-derived/boundaries/01-boundaries.json';
import fields from './fixtures/doc-derived/fields/01-fields.json';
import flags from './fixtures/doc-derived/flags/01-flags.json';
import locations from './fixtures/doc-derived/locations/01-machine-locations.json';
import operations from './fixtures/doc-derived/operations/01-field-operations.json';
import organizations from './fixtures/doc-derived/organizations/01-organizations.json';
import { deereOpsReplayFixtures } from './ops/replay';
import { deereRecordedFixtures } from './replay-recorded';

/** The 1a doc-derived fixtures (./fixtures/build.ts; ./fixtures/fixtures.test.ts checks them). */
export const deereDocDerived1aFixtures = [
  organizations,
  locations,
  fields,
  boundaries,
  operations,
  flags,
] as unknown as ReplayFixture[];

export const deereReplayFixtures: readonly ReplayFixture[] = [
  ...deereRecordedFixtures,
  ...deereOpsReplayFixtures,
  ...deereFieldsReplayFixtures,
  ...deereDocDerived1aFixtures,
];
