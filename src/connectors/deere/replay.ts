/**
 * Deere replay fixtures (contracts-m1 §10), recorded first (none yet: `pnpm connectors:record`
 * arrives with 1f), then the doc-derived ones (./fixtures/build.ts). Imported statically so the
 * JSON ships in the build; the clients load this module only in replay mode
 * (src/connectors/endpoints.ts `replayFetch`).
 */
import type { ReplayFixture } from '../replay';
import boundaries from './fixtures/doc-derived/boundaries/01-boundaries.json';
import fields from './fixtures/doc-derived/fields/01-fields.json';
import flags from './fixtures/doc-derived/flags/01-flags.json';
import locations from './fixtures/doc-derived/locations/01-machine-locations.json';
import operations from './fixtures/doc-derived/operations/01-field-operations.json';
import organizations from './fixtures/doc-derived/organizations/01-organizations.json';

const recorded: ReplayFixture[] = [];

const docDerived = [
  organizations,
  locations,
  fields,
  boundaries,
  operations,
  flags,
] as unknown as ReplayFixture[];

export const deereReplayFixtures: readonly ReplayFixture[] = [...recorded, ...docDerived];
