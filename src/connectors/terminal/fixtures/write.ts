/**
 * Writes the Terminal doc-derived replay fixtures (./build.ts) under ./doc-derived/. A dev tool,
 * run by hand after changing the builder or the simulated farm:
 *
 *   pnpm exec tsx src/connectors/terminal/fixtures/write.ts
 *   pnpm lint:fix        (Biome's JSON formatting; ./fixtures.test.ts compares data, not text)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTerminalDocDerivedFixtures } from './build';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-derived');
for (const [rel, fixture] of Object.entries(buildTerminalDocDerivedFixtures())) {
  const file = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
