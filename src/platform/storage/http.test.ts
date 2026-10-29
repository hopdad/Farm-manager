/** serveStorageObject + LocalStorage against a temp directory (no Next, no network). */
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cacheControlFor,
  etagFor,
  IMMUTABLE_CACHE,
  ifNoneMatchHits,
  ifRangeAllows,
  PRIVATE_CACHE,
  REVALIDATE_CACHE,
  serveStorageObject,
} from './http';
import { isInside, LocalStorage } from './local';

let root: string;
let outside: string;
let storage: LocalStorage;
const PMTILES = 'basemap.0123abcd.pmtiles';
const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'farm-storage-'));
  outside = await mkdtemp(path.join(tmpdir(), 'farm-outside-'));
  const tiles = path.join(root, 'tiles');
  await mkdir(path.join(tiles, 'assets', 'fonts', 'Noto Sans Regular'), { recursive: true });
  await writeFile(path.join(tiles, PMTILES), body);
  await writeFile(path.join(tiles, 'basemap.json'), '{"key":"x"}');
  await writeFile(path.join(tiles, 'assets', 'fonts', 'Noto Sans Regular', '0-255.pbf'), 'glyphs');
  await writeFile(path.join(tiles, 'empty.json'), '');
  await utimes(path.join(tiles, 'basemap.json'), new Date('2026-10-01'), new Date('2026-10-01'));
  await mkdir(path.join(root, 'uploads'), { recursive: true });
  await writeFile(path.join(root, 'uploads', 'private.json'), '{}');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  try {
    await symlink(path.join(outside, 'secret.txt'), path.join(tiles, 'escape.txt'));
  } catch {
    // Symlinks need privileges on some Windows setups; the escape test then checks nothing.
  }
  storage = new LocalStorage(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const get = (key: string, headers: Record<string, string> = {}, method = 'GET') =>
  serveStorageObject(
    new Request(`http://localhost/api/storage/tiles/${key}`, { method, headers }),
    storage,
    'tiles',
    key.split('/').map(decodeURIComponent),
  );

describe('serveStorageObject', () => {
  test('whole object: 200, headers, streamed body', async () => {
    const res = await get(PMTILES);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.pmtiles');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('etag')).toBe('"0123abcd"');
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE_CACHE);
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
  });

  test('Range a-b → 206 with exactly those bytes', async () => {
    const res = await get(PMTILES, { range: 'bytes=10-19' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(res.headers.get('content-length')).toBe('10');
    expect(Buffer.from(await res.arrayBuffer()).equals(body.subarray(10, 20))).toBe(true);
  });

  test('Range a- and -n', async () => {
    const tail = await get(PMTILES, { range: 'bytes=990-' });
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer()).equals(body.subarray(990))).toBe(true);
    const suffix = await get(PMTILES, { range: 'bytes=-5' });
    expect(suffix.headers.get('content-range')).toBe('bytes 995-999/1000');
    expect(Buffer.from(await suffix.arrayBuffer()).equals(body.subarray(995))).toBe(true);
  });

  test('unsatisfiable range → 416 with bytes */size', async () => {
    const res = await get(PMTILES, { range: 'bytes=5000-' });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
  });

  test('If-None-Match → 304 without a body', async () => {
    const res = await get(PMTILES, { 'if-none-match': '"0123abcd"' });
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get('etag')).toBe('"0123abcd"');
  });

  test('If-Range with another ETag serves the whole object', async () => {
    const res = await get(PMTILES, { range: 'bytes=0-9', 'if-range': '"ffffffff"' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('1000');
    await res.arrayBuffer();
  });

  test('HEAD has headers and no body', async () => {
    const res = await get(PMTILES, {}, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.body).toBeNull();
    const ranged = await get(PMTILES, { range: 'bytes=0-126' }, 'HEAD');
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-length')).toBe('127');
  });

  test('basemap.json: no-cache and a size+mtime ETag', async () => {
    const res = await get('basemap.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(REVALIDATE_CACHE);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(await res.text()).toBe('{"key":"x"}');
  });

  test('fonts under assets/: immutable, protobuf, spaces in the path', async () => {
    const res = await get('assets/fonts/Noto%20Sans%20Regular/0-255.pbf');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-protobuf');
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE_CACHE);
    expect(await res.text()).toBe('glyphs');
  });

  test('empty object → 200 with an empty body', async () => {
    const res = await get('empty.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('0');
    expect(await res.text()).toBe('');
  });

  test('missing object, directory → 404', async () => {
    expect((await get('nope.pmtiles')).status).toBe(404);
    expect((await get('assets')).status).toBe(404);
    expect((await get('assets/fonts/Noto%20Sans%20Regular/9-9.pbf')).status).toBe(404);
  });

  test('bad keys → 400', async () => {
    for (const key of ['..%2Fsecret', 'assets/..%2F..%2Fx', 'C:%2Fx', 'a%5Cb', 'a%00b']) {
      expect((await get(key)).status, key).toBe(400);
    }
  });

  test('other buckets → 404 in M0, including uploads', async () => {
    const req = new Request('http://localhost/api/storage/uploads/private.json');
    expect((await serveStorageObject(req, storage, 'uploads', ['private.json'])).status).toBe(404);
    expect((await serveStorageObject(req, storage, 'nope', ['x'])).status).toBe(404);
  });

  test("access 'signed' (a GET the route verified) serves a private bucket, never cached", async () => {
    const req = (headers: Record<string, string> = {}) =>
      new Request('http://localhost/api/storage/uploads/private.json?sig=checked-by-the-route', {
        headers,
      });
    const res = await serveStorageObject(req(), storage, 'uploads', ['private.json'], {
      access: 'signed',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(PRIVATE_CACHE);
    expect(await res.text()).toBe('{}');
    const part = await serveStorageObject(
      req({ range: 'bytes=0-0' }),
      storage,
      'uploads',
      ['private.json'],
      { access: 'signed' },
    );
    expect(part.status).toBe(206);
    expect(part.headers.get('cache-control')).toBe(PRIVATE_CACHE);
    // Still refused: unknown buckets, bad keys, missing objects.
    const opts = { access: 'signed' } as const;
    expect((await serveStorageObject(req(), storage, 'nope', ['x'], opts)).status).toBe(404);
    expect((await serveStorageObject(req(), storage, 'uploads', ['..', 'x'], opts)).status).toBe(
      400,
    );
    expect((await serveStorageObject(req(), storage, 'uploads', ['gone.json'], opts)).status).toBe(
      404,
    );
    // The default stays M0's: public buckets only.
    expect((await serveStorageObject(req(), storage, 'uploads', ['private.json'])).status).toBe(
      404,
    );
  });

  test('a symlink pointing outside the bucket is not served', async () => {
    expect((await get('escape.txt')).status).toBe(404);
  });
});

describe('LocalStorage', () => {
  test('pathOf stays inside the bucket and rejects bad keys', () => {
    expect(storage.pathOf('tiles', 'a/b.json')).toBe(path.join(root, 'tiles', 'a', 'b.json'));
    expect(() => storage.pathOf('tiles', '../uploads/private.json')).toThrow();
  });

  test('readText refuses big objects and returns null when missing', async () => {
    expect(await storage.readText('tiles', 'basemap.json')).toBe('{"key":"x"}');
    expect(await storage.readText('tiles', 'missing.json')).toBeNull();
    await expect(storage.readText('tiles', PMTILES, 10)).rejects.toThrow('limit');
  });

  test('publicUrl: the local route, each segment encoded; bad keys refused', () => {
    expect(storage.publicUrl('tiles', 'basemap.0123abcd.pmtiles')).toBe(
      '/api/storage/tiles/basemap.0123abcd.pmtiles',
    );
    expect(storage.publicUrl('tiles', 'assets/fonts/Noto Sans Medium/0-255.pbf')).toBe(
      '/api/storage/tiles/assets/fonts/Noto%20Sans%20Medium/0-255.pbf',
    );
    expect(storage.publicUrl('tiles', 'assets/sprites/v4')).toBe(
      '/api/storage/tiles/assets/sprites/v4',
    );
    expect(() => storage.publicUrl('tiles', '../uploads/x')).toThrow();
  });

  test('isInside', () => {
    expect(isInside('/a/b', '/a/b/c', 'linux')).toBe(true);
    expect(isInside('/a/b', '/a/b', 'linux')).toBe(false);
    expect(isInside('/a/b', '/a/bc', 'linux')).toBe(false);
    expect(isInside('/a/b/', '/a/b/c', 'linux')).toBe(true);
    // Windows rules on any host: backslash separator, case-insensitive.
    expect(isInside('C:\\a\\b', 'c:\\A\\B\\c', 'win32')).toBe(true);
    expect(isInside('C:\\a\\b', 'C:\\a\\bc', 'win32')).toBe(false);
    expect(isInside('C:\\a\\b', 'C:\\a\\b', 'win32')).toBe(false);
  });
});

describe('cache helpers', () => {
  test('cacheControlFor', () => {
    expect(cacheControlFor('basemap.0123abcd.pmtiles')).toBe(IMMUTABLE_CACHE);
    expect(cacheControlFor('assets/sprites/v4/light.png')).toBe(IMMUTABLE_CACHE);
    expect(cacheControlFor('basemap.json')).toBe(REVALIDATE_CACHE);
    expect(cacheControlFor('other.pmtiles')).toBe(REVALIDATE_CACHE);
  });

  test('etagFor', () => {
    const mtime = new Date(0x1234);
    expect(etagFor({ key: 'a.json', size: 255, mtime })).toBe('"ff-1234"');
    expect(etagFor({ key: 'a.0000beef.json', size: 1, mtime })).toBe('"0000beef"');
  });

  test('ifNoneMatchHits / ifRangeAllows', () => {
    expect(ifNoneMatchHits('"a", W/"b"', '"b"')).toBe(true);
    expect(ifNoneMatchHits('*', '"b"')).toBe(true);
    expect(ifNoneMatchHits('"c"', '"b"')).toBe(false);
    expect(ifNoneMatchHits(null, '"b"')).toBe(false);
    expect(ifRangeAllows(null, '"a"', 'x')).toBe(true);
    expect(ifRangeAllows('"a"', '"a"', 'x')).toBe(true);
    expect(ifRangeAllows('W/"a"', '"a"', 'x')).toBe(false);
    expect(
      ifRangeAllows('Thu, 01 Oct 2026 00:00:00 GMT', '"a"', 'Thu, 01 Oct 2026 00:00:00 GMT'),
    ).toBe(true);
  });
});
