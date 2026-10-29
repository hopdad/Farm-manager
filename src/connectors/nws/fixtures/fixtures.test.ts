/**
 * The NWS doc-derived replay fixtures: the committed JSON is ./build.ts's output (regenerate:
 * `pnpm exec tsx src/connectors/nws/fixtures/write.ts`, then `pnpm lint:fix`), the metadata
 * follows the replay contract, and every body is valid under the live client's schemas.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { replayFixtureSchema } from '../../replay';
import { nwsReplayFixtures } from '../replay';
import {
  nwsGridpointSchema,
  nwsObservationCollectionSchema,
  nwsPointSchema,
  nwsStationCollectionSchema,
} from '../schemas';
import { buildNwsDocDerivedFixtures } from './build';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'doc-derived');
const built = buildNwsDocDerivedFixtures();

const SCHEMAS = {
  points: nwsPointSchema,
  stations: nwsStationCollectionSchema,
  forecast: nwsGridpointSchema,
  observations: nwsObservationCollectionSchema,
} as const;

describe('NWS doc-derived fixtures', () => {
  test('the committed files are what the builder makes, and replay.ts ships all of them', () => {
    for (const [rel, fixture] of Object.entries(built)) {
      const committed = JSON.parse(readFileSync(path.join(dir, ...rel.split('/')), 'utf8'));
      expect(committed, `${rel} is out of date: run src/connectors/nws/fixtures/write.ts`).toEqual(
        JSON.parse(JSON.stringify(fixture)),
      );
    }
    expect(nwsReplayFixtures).toHaveLength(Object.keys(built).length);
  });

  test('metadata, layout and the live schemas', () => {
    for (const [rel, f] of Object.entries(built)) {
      const parsed = replayFixtureSchema.parse(f);
      expect(rel.startsWith(`${parsed.stream}/`)).toBe(true);
      expect(parsed.kind).toBe('doc-derived');
      expect(parsed.reference).toMatch(/api\.weather\.gov\/openapi\.json/);
      expect(parsed.reference).toMatch(/no real farm data/);
      // Whole-hour shifts keep NWS's hour-aligned intervals aligned.
      expect(parsed.shiftStepSeconds).toBe(3600);
      expect(Date.parse(parsed.anchor) % 3_600_000).toBe(0);
      const schema = SCHEMAS[parsed.stream as keyof typeof SCHEMAS];
      expect(schema, `no schema for stream ${parsed.stream}`).toBeDefined();
      for (const x of parsed.exchanges) {
        const r = schema.safeParse(x.response.body);
        expect(r.success, `${rel} ${x.request.path}: ${r.error?.message}`).toBe(true);
      }
    }
  });

  test('like real grids: a gust gap and no transportWindSpeed layer', () => {
    const fx = built['forecast/01-gridpoint.json'];
    const body = nwsGridpointSchema.parse(fx?.exchanges[0]?.response.body);
    expect(body.properties.transportWindSpeed).toBeUndefined();
    expect(body.properties.windGust?.values.some((v) => v.value === null)).toBe(true);
  });
});
