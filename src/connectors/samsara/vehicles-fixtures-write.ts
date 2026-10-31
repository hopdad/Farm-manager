/**
 * Writes the Samsara vehicle-list replay fixture (./vehicles-fixtures.ts) under
 * ./fixtures/doc-derived/. A dev tool, run by hand after changing the builder or the farm:
 *
 *   pnpm exec tsx src/connectors/samsara/vehicles-fixtures-write.ts
 *   pnpm lint:fix        (Biome's JSON formatting; the test compares data, not text)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSamsaraVehiclesFixture, VEHICLES_FIXTURE_PATH } from './vehicles-fixtures';

const file = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'doc-derived',
  ...VEHICLES_FIXTURE_PATH.split('/'),
);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(buildSamsaraVehiclesFixture(), null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), file)}`);
