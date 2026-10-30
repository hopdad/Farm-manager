/**
 * deere-data's Deere replay fixtures (1f, docs/contracts-1f.md §8): farms, equipment, engine
 * hours and whatever else the deere.fields sync needs beyond the 1a fixtures. Files go under
 * src/connectors/deere/fixtures/doc-derived/<stream>/2x-<name>.json (numbers 20-29 are this
 * builder's), imported statically here. ../replay.ts lists these after the recorded and the
 * deere-ops fixtures and before the 1a ones (first match wins). Empty until the builder adds some.
 */
import type { ReplayFixture } from '../../replay';

export const deereFieldsReplayFixtures: readonly ReplayFixture[] = [];
