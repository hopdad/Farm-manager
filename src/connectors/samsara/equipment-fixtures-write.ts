/**
 * Writes the Samsara equipment-feed replay fixtures (./equipment-fixtures.ts) under
 * ./fixtures/doc-derived/. A dev tool, run by hand after changing the builder or the farm:
 *
 *   pnpm exec tsx src/connectors/samsara/equipment-fixtures-write.ts
 *   pnpm lint:fix        (Biome's JSON formatting; the fixtures test compares data, not text)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSamsaraEquipmentFixtures } from './equipment-fixtures';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'doc-derived');
for (const [rel, fixture] of Object.entries(buildSamsaraEquipmentFixtures())) {
  const file = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
