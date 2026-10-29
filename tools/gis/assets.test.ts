import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  assetPaths,
  assetUrl,
  BASEMAPS_ASSETS_COMMIT,
  FONT_STACKS,
  glyphRanges,
  missingAssets,
  syncAssets,
} from './assets';
import type { FetchLike } from './http';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'farm-assets-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('asset list', () => {
  test('every glyph range of every font stack the style uses, plus v4 sprites', () => {
    const ranges = glyphRanges();
    expect(ranges).toHaveLength(256);
    expect(ranges[0]).toBe('0-255');
    expect(ranges[255]).toBe('65280-65535');
    const paths = assetPaths();
    expect(paths).toContain('fonts/Noto Sans Regular/0-255.pbf');
    expect(paths).toContain('fonts/Noto Sans Medium/256-511.pbf');
    expect(paths).toContain('fonts/Noto Sans Italic/65280-65535.pbf');
    expect(paths).toContain('sprites/v4/light@2x.png');
    expect(paths).toContain('sprites/v4/dark.json');
    expect(paths).toContain('fonts/OFL.txt');
    expect(paths.filter((p) => p.endsWith('.pbf'))).toHaveLength(256 * FONT_STACKS.length);
  });

  test('URLs pin the commit and encode spaces', () => {
    expect(assetUrl('fonts/Noto Sans Regular/0-255.pbf')).toBe(
      `https://raw.githubusercontent.com/protomaps/basemaps-assets/${BASEMAPS_ASSETS_COMMIT}/fonts/Noto%20Sans%20Regular/0-255.pbf`,
    );
  });
});

describe('syncAssets', () => {
  const paths = ['fonts/OFL.txt', 'fonts/Noto Sans Regular/0-255.pbf', 'sprites/v4/light.json'];
  const served = (url: string) =>
    `body of ${decodeURIComponent(url.split('/').slice(-2).join('/'))}`;
  const fetchAll: FetchLike & { calls: number } = Object.assign(
    async (url: string) => {
      fetchAll.calls++;
      return new Response(served(url));
    },
    { calls: 0 },
  );

  test('downloads everything, writes a manifest, then does nothing on re-run', async () => {
    fetchAll.calls = 0;
    const first = await syncAssets(dir, { fetch: fetchAll, paths });
    expect(first).toMatchObject({ downloaded: 3, total: 3 });
    expect(fetchAll.calls).toBe(3);
    expect(await readFile(path.join(dir, 'fonts', 'Noto Sans Regular', '0-255.pbf'), 'utf8')).toBe(
      'body of Noto Sans Regular/0-255.pbf',
    );
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.commit).toBe(BASEMAPS_ASSETS_COMMIT);
    expect(Object.keys(manifest.files).sort()).toEqual([...paths].sort());

    const again = await syncAssets(dir, { fetch: fetchAll, paths });
    expect(again.downloaded).toBe(0);
    expect(fetchAll.calls).toBe(3);
  });

  test('re-fetches only a damaged file', async () => {
    await syncAssets(dir, { fetch: fetchAll, paths });
    await writeFile(path.join(dir, 'sprites', 'v4', 'light.json'), 'truncated');
    expect(await missingAssets(dir, BASEMAPS_ASSETS_COMMIT, paths)).toEqual([
      'sprites/v4/light.json',
    ]);
    fetchAll.calls = 0;
    expect((await syncAssets(dir, { fetch: fetchAll, paths })).downloaded).toBe(1);
    expect(fetchAll.calls).toBe(1);
  });

  test('a different pinned commit downloads everything again', async () => {
    await syncAssets(dir, { fetch: fetchAll, paths });
    expect(await missingAssets(dir, 'f'.repeat(40), paths)).toEqual(paths);
  });

  test('a failing download fails the run and writes no manifest', async () => {
    const failing: FetchLike = async (url) =>
      url.includes('light.json') ? new Response('nope', { status: 404 }) : new Response('ok');
    await expect(syncAssets(dir, { fetch: failing, paths })).rejects.toThrow(
      /1 asset download\(s\) failed/,
    );
    await expect(readFile(path.join(dir, 'manifest.json'))).rejects.toThrow();
  });
});
