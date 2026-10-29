/**
 * gis:naip end to end on the fixture transport (no network), against a real database and a temp
 * project directory: the online row, the AOI from the fields (+ 1 mile), the download run with
 * its raw cache and manifest (and resume), the JPEG PMTiles read back with the `pmtiles` reader,
 * content-addressed storage, the `naip_aoi` row, the previous archive removed only after the row
 * moved, and an offline rebuild that reproduces the same bytes.
 */
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PMTiles, type Source, TileType } from 'pmtiles';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ResolvedMapLayer } from '../../src/domain/map-layers';
import { LocalStorageWriter } from '../../src/platform/storage/writer';
import { setupTestDb } from '../../src/test/db';
import { insertField, squareMultiPolygon } from '../../src/test/fixtures';
import { naipAoiLayer, naipLayer } from '../../src/ui/map/layers/naip';
import { resolveLayers } from '../../src/ui/map/layers/types';
import {
  buildArchive,
  fetchRun,
  installAoiArchive,
  newestCompleteRun,
  RUN_INDEX_FILE,
  RUN_PARTIAL_FILE,
  resolveAoi,
  writeOnlineRow,
} from './naip-build';
import { NAIP_FIXTURE_JPEG, naipFixtureFetch } from './naip-fixture';
import { MANIFEST_FILE, rawRoot } from './naip-raw';
import { isJpeg, tilePath } from './naip-tiles';

const t = setupTestDb(import.meta.url);
const SECRET = 's'.repeat(40);
let project: string;
let writer: LocalStorageWriter;

beforeAll(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'farm-naip-'));
  writer = new LocalStorageWriter(path.join(project, '.data', 'storage'), SECRET);
});
afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

class BufferSource implements Source {
  constructor(private readonly buf: Buffer) {}
  getKey() {
    return 'memory';
  }
  async getBytes(offset: number, length: number) {
    const slice = this.buf.subarray(offset, offset + length);
    return {
      data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) as ArrayBuffer,
    };
  }
}

async function row(key: string) {
  const r = await t().pool.query('select * from gis.map_layers where key = $1', [key]);
  return r.rows[0] as Record<string, unknown> | undefined;
}

describe('gis:naip (fixture transport)', () => {
  test('the online layer row: xyz, public, the exportImage template; it resolves for the rail', async () => {
    await writeOnlineRow(t().pool);
    const r = await row('naip');
    expect(r).toMatchObject({
      kind: 'xyz',
      cache_policy: 'public',
      version: null,
      meta: { onlineOnly: true },
    });
    expect(String(r?.url_or_key)).toContain(
      '/USGSNAIPImagery/ImageServer/exportImage?bbox={bbox-epsg-3857}',
    );
    const resolved = resolveLayers(
      [naipLayer],
      [
        {
          ...(r as object),
          key: 'naip',
          kind: 'xyz',
          urlOrKey: String(r?.url_or_key),
          url: String(r?.url_or_key),
          cachePolicy: 'public',
        } as ResolvedMapLayer,
      ],
    );
    expect(resolved[0]?.status).toBe('ready');
    await writeOnlineRow(t().pool); // idempotent
  });

  test('AOI from the fields (+1 mile) when there is no data/aoi.geojson; none without fields', async () => {
    await expect(resolveAoi(t().pool, project)).rejects.toThrow(/no fields/);
    await insertField(t().db, {
      name: 'NAIP test 40',
      geom: squareMultiPolygon(-84.06, 41.89, 400),
    });
    const aoi = await resolveAoi(t().pool, project);
    expect(aoi.from).toMatch(/1 mile/);
    expect(aoi.area.type).toBe('MultiPolygon');
    expect(aoi.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a hand-made data/aoi.geojson saved with a BOM (Notepad, PowerShell 5.1) is read', async () => {
    const file = path.join(project, 'aoi-bom.geojson');
    const square = {
      type: 'Polygon',
      coordinates: [
        [
          [-84.07, 41.88],
          [-84.05, 41.88],
          [-84.05, 41.9],
          [-84.07, 41.9],
          [-84.07, 41.88],
        ],
      ],
    };
    await writeFile(file, `\uFEFF${JSON.stringify(square)}`, 'utf8');
    const aoi = await resolveAoi(t().pool, project, file);
    expect(aoi.from).toBe(file);
    expect(aoi.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('download → raw cache + manifest → JPEG PMTiles → storage → registry; resume; offline rebuild', async () => {
    const aoi = await resolveAoi(t().pool, project);
    const f = naipFixtureFetch();
    const opts = {
      projectDir: project,
      aoi,
      minzoom: 12,
      maxzoom: 13,
      maxTiles: 1000,
      fetch: f,
      fixture: true,
    };
    const run = await fetchRun(opts);
    const n = run.index.tiles.length;
    expect(n).toBeGreaterThan(0);
    expect(f.requests).toHaveLength(n);
    expect(f.requests.every((u) => u.includes('/exportImage?') && u.includes('f=image'))).toBe(
      true,
    );
    const first = run.index.tiles[0];
    if (!first) throw new Error('no tiles');
    expect(isJpeg(await readFile(path.join(run.dir, 'tiles', ...tilePath(first).split('/'))))).toBe(
      true,
    );
    const manifest = JSON.parse(await readFile(path.join(rawRoot(project), MANIFEST_FILE), 'utf8'));
    expect(manifest.entries).toEqual([
      expect.objectContaining({
        source: 'naip',
        path: expect.stringMatching(/^naip\/\d{4}-\d{2}-\d{2}\/run\.json$/),
      }),
    ]);

    // Too many tiles for the limit: refused before any request.
    await expect(fetchRun({ ...opts, maxTiles: 1 })).rejects.toThrow(/over the limit/);

    const { archive, sha256 } = await buildArchive(run.dir, run.index, 'NAIP FIXTURE');
    const pm = new PMTiles(new BufferSource(archive));
    const header = await pm.getHeader();
    expect(header.tileType).toBe(TileType.Jpeg);
    expect([header.minZoom, header.maxZoom]).toEqual([12, 13]);
    const got = await pm.getZxy(first.z, first.x, first.y);
    expect(
      Buffer.from(got?.data ?? new ArrayBuffer(0)).equals(Buffer.from(NAIP_FIXTURE_JPEG)),
    ).toBe(true);

    const installed = await installAoiArchive(
      t().pool,
      writer,
      archive,
      sha256,
      run.index,
      'NAIP FIXTURE',
    );
    expect(installed.key).toBe(`naip/aoi.${sha256.slice(0, 8)}.pmtiles`);
    expect(await writer.stat('tiles', installed.key)).toMatchObject({ size: archive.length });
    const r = await row('naip_aoi');
    expect(r).toMatchObject({
      kind: 'pmtiles',
      url_or_key: installed.key,
      version: sha256.slice(0, 8),
      cache_policy: 'public',
      minzoom: 12,
      maxzoom: 13,
      meta: expect.objectContaining({ fixture: true, tiles: n, tileType: 'jpg' }),
    });
    expect(
      resolveLayers(
        [naipAoiLayer],
        [
          {
            key: 'naip_aoi',
            kind: 'pmtiles',
            urlOrKey: installed.key,
            version: sha256.slice(0, 8),
            cachePolicy: 'public',
            minzoom: 12,
            maxzoom: 13,
            attribution: null,
            legend: null,
            sourceVintage: null,
            builtAt: null,
            defaultVisible: false,
            meta: {},
            url: writer.publicUrl('tiles', installed.key),
          },
        ],
      )[0]?.status,
    ).toBe('ready');

    // An interrupted run resumes: the partial index stays until run.json exists.
    await unlink(path.join(run.dir, RUN_INDEX_FILE));
    await unlink(path.join(run.dir, 'tiles', ...tilePath(first).split('/')));
    const f2 = naipFixtureFetch();
    const resumed = await fetchRun({ ...opts, fetch: f2 });
    expect(resumed.dir).toBe(run.dir);
    expect(f2.requests).toHaveLength(1);
    expect(await stat(path.join(run.dir, RUN_PARTIAL_FILE))).toBeTruthy();

    // Offline: the newest complete run rebuilds byte-identical (ingest:all --offline checksums).
    const offline = await newestCompleteRun(project);
    const again = await buildArchive(offline.dir, offline.index, 'NAIP FIXTURE');
    expect(offline.index.tiles).toHaveLength(n);
    expect(again.sha256).toBe(
      (await buildArchive(resumed.dir, resumed.index, 'NAIP FIXTURE')).sha256,
    );
  });

  test('a new archive replaces the old one only after the row points at it', async () => {
    const before = await row('naip_aoi');
    const run = await newestCompleteRun(project);
    const { archive, sha256 } = await buildArchive(run.dir, run.index, 'NAIP FIXTURE, rebuilt');
    expect(sha256).not.toBe(before?.version);
    const r = await installAoiArchive(
      t().pool,
      writer,
      archive,
      sha256,
      run.index,
      'NAIP FIXTURE, rebuilt',
    );
    expect(r.replaced).toBe(before?.url_or_key);
    expect(await writer.stat('tiles', String(before?.url_or_key))).toBeNull();
    expect((await row('naip_aoi'))?.url_or_key).toBe(r.key);
    // Installing the same archive again keeps it (no overwrite, no delete).
    const same = await installAoiArchive(
      t().pool,
      writer,
      archive,
      sha256,
      run.index,
      'NAIP FIXTURE, rebuilt',
    );
    expect(same).toMatchObject({ key: r.key, replaced: null });
    expect(await writer.stat('tiles', r.key)).not.toBeNull();
  });

  test('a service answer that is not a JPEG stops the run with the reason', async () => {
    const aoi = await resolveAoi(t().pool, project);
    const html = async () =>
      new Response('<html>Service Unavailable</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    await expect(
      fetchRun({
        projectDir: path.join(project, 'other'),
        aoi,
        minzoom: 12,
        maxzoom: 12,
        maxTiles: 100,
        fetch: html,
        fixture: false,
      }),
    ).rejects.toThrow(/not a JPEG.*Service Unavailable/);
  });
});
