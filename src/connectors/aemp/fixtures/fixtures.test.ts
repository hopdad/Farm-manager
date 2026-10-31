/**
 * The AEMP doc-derived replay fixtures: the committed JSON is ./build.ts's output (regenerate:
 * `pnpm exec tsx src/connectors/aemp/fixtures/write.ts`, then `pnpm lint:fix`), well-formed,
 * every body read by the live parser with nothing dropped, every machine one the demo seed maps,
 * and no two exchanges answering the same request.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildDemoFarm } from '../../../sim/farm/build';
import { simExternalRefs } from '../../../sim/types';
import { replayFixtureSchema } from '../../replay';
import { aempBodyValue, parseFleetPage } from '../parse';
import { aempReplayFixtures } from '../replay';
import { buildAempDocDerivedFixtures } from './build';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-derived');
const built = buildAempDocDerivedFixtures();

describe('AEMP doc-derived fixtures', () => {
  test('the committed files are what the builder makes, and replay.ts ships all of them', () => {
    for (const [rel, fixture] of Object.entries(built)) {
      const committed = JSON.parse(readFileSync(path.join(dir, ...rel.split('/')), 'utf8'));
      expect(committed, `${rel} is out of date: run src/connectors/aemp/fixtures/write.ts`).toEqual(
        JSON.parse(JSON.stringify(fixture)),
      );
    }
    expect(aempReplayFixtures).toHaveLength(Object.keys(built).length);
  });

  test('layout, metadata, and every body read by the live parser', () => {
    for (const [rel, f] of Object.entries(built)) {
      const parsed = replayFixtureSchema.parse(f);
      expect(rel.startsWith(`${parsed.stream}/`)).toBe(true);
      expect(parsed.reference).toMatch(/no real farm data/);
      expect(parsed.reference).toMatch(
        /https:\/\/(standards\.iso\.org|developers\.samsara\.com)\//,
      );
      for (const x of parsed.exchanges) {
        const provider = x.request.path.split('/')[1] as string;
        const page = parseFleetPage(
          aempBodyValue(JSON.stringify(x.response.body), 'application/json', 'auto'),
          provider === 'samsara' ? 'EquipmentID' : undefined,
        );
        expect(page.dropped).toEqual([]);
        expect(page.machines.length).toBeGreaterThan(0);
      }
    }
  });

  test('every machine is one the demo seed maps under its provider', () => {
    const refs = simExternalRefs(buildDemoFarm())
      .filter((r) => r.ref.source === 'aemp')
      .map((r) => `${r.ref.sourceOrg}:${r.ref.externalId}`);
    const seen: string[] = [];
    for (const f of Object.values(built)) {
      for (const x of f.exchanges) {
        const provider = x.request.path.split('/')[1] as string;
        const page = parseFleetPage(
          aempBodyValue(JSON.stringify(x.response.body), 'application/json', 'auto'),
          provider === 'samsara' ? 'EquipmentID' : undefined,
        );
        seen.push(...page.machines.map((m) => `${provider}:${m.id}`));
      }
    }
    expect(seen.sort()).toEqual([...refs].sort());
  });

  test('no two exchanges answer the same request', () => {
    const keys = aempReplayFixtures.flatMap((f) =>
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
