import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  listRuns,
  type ManifestEntry,
  manifestPath,
  newRunDir,
  openRun,
  type RunIndex,
  rawRoot,
  sha256Hex,
  upsertManifestEntries,
  writeRunFile,
  writeRunIndex,
} from './soils-raw';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'farm-soils-raw-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const NOW = new Date('2026-10-29T15:00:00Z');

async function makeRun(dir: string, files: Record<string, string>, extra: Partial<RunIndex> = {}) {
  const entries = [];
  for (const [file, text] of Object.entries(files)) {
    const { sha256, bytes } = await writeRunFile(dir, file, text);
    entries.push({
      file,
      kind: 'stats' as const,
      area: 'MI091',
      query: 'SELECT 1',
      rows: 0,
      bytes,
      sha256,
      fetchedAt: NOW.toISOString(),
    });
  }
  const index: RunIndex = {
    format: 1,
    source: 'soils',
    service: 'https://example.invalid/post.rest',
    requestFormat: 'JSON+COLUMNNAME',
    nccpiRule: 'NCCPI',
    areas: ['MI091'],
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    complete: true,
    files: entries,
    ...extra,
  };
  await writeRunIndex(dir, index);
  return index;
}

describe('run directories', () => {
  test('rawRoot is data/raw under the project', () => {
    expect(rawRoot(path.join('C:', 'dev', 'farm'))).toBe(
      path.join('C:', 'dev', 'farm', 'data', 'raw'),
    );
  });

  test('one directory per UTC day, numbered after the first', async () => {
    const a = await newRunDir(root, NOW);
    const b = await newRunDir(root, NOW);
    expect(path.basename(a)).toBe('2026-10-29');
    expect(path.basename(b)).toBe('2026-10-29.2');
    expect(path.dirname(a)).toBe(path.join(root, 'soils'));
  });

  test('a run reads back only when every file matches its checksum', async () => {
    const dir = await newRunDir(root, NOW);
    await makeRun(dir, { 'MI091.stats.json': '{"Table":[["mukey"],["1"]]}' });
    const run = await openRun(dir);
    const f = run.index.files[0];
    if (!f) throw new Error('no file');
    expect(await run.read(f)).toBe('{"Table":[["mukey"],["1"]]}');
    await writeFile(path.join(dir, f.file), '{"Table":[["mukey"],["2"]]}');
    await expect(run.read(f)).rejects.toThrow(/does not match run\.json/);
  });

  test('a directory without run.json is not a run', async () => {
    const dir = await newRunDir(root, NOW);
    await writeRunFile(dir, 'MI091.stats.json', '{}');
    await expect(openRun(dir)).rejects.toThrow(/not a complete soils download/);
    expect(await listRuns(root)).toEqual([]);
  });

  test('listRuns: complete runs, newest first', async () => {
    const older = path.join(root, 'soils', '2026-10-01');
    await mkdir(older, { recursive: true });
    await makeRun(older, { 'a.json': '{}' }, { finishedAt: '2026-10-01T00:00:00.000Z' });
    const newer = path.join(root, 'soils', '2026-10-20');
    await mkdir(newer, { recursive: true });
    await makeRun(newer, { 'a.json': '{}' }, { finishedAt: '2026-10-20T00:00:00.000Z' });
    await mkdir(path.join(root, 'soils', 'junk'));
    expect((await listRuns(root)).map((r) => r.name)).toEqual(['2026-10-20', '2026-10-01']);
  });

  test('writeRunFile refuses names that could leave the directory', async () => {
    const dir = await newRunDir(root, NOW);
    await expect(writeRunFile(dir, '../x.json', '{}')).rejects.toThrow(/bad raw file name/);
  });
});

describe('manifest', () => {
  const entry = (p: string, sha = 'a'.repeat(64)): ManifestEntry => ({
    source: 'soils',
    path: p,
    url: 'https://example.invalid/post.rest',
    method: 'POST',
    requestSha256: sha256Hex('{}'),
    fetchedAt: NOW.toISOString(),
    sha256: sha,
    bytes: 2,
    licence: 'Public domain',
  });

  test('entries are upserted by path and kept sorted; other sources survive', async () => {
    await upsertManifestEntries(root, [
      entry('soils/2026-10-29/b.json'),
      { ...entry('cdl/x.tif'), source: 'cdl' },
    ]);
    await upsertManifestEntries(root, [
      entry('soils/2026-10-29/b.json', 'b'.repeat(64)),
      entry('soils/2026-10-29/a.json'),
    ]);
    const m = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    expect(m.version).toBe(1);
    expect(m.entries.map((e: ManifestEntry) => [e.path, e.sha256.slice(0, 1)])).toEqual([
      ['cdl/x.tif', 'a'],
      ['soils/2026-10-29/a.json', 'a'],
      ['soils/2026-10-29/b.json', 'b'],
    ]);
  });

  test('paths use forward slashes on every OS', () => {
    expect(manifestPath(root, path.join(root, 'soils', '2026-10-29'), 'x.json')).toBe(
      'soils/2026-10-29/x.json',
    );
  });
});
