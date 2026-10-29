/**
 * /api/storage over real HTTP (request-only): byte ranges for PMTiles, cache headers, the
 * path-traversal guard and the M0 bucket rule. Uses the installed basemap when there is one.
 */
import { expect, test } from '@playwright/test';

test('rejects traversal and unknown buckets', async ({ request }) => {
  for (const path of [
    '/api/storage/tiles/..%2F..%2Fpackage.json',
    '/api/storage/tiles/assets/..%2F..%2F..%2F.env',
    '/api/storage/tiles/C:%2Fwindows%2Fwin.ini',
    '/api/storage/tiles/a%5Cb.json',
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(400);
  }
  expect((await request.get('/api/storage/uploads/anything.json')).status()).toBe(404);
  expect((await request.get('/api/storage/tiles/missing-file.pmtiles')).status()).toBe(404);
});

test('serves the basemap archive with ranges and immutable caching', async ({ request }) => {
  const manifestRes = await request.get('/api/storage/tiles/basemap.json');
  test.skip(manifestRes.status() === 404, 'no offline basemap installed (run `pnpm gis:basemap`)');
  expect(manifestRes.headers()['cache-control']).toBe('no-cache');
  const manifest = (await manifestRes.json()) as { key: string; sha8: string; bytes: number };

  const head = await request.get(`/api/storage/tiles/${manifest.key}`, {
    headers: { range: 'bytes=0-126' },
  });
  expect(head.status()).toBe(206);
  expect(head.headers()['content-range']).toBe(`bytes 0-126/${manifest.bytes}`);
  expect(head.headers()['content-type']).toBe('application/vnd.pmtiles');
  expect(head.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(head.headers().etag).toBe(`"${manifest.sha8}"`);
  const bytes = await head.body();
  expect(bytes.length).toBe(127);
  expect(bytes.subarray(0, 7).toString('latin1')).toBe('PMTiles');

  const tail = await request.get(`/api/storage/tiles/${manifest.key}`, {
    headers: { range: 'bytes=-10' },
  });
  expect(tail.status()).toBe(206);
  expect((await tail.body()).length).toBe(10);

  const beyond = await request.get(`/api/storage/tiles/${manifest.key}`, {
    headers: { range: `bytes=${manifest.bytes}-` },
  });
  expect(beyond.status()).toBe(416);
  expect(beyond.headers()['content-range']).toBe(`bytes */${manifest.bytes}`);

  const cached = await request.get(`/api/storage/tiles/${manifest.key}`, {
    headers: { 'if-none-match': `"${manifest.sha8}"` },
  });
  expect(cached.status()).toBe(304);
});
