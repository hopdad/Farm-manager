import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { installContentAddressed, removeOtherVersions, sha256File, writeFileAtomic } from './files';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'farm-files-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('file helpers', () => {
  test('sha256File', async () => {
    const f = path.join(dir, 'a');
    await writeFile(f, 'hello');
    expect(await sha256File(f)).toBe(createHash('sha256').update('hello').digest('hex'));
  });

  test('writeFileAtomic leaves only the final file', async () => {
    const f = path.join(dir, 'nested', 'basemap.json');
    await writeFileAtomic(f, '{"a":1}');
    await writeFileAtomic(f, '{"a":2}');
    expect(await readFile(f, 'utf8')).toBe('{"a":2}');
    expect(await readdir(path.dirname(f))).toEqual(['basemap.json']);
  });

  test('installContentAddressed names by sha8, never overwrites, and reuses an identical file', async () => {
    const tiles = path.join(dir, 'tiles');
    const tmp1 = path.join(dir, 't1');
    await writeFile(tmp1, 'archive-1');
    const a = await installContentAddressed(tmp1, tiles, 'basemap', 'pmtiles');
    const sha = createHash('sha256').update('archive-1').digest('hex');
    expect(a).toEqual({
      key: `basemap.${sha.slice(0, 8)}.pmtiles`,
      sha256: sha,
      bytes: 9,
      created: true,
    });
    const tmp2 = path.join(dir, 't2');
    await writeFile(tmp2, 'archive-1');
    const b = await installContentAddressed(tmp2, tiles, 'basemap', 'pmtiles');
    expect(b.created).toBe(false);
    expect(await readdir(dir)).not.toContain('t2');
    expect(await readdir(tiles)).toEqual([a.key]);
  });

  test('removeOtherVersions keeps the named key and unrelated files', async () => {
    for (const n of [
      'basemap.00000000.pmtiles',
      'basemap.11111111.pmtiles',
      'basemap.json',
      'hillshade.22222222.pmtiles',
    ]) {
      await writeFile(path.join(dir, n), 'x');
    }
    expect(
      await removeOtherVersions(dir, 'basemap', 'pmtiles', 'basemap.11111111.pmtiles'),
    ).toEqual(['basemap.00000000.pmtiles']);
    expect((await readdir(dir)).sort()).toEqual([
      'basemap.11111111.pmtiles',
      'basemap.json',
      'hillshade.22222222.pmtiles',
    ]);
  });
});
