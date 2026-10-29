import { describe, expect, test } from 'vitest';
import {
  buildCandidates,
  buildUrl,
  isPmtilesHeader,
  type ProtomapsBuild,
  parseBuildsListing,
  resolveBuild,
} from './builds';
import type { FetchLike } from './http';

const listing: ProtomapsBuild[] = [
  { key: '20261020.pmtiles', version: '4.15.1', size: 1, uploaded: 'x' },
  { key: '20261021.pmtiles', version: '4.15.1' },
  { key: '20261022.pmtiles', version: '4.15.2' },
  { key: '20261028.pmtiles', version: '4.15.2' },
  { key: '20240101.pmtiles', version: '3.7.0' },
  { key: '20250301.pmtiles', version: '4.2.0' },
];

describe('builds listing', () => {
  test('parseBuildsListing keeps planet builds and skips everything else', () => {
    const parsed = parseBuildsListing([
      ...listing,
      { key: '20261028.layerstats.parquet', version: '4.15.2' },
      { key: 'nope' },
      42,
    ]);
    expect(parsed.map((b) => b.key)).toEqual(listing.map((b) => b.key));
    expect(parseBuildsListing({ builds: listing })).toHaveLength(listing.length);
    expect(() => parseBuildsListing({})).toThrow('not an array');
    expect(() => parseBuildsListing([{ key: 'x' }])).toThrow('no usable entries');
  });

  test('candidates: newest compatible build, then the first build of each version, newest version first', () => {
    expect(buildCandidates(listing).map((b) => b.key)).toEqual([
      '20261028.pmtiles', // newest daily
      '20261022.pmtiles', // first 4.15.2
      '20261020.pmtiles', // first 4.15.1
      '20250301.pmtiles', // first 4.2.0
    ]);
    expect(buildCandidates(listing, [3]).map((b) => b.key)).toEqual(['20240101.pmtiles']);
  });

  test('buildUrl and header check', () => {
    expect(buildUrl('20261028.pmtiles')).toBe('https://build.protomaps.com/20261028.pmtiles');
    const header = new Uint8Array(127);
    header.set(Buffer.from('PMTiles'), 0);
    header[7] = 3;
    expect(isPmtilesHeader(header)).toBe(true);
    header[7] = 2;
    expect(isPmtilesHeader(header)).toBe(false);
    expect(isPmtilesHeader(new Uint8Array(3))).toBe(false);
  });
});

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response,
): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    return handler(url, init);
  }) as FetchLike & { urls: string[] };
  f.urls = urls;
  return f;
}

const pmHeader = () => {
  const b = new Uint8Array(127);
  b.set(Buffer.from('PMTiles'), 0);
  b[7] = 3;
  return b;
};

describe('resolveBuild', () => {
  test('falls back from an expired daily build to the patch-version build', async () => {
    const f = fakeFetch((url, init) => {
      if (url.endsWith('builds.json')) return Response.json(listing);
      expect(new Headers(init?.headers).get('range')).toBe('bytes=0-126');
      if (url.endsWith('20261028.pmtiles')) return new Response('gone', { status: 404 });
      return new Response(pmHeader(), { status: 206 });
    });
    const r = await resolveBuild({ fetch: f });
    expect(r.build.key).toBe('20261022.pmtiles');
    expect(r.url).toBe('https://build.protomaps.com/20261022.pmtiles');
  });

  test('rejects a server that ignores Range or serves something else', async () => {
    const f = fakeFetch((url) => {
      if (url.endsWith('builds.json')) return Response.json(listing.slice(0, 1));
      return new Response(new Uint8Array(127), { status: 206 });
    });
    await expect(resolveBuild({ fetch: f })).rejects.toThrow('not a PMTiles v3 archive');
    const g = fakeFetch((url) =>
      url.endsWith('builds.json')
        ? Response.json(listing.slice(0, 1))
        : new Response('x', { status: 200 }),
    );
    await expect(resolveBuild({ fetch: g })).rejects.toThrow('expected 206');
  });

  test('a listing failure is reported with its URL', async () => {
    const f = fakeFetch(() => new Response('denied', { status: 403 }));
    await expect(resolveBuild({ fetch: f })).rejects.toThrow(
      /builds listing https:\/\/build-metadata\.protomaps\.dev\/builds\.json: HTTP 403/,
    );
  });
});
