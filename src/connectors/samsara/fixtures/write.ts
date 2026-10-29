/**
 * Writes the Samsara doc-derived replay fixtures (./build.ts) under ./doc-derived/. A dev tool, run
 * by hand after changing the builder or the simulated farm:
 *
 *   pnpm exec tsx src/connectors/samsara/fixtures/write.ts
 *   pnpm lint:fix        (Biome's JSON formatting; ./fixtures.test.ts compares data, not text)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSamsaraDocDerivedFixtures } from './build';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-derived');
for (const [rel, fixture] of Object.entries(buildSamsaraDocDerivedFixtures())) {
  const file = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
