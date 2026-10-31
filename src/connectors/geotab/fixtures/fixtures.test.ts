/**
 * The MyGeotab doc-derived replay fixtures (docs/contracts-1f.md §B.6): the committed JSON is
 * ./build.ts's output, every JSON-RPC result valid under the live client's schemas (envelope and
 * each entity) and `replayFixtureSchema`, every exchange told apart by body, "no real farm data"
 * in `reference`, every device one the demo seed maps, and no two exchanges answering the same
 * request (method, path, query, body). Regenerate: `pnpm exec tsx
 * src/connectors/geotab/fixtures/write.ts`, then `pnpm lint:fix`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildDemoFarm } from '../../../sim/farm/build';
import { simExternalRefs } from '../../../sim/types';
import { type ReplayFixture, replayFixtureSchema } from '../../replay';
import { geotabReplayFixtures } from '../replay';
import {
  geotabDeviceSchema,
  geotabDiagnosticSchema,
  geotabFailureModeSchema,
  geotabFaultDataSchema,
  geotabFeedResultSchema,
  geotabGroupSchema,
  geotabLogRecordSchema,
  geotabRpcResponseSchema,
  geotabStatusDataSchema,
} from '../schemas';
import { buildGeotabDocDerivedFixtures } from './build';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-derived');
const built = buildGeotabDocDerivedFixtures();

type Parser = { safeParse(v: unknown): { success: boolean } };
const ENTITY: Record<string, Parser> = {
  LogRecord: geotabLogRecordSchema,
  StatusData: geotabStatusDataSchema,
  FaultData: geotabFaultDataSchema,
  Diagnostic: geotabDiagnosticSchema,
  FailureMode: geotabFailureModeSchema,
  Device: geotabDeviceSchema,
  Group: geotabGroupSchema,
};

describe('MyGeotab doc-derived fixtures', () => {
  test('the committed files are what the builder makes, and replay.ts ships all of them', () => {
    for (const [rel, fixture] of Object.entries(built)) {
      const committed = JSON.parse(readFileSync(path.join(dir, ...rel.split('/')), 'utf8'));
      expect(
        committed,
        `${rel} is out of date: run src/connectors/geotab/fixtures/write.ts`,
      ).toEqual(JSON.parse(JSON.stringify(fixture)));
    }
    expect(geotabReplayFixtures).toHaveLength(Object.keys(built).length);
    expect(JSON.parse(JSON.stringify(geotabReplayFixtures))).toEqual(
      expect.arrayContaining(Object.values(built).map((f) => JSON.parse(JSON.stringify(f)))),
    );
  });

  test('JSON-RPC by body, the live schemas, the metadata', () => {
    for (const [rel, f] of Object.entries(built)) {
      const parsed = replayFixtureSchema.parse(f);
      expect(rel.startsWith(`${parsed.stream}/`)).toBe(true);
      expect(parsed.source).toBe('geotab');
      expect(parsed.reference).toMatch(/https:\/\/my\.geotab\.com\/api\.json/);
      expect(parsed.reference).toMatch(/no real farm data/);
      for (const x of parsed.exchanges) {
        expect(x.request).toMatchObject({ method: 'POST', path: '/apiv1' });
        const body = x.request.body as { method: string; params: { typeName: string } };
        expect(['GetFeed', 'Get']).toContain(body.method);
        const env = geotabRpcResponseSchema.parse(x.response.body);
        expect(env.error).toBeUndefined();
        const entity = ENTITY[body.params.typeName] as Parser;
        const items =
          body.method === 'GetFeed'
            ? (geotabFeedResultSchema.parse(env.result).data as unknown[])
            : (env.result as unknown[]);
        for (const item of items)
          expect(entity.safeParse(item).success, body.params.typeName).toBe(true);
      }
    }
  });

  test('every device is one the demo seed maps (H2 under its Geotab id)', () => {
    const refs = simExternalRefs(buildDemoFarm()).filter((r) => r.ref.source === 'geotab');
    const known = new Set(refs.map((r) => r.ref.externalId));
    expect(known.size).toBe(1);
    const seen = new Set<string>();
    for (const f of Object.values(built) as ReplayFixture[]) {
      for (const x of f.exchanges) {
        const result = (x.response.body as { result: unknown }).result;
        const items = Array.isArray(result) ? result : ((result as { data: unknown[] }).data ?? []);
        for (const it of items as { device?: { id: string }; deviceType?: string; id?: string }[]) {
          if (it.device) seen.add(it.device.id);
          else if (it.deviceType && it.id) seen.add(it.id);
        }
      }
    }
    expect(seen).toEqual(known);
  });

  test('no two exchanges answer the same request', () => {
    const keys = geotabReplayFixtures.flatMap((f) =>
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
