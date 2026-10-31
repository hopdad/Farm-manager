/**
 * The Terminal doc-derived replay fixtures: well-formed, every body valid under the live
 * client's schemas, every vehicle the one the demo seed maps (under its connection), no two
 * exchanges answering the same request, and the committed JSON equal to ./build.ts's output
 * (regenerate: `pnpm exec tsx src/connectors/terminal/fixtures/write.ts`, then `pnpm lint:fix`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildDemoFarm } from '../../../sim/farm/build';
import { SIM_TERMINAL_CONNECTION_ID, simExternalRefs } from '../../../sim/types';
import { type ReplayFixture, replayFixtureSchema } from '../../replay';
import { terminalReplayFixtures } from '../replay';
import {
  expandedId,
  terminalConnectionSchema,
  terminalFaultEventSchema,
  terminalHistoricalLocationSchema,
  terminalLatestLocationSchema,
  terminalListSchema,
  terminalProviderSchema,
  terminalStatLogSchema,
  terminalVehicleSchema,
} from '../schemas';
import { buildTerminalDocDerivedFixtures } from './build';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-derived');
const built = buildTerminalDocDerivedFixtures();

const ITEM_SCHEMAS: Record<string, { safeParse(v: unknown): { success: boolean } }[]> = {
  connections: [terminalConnectionSchema],
  vehicles: [terminalVehicleSchema],
  positions: [terminalLatestLocationSchema, terminalHistoricalLocationSchema],
  stats: [terminalStatLogSchema],
  faults: [terminalFaultEventSchema],
};

describe('Terminal doc-derived fixtures', () => {
  test('the committed files are what the builder makes, and replay.ts ships all of them', () => {
    for (const [rel, fixture] of Object.entries(built)) {
      const committed = JSON.parse(readFileSync(path.join(dir, ...rel.split('/')), 'utf8'));
      expect(
        committed,
        `${rel} is out of date: run src/connectors/terminal/fixtures/write.ts`,
      ).toEqual(JSON.parse(JSON.stringify(fixture)));
    }
    expect(terminalReplayFixtures).toEqual(
      Object.values(built).map((f) => JSON.parse(JSON.stringify(f))),
    );
  });

  test('layout, metadata, and every body valid under the live schemas', () => {
    for (const [rel, f] of Object.entries(built)) {
      const parsed = replayFixtureSchema.parse(f);
      expect(rel.startsWith(`${parsed.stream}/`)).toBe(true);
      expect(parsed.source).toBe('terminal');
      expect(parsed.reference).toMatch(/https:\/\/api\.withterminal\.com\/tsp\/openapi/);
      expect(parsed.reference).toMatch(/no real farm data/);
      for (const x of parsed.exchanges) {
        expect(x.response.status).toBe(200);
        if (parsed.stream === 'providers') {
          const list = x.response.body as unknown[];
          expect(list.length).toBeGreaterThan(0);
          for (const p of list) expect(terminalProviderSchema.safeParse(p).success).toBe(true);
          continue;
        }
        const body = terminalListSchema.parse(x.response.body);
        expect(body.next ?? null).toBeNull(); // one page each
        const schemas = ITEM_SCHEMAS[parsed.stream] ?? [];
        for (const item of body.results) {
          expect(
            schemas.some((s) => s.safeParse(item).success),
            `${rel}: an item fails the live schemas`,
          ).toBe(true);
        }
      }
    }
  });

  test('every vehicle is the one the demo seed maps under its connection', () => {
    const refs = simExternalRefs(buildDemoFarm()).filter(
      (r) => r.ref.source === 'terminal' && r.ref.kind === 'machine',
    );
    expect(refs.map((r) => r.ref.sourceOrg)).toEqual([SIM_TERMINAL_CONNECTION_ID]);
    const mapped = new Set(refs.map((r) => r.ref.externalId));
    const seen = new Set<string>();
    for (const f of Object.values(built)) {
      for (const x of f.exchanges) {
        const m = /^\/vehicles\/([^/]+)\//.exec(x.request.path);
        if (m) seen.add(m[1] as string);
        const body = x.response.body as { results?: { vehicle?: unknown; id?: string }[] };
        for (const item of body.results ?? []) {
          if (f.stream === 'vehicles') seen.add(item.id as string);
          else if (item.vehicle) seen.add(expandedId(item.vehicle as string));
        }
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const id of seen) expect(mapped.has(id), id).toBe(true);
    const conns = (built['connections/01-connections.json'] as ReplayFixture).exchanges[0]?.response
      .body as { results: { id: string }[] };
    expect(conns.results.map((c) => c.id)).toEqual([SIM_TERMINAL_CONNECTION_ID]);
  });

  test('no two exchanges answer the same request', () => {
    const keys = terminalReplayFixtures.flatMap((f) =>
      f.exchanges.map((x) =>
        JSON.stringify([
          x.request.method,
          `${f.basePath ?? ''}${x.request.path}`,
          x.request.query ?? {},
          x.request.body ?? null,
        ]),
      ),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('history breadcrumbs are stored after the fact (modifiedAt after locatedAt), oldest first', () => {
    const positions = built['positions/01-locations.json'] as ReplayFixture;
    const hist = positions.exchanges.find((x) =>
      /^\/vehicles\/vcl_[^/]+\/locations$/.test(x.request.path),
    )?.response.body as {
      results: { locatedAt: string; metadata: { modifiedAt: string } }[];
    };
    const times = hist.results.map((h) => Date.parse(h.locatedAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const h of hist.results) {
      expect(Date.parse(h.metadata.modifiedAt)).toBeGreaterThan(Date.parse(h.locatedAt));
    }
    expect(positions.shiftStepSeconds).toBe(1);
  });
});
