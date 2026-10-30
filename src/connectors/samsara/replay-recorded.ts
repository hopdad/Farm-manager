/**
 * Recorded Samsara replay fixtures (1f, owner: sync-health; docs/contracts-1f.md §8, decision 3):
 * the scrubbed copies `pnpm connectors:record samsara --scrub` writes under
 * src/connectors/samsara/fixtures/recorded/<stream>/, imported statically here. ./replay.ts lists
 * them first. Empty until a recording exists.
 */
import type { ReplayFixture } from '../replay';

export const samsaraRecordedFixtures: readonly ReplayFixture[] = [];
