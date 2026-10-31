/**
 * `pnpm connectors:record deere|samsara --scrub --out <tmp>` against the in-process stand-in
 * (1f decision 3, docs/contracts-1f.md §11.4): raw files and scrubbed fixtures are written (to temp
 * dirs: nothing is committed), the scrubbed ones pass the live schemas and replayFixtureSchema with
 * no original id or name left, endpoints the stand-in answers 404 "not simulated" are skipped and
 * listed, no token or OAuth exchange is ever written, and the scrubbed fixtures replay through the
 * live client. Also the CLI's arguments.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseRecordArgs, UsageError } from '../../scripts/connectors-record';
import { DeereClient } from '../../src/connectors/deere/client';
import type { ConnectorConfig } from '../../src/connectors/endpoints';
import { type ReplayFixture, replayFixtureSchema } from '../../src/connectors/replay';
import { buildDemoFarm } from '../../src/sim/farm/build';
import { createSimWorld } from '../../src/sim/index';
import { SIM_CREDENTIALS, SIM_DEERE_HOME_ORG } from '../../src/sim/types';
import { startVendorSim, type VendorSim } from '../../src/sim/vendors/server';
import { RecordError, type RecordReport, recordSource } from './record';
import { DEMO_AREA_CENTER } from './scrub';

let sim: VendorSim;
let cfg: ConnectorConfig;
const tmp = mkdtempSync(path.join(tmpdir(), 'farm-record-'));
const farm = buildDemoFarm();
let deere: RecordReport;

const read = (f: string) => readFileSync(f, 'utf8');

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0 });
  cfg = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3114' };
  deere = await recordSource({
    source: 'deere',
    mode: 'sim',
    cfg,
    scrub: true,
    outDir: path.join(tmp, 'deere', 'out'),
    rawDir: path.join(tmp, 'deere', 'raw'),
    salt: 'record-test',
  });
}, 60_000);
afterAll(async () => {
  await sim?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('connectors:record deere --scrub (sim)', () => {
  test('raw and scrubbed files per stream; every endpoint recorded or listed as skipped', () => {
    expect(deere.failed).toEqual([]);
    expect(deere.scrubErrors).toEqual([]);
    const streams = (files: string[]) => files.map((f) => path.basename(path.dirname(f))).sort();
    expect(streams(deere.rawFiles)).toEqual(
      expect.arrayContaining(['fields', 'locations', 'organizations']),
    );
    expect(streams(deere.fixtureFiles)).toEqual(streams(deere.rawFiles));
    for (const f of deere.rawFiles) expect(f.startsWith(path.join(tmp, 'deere', 'raw'))).toBe(true);
    for (const f of deere.fixtureFiles)
      expect(f.startsWith(path.join(tmp, 'deere', 'out'))).toBe(true);
    // What the 1f modules serve after the merge is skipped here (404 "not simulated"), listed.
    for (const s of deere.skipped) {
      expect(s.path).toMatch(/^\/deere\/(platform|isg)\//);
      expect([
        'farms',
        'clients',
        'boundaries',
        'flags',
        'engine-hours',
        'field-operations',
        'fields',
        'measurement-types',
      ]).toContain(s.name);
    }
  });

  test('no token, authorization header or OAuth exchange is ever written, not even raw', () => {
    for (const f of [...deere.rawFiles, ...deere.fixtureFiles]) {
      const text = read(f);
      expect(text).not.toMatch(/oauth2|access_token|refresh_token|authorization|Bearer/i);
    }
  });

  test('scrubbed: valid fixtures, kind recorded, no original id or name, coordinates in the demo area', () => {
    const originals = [
      SIM_DEERE_HOME_ORG,
      ...farm.fields.slice(0, 5).map((f) => f.name),
      ...farm.fields.slice(0, 5).map((f) => f.deereFieldId),
      ...farm.machines.filter((m) => m.vendorIds.deere).map((m) => m.vendorIds.deere as string),
    ];
    for (const f of deere.fixtureFiles) {
      const text = read(f);
      const fixture = replayFixtureSchema.parse(JSON.parse(text));
      expect(fixture).toMatchObject({ source: 'deere', kind: 'recorded', basePath: '/platform' });
      expect(fixture.reference).toMatch(/no real farm data/);
      for (const o of originals)
        expect(text, `${o} in ${path.basename(f)}`).not.toContain(`"${o}"`);
      for (const m of text.matchAll(/"lat": (-?\d+\.\d+)/g)) {
        expect(Math.abs(Number(m[1]) - DEMO_AREA_CENTER.lat)).toBeLessThan(0.5);
      }
    }
    // The raw files do keep the originals (local only, gitignored).
    expect(deere.rawFiles.map(read).join('')).toContain(SIM_DEERE_HOME_ORG);
  });

  test('the scrubbed fixtures replay through the live client (ids line up across calls)', async () => {
    const fixtures = deere.fixtureFiles.map((f) => JSON.parse(read(f)) as ReplayFixture);
    const client = DeereClient.forReplay(cfg, { now: () => new Date(deere.recordedAt) }, fixtures);
    const orgs = await client.organizations();
    expect(orgs.length).toBeGreaterThanOrEqual(2);
    expect(orgs.map((o) => o.id)).not.toContain(SIM_DEERE_HOME_ORG);
    const machines = (await Promise.all(orgs.map((o) => client.machines(o.id)))).flat();
    expect(machines.length).toBeGreaterThan(0);
    expect(machines.every((m) => typeof m.principalId !== 'undefined')).toBe(true);
    // The recorded machine's breadcrumbs answer under its hashed principalId (ids line up).
    const first = machines[0];
    if (!first) throw new Error('no machine recorded');
    const at = Date.parse(deere.recordedAt);
    const crumbs = await client.breadcrumbs(
      String(first.principalId),
      new Date(at - 3600_000),
      new Date(at),
    );
    expect(Array.isArray(crumbs)).toBe(true);
  });
});

describe('connectors:record samsara --scrub (sim)', () => {
  test('the feeds recorded and scrubbed; vehicle ids hashed, cursors replaced', async () => {
    const r = await recordSource({
      source: 'samsara',
      mode: 'sim',
      cfg,
      scrub: true,
      outDir: path.join(tmp, 'samsara', 'out'),
      rawDir: path.join(tmp, 'samsara', 'raw'),
    });
    expect(r.failed).toEqual([]);
    expect(r.scrubErrors).toEqual([]);
    expect(r.fixtureFiles.map((f) => path.basename(path.dirname(f))).sort()).toEqual([
      'faults',
      'positions',
      'stats',
    ]);
    const text = r.fixtureFiles.map(read).join('');
    for (const m of farm.machines.filter((x) => x.telematics?.vendor === 'samsara')) {
      expect(text).not.toContain(`"${m.telematics?.id}"`);
    }
    expect(text).not.toContain(SIM_CREDENTIALS.samsara.apiToken);
  });

  test('replay and off are refused', async () => {
    for (const mode of ['replay', 'off'] as const) {
      await expect(
        recordSource({ source: 'samsara', mode, cfg, scrub: false, rawDir: tmp }),
      ).rejects.toBeInstanceOf(RecordError);
    }
  });
});

describe('parseRecordArgs', () => {
  test('source, --scrub, --out, --raw', () => {
    expect(parseRecordArgs(['deere'])).toEqual({
      source: 'deere',
      scrub: false,
      out: null,
      raw: null,
    });
    const a = parseRecordArgs(['samsara', '--scrub', '--out', 'x/y', '--raw', 'r']);
    expect(a).toMatchObject({ source: 'samsara', scrub: true });
    expect(path.isAbsolute(a.out as string)).toBe(true);
    expect(() => parseRecordArgs([])).toThrow(UsageError);
    expect(() => parseRecordArgs(['qbo'])).toThrow(/unknown source/);
    expect(() => parseRecordArgs(['deere', '--out', 'x'])).toThrow(/--out needs --scrub/);
    expect(() => parseRecordArgs(['deere', '--bogus'])).toThrow(UsageError);
  });
});
