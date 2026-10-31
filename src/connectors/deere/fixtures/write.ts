/**
 * Writes the Deere doc-derived replay fixtures (./build.ts: the 1a set and deere-data's 1f
 * numbers 20-29) under ./doc-derived/. A dev tool, run
 * by hand after changing the builder or the simulated farm:
 *
 *   pnpm exec tsx src/connectors/deere/fixtures/write.ts
 *   pnpm lint:fix        (Biome's JSON formatting; ./fixtures.test.ts compares data, not text)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeereDocDerivedFixtures, buildDeereFieldsFixtures } from './build';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-derived');
const all = { ...buildDeereDocDerivedFixtures(), ...buildDeereFieldsFixtures() };
for (const [rel, fixture] of Object.entries(all)) {
  const file = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
