/**
 * The Deere doc-derived replay fixtures: well-formed (`replayFixtureSchema`), every response
 * body valid under the SAME zod schema the live client applies, every vendor id one the demo
 * seed maps (so replay drives the seeded board), and the committed JSON equal to what
 * ./build.ts produces (regenerate: `pnpm exec tsx src/connectors/deere/fixtures/write.ts`, then
 * `pnpm lint:fix`). 1f: the same checks for deere-data's numbers 20-29 (`buildDeereFieldsFixtures`,
 * listed by ../fields/replay.ts), whose ids map onto the seed except the one Deere-only field.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { ZodType } from 'zod';
import { simExternalRefs } from '../../../sim/types';
import { simDeereOnlyField } from '../../../sim/vendors/deere/fields-world';
import { type ReplayFixture, replayFixtureSchema } from '../../replay';
import { deereFieldsReplayFixtures } from '../fields/replay';
import {
  deereClientsSchema,
  deereEngineHoursListSchema,
  deereFarmsSchema,
  deereFieldsWithRefsSchema,
  deereFlagsWithCategorySchema,
} from '../fields/schemas';
import { deereLinkId } from '../mapper';
import { deereDocDerived1aFixtures, deereReplayFixtures } from '../replay';
import {
  deereBoundariesSchema,
  deereBoundarySchema,
  deereBreadcrumbsSchema,
  deereEquipmentListSchema,
  deereFieldOperationMeasurementsSchema,
  deereFieldOperationsSchema,
  deereFlagsSchema,
  deereOrganizationsSchema,
} from '../schemas';
import { buildDeereDocDerivedFixtures, buildDeereFieldsFixtures, fixtureFarm } from './build';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-derived');
const built = buildDeereDocDerivedFixtures();
const built1f = buildDeereFieldsFixtures();

/** Which live schema validates a response, by request path (minus the /platform base). */
function schemaFor(p: string): ZodType {
  const rules: [RegExp, ZodType][] = [
    [/^\/organizations$/, deereOrganizationsSchema],
    [/^\/isg\/equipment$/, deereEquipmentListSchema],
    [/^\/machines\/[^/]+\/breadcrumbs$/, deereBreadcrumbsSchema],
    [/^\/organizations\/[^/]+\/fields$/, deereFieldsWithRefsSchema],
    [/^\/organizations\/[^/]+\/farms$/, deereFarmsSchema],
    [/^\/organizations\/[^/]+\/clients$/, deereClientsSchema],
    [/^\/machines\/[^/]+\/engineHours$/, deereEngineHoursListSchema],
    [/^\/organizations\/[^/]+\/boundaries$/, deereBoundariesSchema],
    [/^\/organizations\/[^/]+\/fields\/[^/]+\/boundaries$/, deereBoundariesSchema],
    [/^\/organizations\/[^/]+\/fields\/[^/]+\/fieldOperations$/, deereFieldOperationsSchema],
    [/^\/fieldOperations\/[^/]+\/measurementTypes$/, deereFieldOperationMeasurementsSchema],
    [/^\/fieldOperations\/[^/]+\/boundary$/, deereBoundarySchema],
    [/^\/organizations\/[^/]+\/flags$/, deereFlagsWithCategorySchema],
    [/^\/organizations\/[^/]+\/fields\/[^/]+\/flags$/, deereFlagsSchema],
  ];
  const hit = rules.find(([re]) => re.test(p));
  if (!hit) throw new Error(`no live schema for ${p}`);
  return hit[1];
}

describe('Deere doc-derived fixtures', () => {
  test('the committed files are what the builder makes (and replay.ts ships all of them)', () => {
    for (const [rel, fixture] of Object.entries(built)) {
      const file = path.join(dir, ...rel.split('/'));
      const committed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      expect(
        committed,
        `${rel} is out of date: run src/connectors/deere/fixtures/write.ts`,
      ).toEqual(JSON.parse(JSON.stringify(fixture)));
    }
    // 1f: the builders' and the recorded fixtures come first (../replay.ts); the 1a set is all there.
    expect(deereDocDerived1aFixtures).toHaveLength(Object.keys(built).length);
    expect(deereReplayFixtures).toEqual(expect.arrayContaining(deereDocDerived1aFixtures));
  });

  test('layout and metadata follow the replay contract', () => {
    for (const [rel, f] of Object.entries(built)) {
      const parsed = replayFixtureSchema.parse(f);
      expect(rel.startsWith(`${parsed.stream}/`)).toBe(true);
      expect(rel).toMatch(/^[a-z]+\/\d{2}-[a-z0-9-]+\.json$/);
      expect(parsed).toMatchObject({ source: 'deere', kind: 'doc-derived', basePath: '/platform' });
      expect(parsed.reference).toMatch(/https:\/\/developer\.deere\.com\/dev-docs\//);
      expect(parsed.reference).toMatch(/no real farm data/);
    }
  });

  test('every response body is valid under the live client schema', () => {
    for (const f of Object.values(built) as ReplayFixture[]) {
      for (const x of f.exchanges) {
        const r = schemaFor(x.request.path).safeParse(x.response.body);
        expect(r.success, `${f.stream} ${x.request.path}: ${r.error?.message}`).toBe(true);
      }
    }
  });

  test('no two exchanges answer the same request', () => {
    const seen = new Set<string>();
    for (const f of deereReplayFixtures) {
      for (const x of f.exchanges) {
        const key = `${x.request.method} ${x.request.path} ${JSON.stringify(x.request.query ?? {})}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });

  test('vendor ids are the ones the demo seed maps (machines, fields, boundaries)', () => {
    const refs = simExternalRefs(fixtureFarm());
    const known = new Set(refs.map((r) => `${r.ref.kind}|${r.ref.sourceOrg}|${r.ref.externalId}`));
    const body = (stream: string, p: RegExp) =>
      (
        built[Object.keys(built).find((k) => k.startsWith(`${stream}/`)) as string] as ReplayFixture
      ).exchanges
        .filter((x) => p.test(x.request.path))
        .flatMap((x) => (x.response.body as { values: { id: string; links?: never[] }[] }).values);
    // Machines come from the Equipment API; the refs (and breadcrumb paths) use the principalId.
    const loc = built['locations/01-machine-locations.json'] as ReplayFixture;
    const machines = loc.exchanges
      .filter((x) => x.request.path === '/isg/equipment')
      .filter((x) => x.request.query?.organizationIds === 'org-home')
      .flatMap(
        (x) => (x.response.body as { values: { id: string; principalId: number }[] }).values,
      );
    expect(machines.length).toBe(6);
    for (const m of machines) {
      expect(known.has(`machine|org-home|${m.principalId}`)).toBe(true);
      expect(m.id).not.toBe(String(m.principalId));
    }
    const fields = body('fields', /^\/organizations\/org-home\/fields/);
    expect(fields.length).toBeGreaterThan(25); // paged: more than one page
    const mapped = fields.filter((f) => known.has(`field|org-home|${f.id}`));
    expect(mapped.length).toBe(fields.length);
    const boundaries = body('boundaries', /^\/organizations\/org-home\/boundaries$/);
    for (const b of boundaries) expect(known.has(`boundary|org-home|${b.id}`)).toBe(true);
    for (const b of boundaries) {
      expect(fields.map((f) => f.id)).toContain(deereLinkId(b.links, 'field'));
    }
  });

  test('breadcrumbs cover one replay period and only working machines report', () => {
    const loc = built['locations/01-machine-locations.json'] as ReplayFixture;
    const anchor = Date.parse(loc.anchor);
    const period = (loc.shiftStepSeconds ?? 60) * 1000;
    expect(period).toBe(30 * 60_000);
    let total = 0;
    for (const x of loc.exchanges.filter((e) => e.request.path.endsWith('/breadcrumbs'))) {
      const values = (
        x.response.body as { values: { eventTimestamp: string; machineState: { value: string } }[] }
      ).values;
      total += values.length;
      for (const b of values) {
        const t = Date.parse(b.eventTimestamp);
        expect(t).toBeGreaterThanOrEqual(anchor);
        expect(t).toBeLessThan(anchor + period);
        expect(b.machineState.value).toBe('Working');
      }
    }
    expect(total).toBeGreaterThan(60);
  });
});

describe("deere-data's 1f fixtures (20-29)", () => {
  const refs = simExternalRefs(fixtureFarm());
  const known = new Set(refs.map((r) => `${r.ref.kind}|${r.ref.sourceOrg}|${r.ref.externalId}`));
  const only = simDeereOnlyField(fixtureFarm());
  const values = (f: ReplayFixture, p: RegExp) =>
    f.exchanges
      .filter((x) => p.test(x.request.path))
      .flatMap(
        (x) =>
          (x.response.body as { values: { id: string; links?: { rel: string; uri: string }[] }[] })
            .values,
      );

  test('the committed files are what the builder makes, and ../fields/replay.ts ships them', () => {
    for (const [rel, fixture] of Object.entries(built1f)) {
      const file = path.join(dir, ...rel.split('/'));
      const committed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      expect(
        committed,
        `${rel} is out of date: run src/connectors/deere/fixtures/write.ts`,
      ).toEqual(JSON.parse(JSON.stringify(fixture)));
      expect(rel).toMatch(/^[a-z]+\/2\d-[a-z0-9-]+\.json$/);
    }
    expect(deereFieldsReplayFixtures).toHaveLength(Object.keys(built1f).length);
    expect(deereReplayFixtures).toEqual(expect.arrayContaining([...deereFieldsReplayFixtures]));
    // Before the 1a ones (first match wins).
    const firstOwn = deereReplayFixtures.indexOf(deereFieldsReplayFixtures[0] as ReplayFixture);
    const first1a = deereReplayFixtures.indexOf(deereDocDerived1aFixtures[0] as ReplayFixture);
    expect(firstOwn).toBeLessThan(first1a);
  });

  test('replay contract, live schemas, a whole-day shift step, the client query on every request', () => {
    for (const [rel, f] of Object.entries(built1f)) {
      const parsed = replayFixtureSchema.parse(f);
      expect(rel.startsWith(`${parsed.stream}/`)).toBe(true);
      expect(parsed).toMatchObject({
        source: 'deere',
        kind: 'doc-derived',
        shiftStepSeconds: 86_400,
      });
      expect(parsed.reference).toMatch(/https:\/\/developer\.deere\.com\/dev-docs\//);
      expect(parsed.reference).toMatch(/no real farm data/);
      for (const x of parsed.exchanges) {
        expect(Object.keys(x.request.query ?? {}).length, x.request.path).toBeGreaterThan(0);
        const r = schemaFor(x.request.path).safeParse(x.response.body);
        expect(r.success, `${parsed.stream} ${x.request.path}: ${r.error?.message}`).toBe(true);
      }
    }
  });

  test('every id maps onto the seed (fields, owning boundaries, flags, machines) but the Deere-only field', () => {
    const fields = built1f['fields/20-fields.json'] as ReplayFixture;
    const listed = fields.exchanges.filter((x) => /\/fields$/.test(x.request.path));
    let deereOnly = 0;
    for (const x of listed) {
      const org = x.request.path.split('/')[2] as string;
      for (const f of (x.response.body as { values: { id: string; farms?: unknown }[] }).values) {
        expect(f.farms).toBeDefined();
        if (f.id === only?.deereFieldId) {
          deereOnly++;
          expect(org).toBe('org-home');
          continue;
        }
        expect(known.has(`field|${org}|${f.id}`), `${org} ${f.id}`).toBe(true);
      }
    }
    expect(deereOnly).toBe(1);
    const homeBoundaries = values(fields, /^\/organizations\/org-home\/boundaries$/);
    for (const b of homeBoundaries) {
      if (deereLinkId(b.links, 'field') === only?.deereFieldId) continue;
      expect(known.has(`boundary|org-home|${b.id}`)).toBe(true);
    }
    const flags = built1f['flags/20-flags.json'] as ReplayFixture;
    for (const x of flags.exchanges) {
      const org = x.request.path.split('/')[2] as string;
      for (const f of (x.response.body as { values: { links: { rel: string; uri: string }[] }[] })
        .values) {
        expect(known.has(`field|${org}|${deereLinkId(f.links, 'field')}`)).toBe(true);
      }
    }
    expect(values(flags, /flags$/).length).toBeGreaterThan(10);
    const hours = built1f['hours/20-engine-hours.json'] as ReplayFixture;
    expect(hours.exchanges).toHaveLength(6);
    for (const x of hours.exchanges) {
      expect(known.has(`machine|org-home|${x.request.path.split('/')[2]}`)).toBe(true);
    }
  });
});
