/**
 * Writes deere-ops's doc-derived replay fixture (./fixtures.ts) under
 * src/connectors/deere/fixtures/doc-derived/. A dev tool, run by hand after changing the builder,
 * the stand-in's operation shapes or the simulated farm:
 *
 *   pnpm exec tsx src/connectors/deere/ops/fixtures-write.ts
 *   pnpm lint:fix        (Biome's JSON formatting; ./fixtures.test.ts compares data, not text)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeereOpsFixtures } from './fixtures';

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'doc-derived',
);
for (const [rel, fixture] of Object.entries(buildDeereOpsFixtures())) {
  const file = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
