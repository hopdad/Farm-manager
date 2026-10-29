import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { basemapManifestSchema, isSyntheticBasemap, readBasemapStatus } from './basemap';
import { LocalStorage } from './local';

const manifest = {
  key: 'basemap.0123abcd.pmtiles',
  sha8: '0123abcd',
  bytes: 4,
  builtAt: '2026-10-29T03:00:00.000Z',
  build: '20261028.pmtiles',
  bbox: [-84.45, 41.65, -83.1, 42.15],
  maxzoom: 15,
  assetsCommit: '028c18f713baecad011301ff7a69acc39bcc2ae7',
};

let root: string;
let storage: LocalStorage;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'farm-basemap-'));
  await mkdir(path.join(root, 'tiles'), { recursive: true });
  storage = new LocalStorage(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeTiles = (key: string, data: string) => writeFile(path.join(root, 'tiles', key), data);

describe('basemap.json', () => {
  test('schema accepts the documented shape and rejects mismatches', () => {
    expect(basemapManifestSchema.safeParse(manifest).success).toBe(true);
    expect(basemapManifestSchema.safeParse({ ...manifest, sha8: 'ffffffff' }).success).toBe(false);
    expect(basemapManifestSchema.safeParse({ ...manifest, key: '../x.pmtiles' }).success).toBe(
      false,
    );
    expect(basemapManifestSchema.safeParse({ ...manifest, assetsCommit: 'main' }).success).toBe(
      false,
    );
  });

  test('missing → reason missing', async () => {
    expect(await readBasemapStatus(storage)).toMatchObject({ ok: false, reason: 'missing' });
  });

  test('invalid JSON or shape → reason invalid', async () => {
    await writeTiles('basemap.json', '{nope');
    expect(await readBasemapStatus(storage)).toMatchObject({ ok: false, reason: 'invalid' });
    await writeTiles('basemap.json', JSON.stringify({ key: 'x' }));
    expect(await readBasemapStatus(storage)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  test('named file missing or with another size → reason file-missing', async () => {
    await writeTiles('basemap.json', JSON.stringify(manifest));
    expect(await readBasemapStatus(storage)).toMatchObject({ ok: false, reason: 'file-missing' });
    await writeTiles(manifest.key, 'abcdef');
    expect(await readBasemapStatus(storage)).toMatchObject({ ok: false, reason: 'file-missing' });
  });

  test('complete → ok with the manifest', async () => {
    await writeTiles('basemap.json', JSON.stringify(manifest));
    await writeTiles(manifest.key, 'abcd');
    const status = await readBasemapStatus(storage);
    expect(status).toEqual({ ok: true, manifest });
  });

  test('isSyntheticBasemap', () => {
    expect(isSyntheticBasemap({ build: 'local:synthetic-se-michigan' })).toBe(true);
    expect(isSyntheticBasemap({ build: '20261028.pmtiles' })).toBe(false);
  });
});
