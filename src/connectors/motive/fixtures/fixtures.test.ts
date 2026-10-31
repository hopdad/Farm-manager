/**
 * The Motive doc-derived replay fixtures (docs/contracts-1f.md §B.6): the committed JSON is
 * ./build.ts's output, every body valid under the live client's schemas (envelope and each
 * item) and `replayFixtureSchema`, "no real farm data" in `reference`, every vehicle one the
 * demo seed maps, and no two exchanges answering the same request. Regenerate:
 * `pnpm exec tsx src/connectors/motive/fixtures/write.ts`, then `pnpm lint:fix`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildDemoFarm } from '../../../sim/farm/build';
import { simExternalRefs } from '../../../sim/types';
import { type ReplayFixture, replayFixtureSchema } from '../../replay';
import { motiveReplayFixtures } from '../replay';
import {
  motiveCompaniesSchema,
  motiveFaultCodesSchema,
  motiveGroupsSchema,
  motiveVehicleLocationsSchema,
  motiveVehiclesSchema,
} from '../schemas';
import { buildMotiveDocDerivedFixtures } from './build';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-derived');
const built = buildMotiveDocDerivedFixtures();

const SCHEMAS: Record<string, { safeParse(v: unknown): { success: boolean } }> = {
  '/v1/companies': motiveCompaniesSchema,
  '/v2/vehicle_locations': motiveVehicleLocationsSchema,
  '/v3/vehicle_locations': motiveVehicleLocationsSchema,
  '/v1/fault_codes': motiveFaultCodesSchema,
  '/v1/vehicles': motiveVehiclesSchema,
  '/v1/groups': motiveGroupsSchema,
};

describe('Motive doc-derived fixtures', () => {
  test('the committed files are what the builder makes, and replay.ts ships all of them', () => {
    for (const [rel, fixture] of Object.entries(built)) {
      const committed = JSON.parse(readFileSync(path.join(dir, ...rel.split('/')), 'utf8'));
      expect(
        committed,
        `${rel} is out of date: run src/connectors/motive/fixtures/write.ts`,
      ).toEqual(JSON.parse(JSON.stringify(fixture)));
    }
    expect(motiveReplayFixtures).toHaveLength(Object.keys(built).length);
    expect(JSON.parse(JSON.stringify(motiveReplayFixtures))).toEqual(
      expect.arrayContaining(Object.values(built).map((f) => JSON.parse(JSON.stringify(f)))),
    );
  });

  test('layout, metadata and the live schemas', () => {
    for (const [rel, f] of Object.entries(built)) {
      const parsed = replayFixtureSchema.parse(f);
      expect(rel.startsWith(`${parsed.stream}/`)).toBe(true);
      expect(parsed.source).toBe('motive');
      expect(parsed.reference).toMatch(/https:\/\/developer-docs\.gomotive\.com\/reference\//);
      expect(parsed.reference).toMatch(/no real farm data/);
      for (const x of parsed.exchanges) {
        const schema = SCHEMAS[x.request.path];
        expect(schema, x.request.path).toBeDefined();
        expect(schema?.safeParse(x.response.body).success, x.request.path).toBe(true);
      }
    }
  });

  test('every vehicle is one the demo seed maps (H1 under its Motive id)', () => {
    const refs = simExternalRefs(buildDemoFarm()).filter((r) => r.ref.source === 'motive');
    const known = new Set(refs.map((r) => r.ref.externalId));
    expect(known.size).toBe(1);
    const seen = new Set<string>();
    for (const f of Object.values(built) as ReplayFixture[]) {
      for (const x of f.exchanges) {
        const b = x.response.body as {
          vehicles?: { vehicle: { id: number } }[];
          fault_codes?: { fault_code: { vehicle: { id: number } } }[];
        };
        for (const v of b.vehicles ?? []) seen.add(String(v.vehicle.id));
        for (const c of b.fault_codes ?? []) seen.add(String(c.fault_code.vehicle.id));
      }
    }
    expect(seen).toEqual(known);
  });

  test('no two exchanges answer the same request', () => {
    const keys = motiveReplayFixtures.flatMap((f) =>
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
