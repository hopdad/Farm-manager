/**
 * The Samsara doc-derived replay fixtures: well-formed, every body valid under the live client's
 * schemas, every vehicle one the demo seed maps, the cursor loop closed, and the committed JSON
 * equal to ./build.ts's output (regenerate: `pnpm exec tsx
 * src/connectors/samsara/fixtures/write.ts`, then `pnpm lint:fix`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildDemoFarm } from '../../../sim/farm/build';
import { simExternalRefs } from '../../../sim/types';
import { type ReplayFixture, replayFixtureSchema } from '../../replay';
import { samsaraDocDerivedFixtures, samsaraReplayFixtures } from '../replay';
import { samsaraLocationsFeedSchema, samsaraStatsFeedSchema } from '../schemas';
import { buildSamsaraDocDerivedFixtures, LOOP_PAGES, loopCursor, STATS_CURSOR } from './build';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-derived');
const built = buildSamsaraDocDerivedFixtures();
const positions = built['positions/01-locations-feed.json'] as ReplayFixture;
const stats = built['stats/01-stats-feed.json'] as ReplayFixture;

describe('Samsara doc-derived fixtures', () => {
  test('the committed files are what the builder makes (and replay.ts ships all of them)', () => {
    for (const [rel, fixture] of Object.entries(built)) {
      const committed = JSON.parse(readFileSync(path.join(dir, ...rel.split('/')), 'utf8'));
      expect(
        committed,
        `${rel} is out of date: run src/connectors/samsara/fixtures/write.ts`,
      ).toEqual(JSON.parse(JSON.stringify(fixture)));
    }
    expect(samsaraDocDerivedFixtures).toHaveLength(Object.keys(built).length);
    expect(samsaraReplayFixtures).toEqual(expect.arrayContaining(samsaraDocDerivedFixtures));
  });

  test('layout, metadata and the live schemas', () => {
    for (const [rel, f] of Object.entries(built)) {
      const parsed = replayFixtureSchema.parse(f);
      expect(rel.startsWith(`${parsed.stream}/`)).toBe(true);
      expect(parsed.reference).toMatch(/https:\/\/developers\.samsara\.com\/reference\//);
      expect(parsed.reference).toMatch(/no real farm data/);
    }
    for (const x of positions.exchanges) {
      expect(samsaraLocationsFeedSchema.safeParse(x.response.body).success).toBe(true);
    }
    for (const x of stats.exchanges) {
      expect(samsaraStatsFeedSchema.safeParse(x.response.body).success).toBe(true);
    }
  });

  test('a closed loop: every cursor a page hands out leads to exactly one next page', () => {
    const byAfter = new Map(
      positions.exchanges
        .filter((x) => x.request.query?.after)
        .map((x) => [
          x.request.query?.after as string,
          x.response.body as { pagination: { endCursor: string } },
        ]),
    );
    expect(byAfter.size).toBe(LOOP_PAGES);
    const first = positions.exchanges.at(-1);
    expect(first?.request.query).toBeUndefined(); // the fallback comes last (first match wins)
    let cursor = (first?.response.body as { pagination: { endCursor: string } } | undefined)
      ?.pagination.endCursor as string;
    expect(cursor).toBe(loopCursor(0));
    const seen = new Set<string>();
    for (let i = 0; i < LOOP_PAGES; i++) {
      seen.add(cursor);
      cursor = (byAfter.get(cursor) as { pagination: { endCursor: string } }).pagination.endCursor;
    }
    expect(cursor).toBe(loopCursor(0));
    expect(seen.size).toBe(LOOP_PAGES);
    const statsAfter = stats.exchanges.find((x) => x.request.query?.after === STATS_CURSOR);
    expect((statsAfter?.response.body as { data: unknown[] } | undefined)?.data).toEqual([]);
  });

  test('every vehicle is a Samsara truck the demo seed maps; all four trucks every page', () => {
    const farm = buildDemoFarm();
    const semis = new Set(farm.machines.filter((m) => m.kind === 'semi').map((m) => m.id));
    const refs = simExternalRefs(farm).filter(
      (r) => r.ref.source === 'samsara' && semis.has(r.entityId),
    );
    const known = new Set(refs.map((r) => r.ref.externalId));
    expect(known.size).toBe(4);
    for (const x of positions.exchanges) {
      const ids = (x.response.body as { data: { id: string }[] }).data.map((v) => v.id);
      expect(new Set(ids)).toEqual(known);
    }
  });
});
