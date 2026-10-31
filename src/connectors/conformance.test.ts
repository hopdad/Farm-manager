/**
 * The CI conformance test (1f decision 3, docs/contracts-1f.md §8): the vendor stand-in's replies
 * have the shapes of the vendors' own, for
 *   1. every doc-derived replay fixture (deereReplayFixtures, samsaraReplayFixtures: the 1a ones,
 *      and the 1f builders' once they merge), each exchange against the stand-in's reply to the
 *      same request (demo world); and
 *   2. scrubbed recordings: `connectors:record deere|samsara --scrub` run against that stand-in in
 *      this test (into a temp dir, never committed) plus the committed recorded lists (empty in
 *      1f), each exchange against the stand-in's reply of the same endpoint.
 * No JSON type may disagree; a key the vendor sends that the stand-in leaves out must be a
 * TOLERATED_GAPS entry. Endpoints the stand-in answers 404 "not simulated" are skipped (listed).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { recordSource } from '../../tools/record/record';
import { createSimWorld } from '../sim/index';
import { SIM_CREDENTIALS } from '../sim/types';
import { startVendorSim, type VendorSim } from '../sim/vendors/server';
import {
  compareShapes,
  endpointTemplate,
  mergeShapes,
  type Shape,
  shapeOf,
  standInRequest,
  untoleratedMissing,
} from './conformance';
import { simAutoConnect } from './deere/oauth';
import { deereReplayFixtures } from './deere/replay';
import { deereRecordedFixtures } from './deere/replay-recorded';
import { DEERE_EQUIPMENT_MEDIA_TYPE, DEERE_MEDIA_TYPE } from './deere/schemas';
import { type ConnectorConfig, deereEndpoints } from './endpoints';
import { MemoryTokenStore } from './oauth/memory-store';
import { type ReplayFixture, replayFixtureSchema } from './replay';
import { samsaraReplayFixtures } from './samsara/replay';
import { samsaraRecordedFixtures } from './samsara/replay-recorded';

let sim: VendorSim;
let cfg: ConnectorConfig;
let deereToken = '';
const tmp = mkdtempSync(path.join(tmpdir(), 'farm-conformance-'));

/** The stand-in's reply shape per (source, endpoint template), from the doc-derived pass. */
const samples = new Map<string, Shape>();
const skipped: string[] = [];

async function standIn(source: string, url: URL): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> =
    source === 'deere'
      ? {
          authorization: `Bearer ${deereToken}`,
          accept: url.pathname.includes('/deere/isg/')
            ? DEERE_EQUIPMENT_MEDIA_TYPE
            : DEERE_MEDIA_TYPE,
        }
      : { authorization: `Bearer ${SIM_CREDENTIALS.samsara.apiToken}`, accept: 'application/json' };
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.json() };
}

const notSimulated = (body: unknown) => /not simulated/.test(JSON.stringify(body));

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0 });
  cfg = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3114' };
  deereToken = await simAutoConnect(deereEndpoints('sim', cfg), new MemoryTokenStore('deere'));
}, 60_000);
afterAll(async () => {
  await sim?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('doc-derived fixtures vs the stand-in', () => {
  test('every served endpoint has the vendor shape (types agree, gaps known)', async () => {
    const compared = new Set<string>();
    const problems: string[] = [];
    const unknownIds: string[] = [];
    for (const fixture of [...deereReplayFixtures, ...samsaraReplayFixtures]) {
      const byUrl = new Map<string, { url: URL; template: string; bodies: unknown[] }>();
      for (const x of fixture.exchanges) {
        if (x.response.status >= 300) continue;
        const url = standInRequest(sim.url, fixture, x, new Date());
        const key = url.toString();
        const entry = byUrl.get(key) ?? {
          url,
          template: endpointTemplate(x.request.path),
          bodies: [],
        };
        entry.bodies.push(x.response.body);
        byUrl.set(key, entry);
      }
      for (const { url, template, bodies } of byUrl.values()) {
        const reply = await standIn(fixture.source, url);
        if (reply.status === 404 && notSimulated(reply.body)) {
          skipped.push(`${fixture.source} ${template}`);
          continue;
        }
        // A replay-only record (the 1a operations, deere-ops' burndown) is unknown to the
        // stand-in by id; its endpoint is still compared through the other ids (below).
        if (reply.status === 404 && template.includes('{}')) {
          unknownIds.push(`${fixture.source} ${url.pathname}`);
          continue;
        }
        expect(reply.status, `${fixture.source} ${url.pathname}`).toBe(200);
        const actual = shapeOf(reply.body);
        const key = `${fixture.source}|${template}`;
        samples.set(key, mergeShapes(samples.get(key) ?? {}, actual));
        const diff = compareShapes(mergeShapes(...bodies.map(shapeOf)), actual);
        const missing = untoleratedMissing(fixture.source, template, diff.missing);
        for (const m of diff.mismatched) {
          problems.push(
            `${key}: ${m.path} is ${m.expected.join('|')} in the fixture, ${m.actual.join('|')} in the stand-in`,
          );
        }
        for (const m of missing) problems.push(`${key}: the stand-in never sends ${m}`);
        compared.add(key);
      }
    }
    expect(problems).toEqual([]);
    // Replay-only ids (the 1a operations, the 30 fixture's burndown) are skipped, but their
    // endpoints are still compared through the ids the stand-in serves.
    for (const key of [
      'deere|/organizations/{}/fields/{}/fieldOperations',
      'deere|/fieldOperations/{}/boundary',
    ]) {
      expect(compared, `${key} (skipped ids: ${unknownIds.length})`).toContain(key);
    }
    // Not vacuous: the 1a endpoints the core stand-in serves were all compared.
    for (const key of [
      'deere|/organizations',
      'deere|/isg/equipment',
      'deere|/machines/{}/breadcrumbs',
      'deere|/organizations/{}/fields',
      'samsara|/fleet/vehicles/locations/feed',
      'samsara|/fleet/vehicles/stats/feed',
    ]) {
      expect(compared, key).toContain(key);
    }
  }, 60_000);
});

describe('recordings vs the stand-in (connectors:record --scrub against sim, in this test)', () => {
  function readFixtures(dir: string): ReplayFixture[] {
    const out: ReplayFixture[] = [];
    for (const stream of readdirSync(dir)) {
      for (const f of readdirSync(path.join(dir, stream))) {
        out.push(
          replayFixtureSchema.parse(
            JSON.parse(readFileSync(path.join(dir, stream, f), 'utf8')),
          ) as ReplayFixture,
        );
      }
    }
    return out;
  }

  test('scrubbed recordings keep the shapes the stand-in serves', async () => {
    const recorded: ReplayFixture[] = [...deereRecordedFixtures, ...samsaraRecordedFixtures];
    for (const source of ['deere', 'samsara'] as const) {
      const out = path.join(tmp, source, 'scrubbed');
      const report = await recordSource({
        source,
        mode: 'sim',
        cfg,
        scrub: true,
        outDir: out,
        rawDir: path.join(tmp, source, 'raw'),
      });
      expect(report.scrubErrors).toEqual([]);
      expect(report.failed).toEqual([]);
      recorded.push(...readFixtures(out));
    }
    const problems: string[] = [];
    let compared = 0;
    for (const fixture of recorded) {
      for (const x of fixture.exchanges) {
        if (x.response.status >= 300) continue;
        const template = endpointTemplate(x.request.path);
        const sample = samples.get(`${fixture.source}|${template}`);
        if (!sample) continue;
        const diff = compareShapes(shapeOf(x.response.body), sample);
        for (const m of diff.mismatched) {
          problems.push(
            `${fixture.source} ${template}: ${m.path} ${m.expected.join('|')} vs ${m.actual.join('|')}`,
          );
        }
        compared++;
      }
    }
    expect(problems).toEqual([]);
    expect(compared).toBeGreaterThanOrEqual(5);
  }, 60_000);
});
