/**
 * The Samsara vehicle-list replay fixture: the committed JSON equals ./vehicles-fixtures.ts's
 * output (regenerate: `pnpm exec tsx src/connectors/samsara/vehicles-fixtures-write.ts`, then
 * `pnpm lint:fix`), it is in the Samsara replay list, every vehicle is valid under the live schema
 * and mapped by the demo seed, and no other Samsara exchange answers the same request.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildDemoFarm } from '../../sim/farm/build';
import { simExternalRefs } from '../../sim/types';
import { replayFixtureSchema } from '../replay';
import { samsaraReplayFixtures } from './replay';
import { buildSamsaraVehiclesFixture, VEHICLES_FIXTURE_PATH } from './vehicles-fixtures';
import { samsaraVehiclesReplayFixtures } from './vehicles-replay';
import { samsaraVehicleSchema, samsaraVehiclesPageSchema } from './vehicles-schemas';

const file = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'doc-derived',
  ...VEHICLES_FIXTURE_PATH.split('/'),
);
const built = buildSamsaraVehiclesFixture();

describe('Samsara vehicle-list fixture', () => {
  test('the committed file is what the builder makes, and the replay list serves it', () => {
    expect(
      JSON.parse(readFileSync(file, 'utf8')),
      'out of date: run src/connectors/samsara/vehicles-fixtures-write.ts',
    ).toEqual(JSON.parse(JSON.stringify(built)));
    expect(samsaraVehiclesReplayFixtures).toHaveLength(1);
    expect(samsaraReplayFixtures).toEqual(
      expect.arrayContaining([...samsaraVehiclesReplayFixtures]),
    );
  });

  test('well-formed; every vehicle valid and mapped by the demo seed', () => {
    const f = replayFixtureSchema.parse(built);
    expect(VEHICLES_FIXTURE_PATH.startsWith(`${f.stream}/`)).toBe(true);
    expect(f.reference).toMatch(/https:\/\/developers\.samsara\.com\/reference\/listvehicles/);
    expect(f.reference).toMatch(/no real farm data/);
    const page = samsaraVehiclesPageSchema.parse(f.exchanges[0]?.response.body);
    const mapped = new Set(
      simExternalRefs(buildDemoFarm())
        .filter((r) => r.ref.source === 'samsara' && r.ref.kind === 'machine')
        .map((r) => r.ref.externalId),
    );
    expect(page.data).toHaveLength(6);
    for (const v of page.data) {
      const parsed = samsaraVehicleSchema.parse(v);
      expect(mapped.has(parsed.id), parsed.id).toBe(true);
    }
  });

  test('no other Samsara exchange answers the same request', () => {
    const keys = samsaraReplayFixtures.flatMap((f) =>
      f.exchanges.map((x) =>
        JSON.stringify([
          x.request.method,
          x.request.path,
          x.request.query ?? {},
          x.request.body ?? null,
        ]),
      ),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
