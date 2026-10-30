/**
 * Terminal replay fixtures (slice 1f.2; owner: the terminal-pickups builder, docs/contracts-1f.md part B
 * §B.6): the doc-derived fixtures `CONNECTOR_TERMINAL=replay` serves (src/connectors/endpoints.ts
 * `replayFetch('terminal')`), in match order. Empty until the builder adds them: a replay poll then
 * answers "replay: no fixture for …". Recorded fixtures never go in this list (§8).
 */
import type { ReplayFixture } from '../replay';

export const terminalReplayFixtures: readonly ReplayFixture[] = [];
