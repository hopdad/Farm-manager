import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { headerProblems, parseBasemapArgs, resolveSourceArg } from './basemap';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'farm-basemap-cli-'));
  await writeFile(path.join(dir, 'synthetic-se-michigan.pmtiles'), 'x');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('gis:basemap CLI', () => {
  test('arguments', () => {
    expect(parseBasemapArgs([])).toEqual({
      source: undefined,
      synthetic: false,
      refresh: false,
      assetsOnly: false,
      help: false,
    });
    expect(parseBasemapArgs(['--refresh', '--source=20261028.pmtiles'])).toMatchObject({
      refresh: true,
      source: '20261028.pmtiles',
    });
    expect(parseBasemapArgs(['--assets-only']).assetsOnly).toBe(true);
    expect(() => parseBasemapArgs(['--nope'])).toThrow();
    expect(parseBasemapArgs(['--synthetic']).synthetic).toBe(true);
    expect(() => parseBasemapArgs(['--synthetic', '--source=x.pmtiles'])).toThrow('exclude');
  });

  test('--source: build key, URL or file', () => {
    expect(resolveSourceArg('20261028.pmtiles')).toEqual({
      input: { kind: 'url', url: 'https://build.protomaps.com/20261028.pmtiles' },
      build: '20261028.pmtiles',
    });
    expect(resolveSourceArg('https://build.protomaps.com/20261028.pmtiles').build).toBe(
      '20261028.pmtiles',
    );
    expect(resolveSourceArg('https://example.org/planet.pmtiles').build).toBe(
      'url:https://example.org/planet.pmtiles',
    );
    const local = resolveSourceArg('synthetic-se-michigan.pmtiles', dir);
    expect(local).toEqual({
      input: { kind: 'file', path: path.join(dir, 'synthetic-se-michigan.pmtiles') },
      build: 'local:synthetic-se-michigan',
    });
    expect(() => resolveSourceArg('missing.pmtiles', dir)).toThrow('is not a file');
  });

  test('headerProblems', () => {
    const good = {
      specVersion: 3,
      tileType: 1,
      maxZoom: 15,
      minLon: -84.5,
      minLat: 41.6,
      maxLon: -83,
      maxLat: 42.2,
    };
    expect(headerProblems(good)).toEqual([]);
    expect(headerProblems({ ...good, tileType: 2 })).toEqual(['tile type 2, expected 1 (MVT)']);
    expect(headerProblems({ ...good, maxZoom: 16 })[0]).toMatch('exceeds 15');
    expect(headerProblems({ ...good, minLon: 10, maxLon: 11 })[0]).toMatch('miss the AOI');
  });
});
