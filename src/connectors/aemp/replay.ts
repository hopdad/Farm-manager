/**
 * AEMP replay fixtures (slice 1f.2; owner: the machines builder, docs/contracts-1f.md part B
 * §B.6): the doc-derived fixtures `CONNECTOR_AEMP=replay` serves (src/connectors/endpoints.ts
 * `replayFetch('aemp')`), in match order: one Fleet page per replayed provider (./fixtures/build.ts;
 * ./fixtures/fixtures.test.ts checks them). Replay bodies are JSON only: the fault series (its
 * windows are in the path) and the XML providers are exercised through the stand-in instead.
 * Recorded fixtures never go in this list (§8).
 */

import type { ReplayFixture } from '../replay';
import kubota from './fixtures/doc-derived/fleet/01-kubota-fleet.json';
import samsara from './fixtures/doc-derived/fleet/02-samsara-fleet.json';

export const aempReplayFixtures: readonly ReplayFixture[] = [
  kubota,
  samsara,
] as unknown as ReplayFixture[];
