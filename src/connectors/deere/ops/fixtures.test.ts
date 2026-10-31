/**
 * deere-ops's doc-derived replay fixture: well-formed (`replayFixtureSchema`), the committed
 * JSON equal to what ./fixtures.ts builds (regenerate:
 * `pnpm exec tsx src/connectors/deere/ops/fixtures-write.ts`, then `pnpm lint:fix`), every
 * body valid under the live client's schemas, every field id one the demo seed maps, no
 * exchange answering a request another one in the Deere list answers, and replayed through the
 * live client: the 2026 operations land (embedded measurements here, the per-operation call for
 * the 1a ones), a 400 coverage, and a field with no operations.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { simExternalRefs } from '../../../sim/types';
import type { ConnectorConfig } from '../../endpoints';
import { type ReplayFixture, replayFixtureSchema } from '../../replay';
import { collectingLogger } from '../../testkit';
import { DeereClient } from '../client';
import { fixtureFarm, OPERATIONS_ANCHOR } from '../fixtures/build';
import { deereReplayFixtures } from '../replay';
import { deereApiErrorSchema, deereBoundarySchema } from '../schemas';
import { buildDeereOpsFixtures, OPS_FIXTURE_FIELDS, OPS_FIXTURE_FILE } from './fixtures';
import { mapDeereOperation } from './mapper';
import { pollDeereOperations } from './poll';
import { deereOpsReplayFixtures } from './replay';
import { deereOpsFieldOperationsSchema } from './schemas';

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'doc-derived',
);
const built = buildDeereOpsFixtures();
const fixture = built[OPS_FIXTURE_FILE] as ReplayFixture;

describe("deere-ops's replay fixture", () => {
  test('the committed file is what the builder makes, and the replay list ships it first', () => {
    const committed = JSON.parse(
      readFileSync(path.join(dir, ...OPS_FIXTURE_FILE.split('/')), 'utf8'),
    );
    expect(committed, `${OPS_FIXTURE_FILE} is out of date: run ops/fixtures-write.ts`).toEqual(
      JSON.parse(JSON.stringify(fixture)),
    );
    expect(deereOpsReplayFixtures).toEqual([committed]);
    expect(deereReplayFixtures[0]).toEqual(committed);
  });

  test('layout and metadata follow the replay contract (numbers 30-39)', () => {
    const parsed = replayFixtureSchema.parse(fixture);
    expect(OPS_FIXTURE_FILE).toMatch(/^operations\/3\d-[a-z0-9-]+\.json$/);
    expect(parsed).toMatchObject({
      source: 'deere',
      stream: 'operations',
      kind: 'doc-derived',
      basePath: '/platform',
      anchor: OPERATIONS_ANCHOR,
    });
    expect(parsed.reference).toMatch(/https:\/\/developer\.deere\.com\/dev-docs\//);
    expect(parsed.reference).toMatch(/no real farm data/);
  });

  test('every body is valid under the live schemas; the 400 is a Deere error', () => {
    for (const x of fixture.exchanges) {
      const p = x.request.path;
      const schema = p.endsWith('/fieldOperations')
        ? deereOpsFieldOperationsSchema
        : x.response.status === 400
          ? deereApiErrorSchema
          : deereBoundarySchema;
      const r = schema.safeParse(x.response.body);
      expect(r.success, `${p}: ${r.error?.message}`).toBe(true);
    }
    expect(fixture.exchanges.filter((x) => x.response.status === 400)).toHaveLength(1);
  });

  test('field ids are the ones the demo seed maps, and no request is answered twice', () => {
    const refs = simExternalRefs(fixtureFarm());
    const known = new Set(refs.map((r) => `${r.ref.sourceOrg}|${r.ref.externalId}`));
    for (const x of fixture.exchanges.filter((e) => e.request.path.endsWith('/fieldOperations'))) {
      const [, , org, , field] = x.request.path.split('/');
      expect(known.has(`${org}|${decodeURIComponent(field ?? '')}`), x.request.path).toBe(true);
    }
    const seen = new Set<string>();
    for (const f of deereReplayFixtures) {
      for (const x of f.exchanges) {
        const key = `${x.request.method} ${x.request.path} ${JSON.stringify(x.request.query ?? {})}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe('deere.ops in replay (the live client on the committed fixtures)', () => {
  const cfg: ConnectorConfig = {
    VENDOR_SIM_URL: 'http://127.0.0.1:1',
    PUBLIC_URL: 'http://localhost:3112',
  };
  const now = () => new Date('2026-10-31T13:00:00.000Z');

  test('the 2026 operations land; coverage refused on one field; others list none', async () => {
    const calls: string[] = [];
    const client = DeereClient.forReplay(cfg, {
      now,
      onCall: (c) => {
        calls.push(c.path);
      },
    });
    const r = await pollDeereOperations(null, {
      client,
      now,
      stopAt: new Date(now().getTime() + 60_000),
      cropSeason: 2026,
      fieldCap: null,
      storedModified: async () => new Map(),
      log: collectingLogger(),
    });
    expect(r.stats.skippedOrgs).toEqual([]);
    const ops = r.items.flatMap((i) => mapDeereOperation(i.payload));
    // 1a: harvest + seeding on 4 fields; 30: a planting on 10 fields and one burndown.
    expect(ops.filter((o) => o.kind === 'harvest')).toHaveLength(4);
    expect(ops.filter((o) => o.kind === 'seeding')).toHaveLength(4 + OPS_FIXTURE_FIELDS);
    expect(ops.filter((o) => o.kind === 'application')).toHaveLength(1);
    expect(ops.every((o) => o.cropYear === 2026)).toBe(true);
    // Time-shifted: the harvest day moves to the last day before now.
    const harvest = ops.find((o) => o.kind === 'harvest');
    expect(Date.parse(harvest?.endedAt as string)).toBeLessThan(now().getTime());
    expect(Date.parse(harvest?.endedAt as string)).toBeGreaterThan(
      now().getTime() - 2 * 86_400_000,
    );
    const refused = r.items.filter((i) => i.payload.coverageStatus === 'refused');
    expect(refused).toHaveLength(1);
    expect(mapDeereOperation(refused[0]?.payload)[0]?.areaAc).toBeGreaterThan(10);
    const spray = ops.find((o) => o.kind === 'application');
    expect(spray?.products.map((p) => p.kind)).toEqual([
      'other',
      'other',
      'chemical',
      'chemical',
      'chemical',
    ]);
    // Embedded measurements spared the 30-fixture operations their measurementTypes call.
    const measurementCalls = calls.filter((c) => c.endsWith('/measurementTypes'));
    expect(measurementCalls).toHaveLength(8); // the 1a operations only
  });
});
