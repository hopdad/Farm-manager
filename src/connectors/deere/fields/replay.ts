/**
 * deere-data's Deere replay fixtures (slice 1f, docs/contracts-1f.md §8), numbers 20-29 under
 * src/connectors/deere/fixtures/doc-derived/<stream>/ (built by ../fixtures/build.ts
 * `buildDeereFieldsFixtures`, checked by ../fixtures/fixtures.test.ts), imported statically so
 * the JSON ships in the build:
 *
 *   fields/20-fields.json         fields with farms and clients embedded (plus the one Deere-only
 *                                 field: the creation path), org boundaries, farms, clients
 *   flags/20-flags.json           flags with their category, archived ones too
 *   hours/20-engine-hours.json    each Deere machine's latest engine hours
 *
 * Their requests name the deere.fields client's query (`recordFilter`, `embed`, `lastKnown`), so
 * they answer only that client and the 1a exchanges keep answering everything else.
 * ../replay.ts lists these after deere-ops's and before the 1a ones (first match wins).
 */
import type { ReplayFixture } from '../../replay';
import fields from '../fixtures/doc-derived/fields/20-fields.json';
import flags from '../fixtures/doc-derived/flags/20-flags.json';
import hours from '../fixtures/doc-derived/hours/20-engine-hours.json';

export const deereFieldsReplayFixtures: readonly ReplayFixture[] = [
  fields,
  flags,
  hours,
] as unknown as ReplayFixture[];
