/**
 * The local storage writer: the shared adapter contract suite (./writer-contract.ts) with a
 * harness that plays the browser against the /api/storage route's logic (./upload.ts), plus the
 * local-only details (temp files, streamed limits, races, links, the M0 read paths unchanged).
 */
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { canonicalString, normalizeContentType, signStorageClaims } from './signing';
import { MAX_UPLOAD_BYTES, StorageConflictError } from './types';
import { handleStoragePut, handleStorageRead } from './upload';
import { LocalStorageWriter, TMP_DIR } from './writer';
import { describeStorageWriterContract, type WriterHarness } from './writer-contract';

const SECRET = 'x'.repeat(40);

async function localHarness(): Promise<
  WriterHarness & { root: string; writer: LocalStorageWriter }
> {
  const root = await mkdtemp(path.join(tmpdir(), 'farm-writer-'));
  let now = new Date('2026-11-02T12:00:00Z').getTime();
  const clock = () => new Date(now);
  const writer = new LocalStorageWriter(root, SECRET, { now: clock });
  return {
    root,
    writer,
    advance: (s) => {
      now += s * 1000;
    },
    fetch: async (url, init = {}) => {
      const req = new Request(new URL(url, 'http://farm.test'), init);
      const parts = new URL(req.url).pathname.split('/').slice(3).map(decodeURIComponent);
      const [bucket = '', ...key] = parts;
      const opts = { secret: SECRET, now: clock() };
      return req.method === 'PUT'
        ? handleStoragePut(req, writer, bucket, key, opts)
        : handleStorageRead(req, writer, bucket, key, opts);
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describeStorageWriterContract('local', localHarness);

describe('local writer details', () => {
  let h: Awaited<ReturnType<typeof localHarness>>;
  beforeEach(async () => {
    h = await localHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  test('writes leave no temp files in the buckets or the temp directory', async () => {
    await h.writer.put('tiles', 'a/b/c.json', Buffer.from('{}'));
    await expect(h.writer.put('tiles', 'a/b/c.json', Buffer.from('[]'))).rejects.toBeInstanceOf(
      StorageConflictError,
    );
    expect(await readdir(path.join(h.root, 'tiles', 'a', 'b'))).toEqual(['c.json']);
    expect(await readdir(path.join(h.root, TMP_DIR))).toEqual([]);
  });

  test('a declared Content-Length over the grant is refused before reading', async () => {
    const grant = await h.writer.createUploadGrant({
      bucket: 'uploads',
      key: 'x.csv',
      contentType: 'text/csv; charset=utf-8',
      bytes: 10,
    });
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(5));
        if (pulled > 3) c.close();
      },
    });
    const req = new Request(new URL(grant.url, 'http://farm.test'), {
      method: 'PUT',
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-length': '20' },
      body,
      duplex: 'half',
    } as RequestInit);
    const res = await handleStoragePut(req, h.writer, 'uploads', ['x.csv'], { secret: SECRET });
    expect(res.status).toBe(413);
    expect(await h.writer.stat('uploads', 'x.csv')).toBeNull();
  });

  test('a chunked body is cut off at the limit (413, nothing stored, rest unread)', async () => {
    const grant = await h.writer.createUploadGrant({
      bucket: 'uploads',
      key: 'big.jpg',
      contentType: 'image/jpeg',
      bytes: MAX_UPLOAD_BYTES,
    });
    let sent = 0;
    const chunk = new Uint8Array(256 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += chunk.length;
        c.enqueue(chunk);
        if (sent > 64 * 1024 * 1024) c.close(); // never reached: the reader stops at 4 MB
      },
    });
    const req = new Request(new URL(grant.url, 'http://farm.test'), {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body,
      duplex: 'half',
    } as RequestInit);
    const res = await handleStoragePut(req, h.writer, 'uploads', ['big.jpg'], { secret: SECRET });
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(16 * 1024 * 1024);
    expect(await h.writer.stat('uploads', 'big.jpg')).toBeNull();
    expect(await readdir(path.join(h.root, TMP_DIR))).toEqual([]);
  });

  test('concurrent writers of one key: one creates, identical others no-op, different conflict', async () => {
    const same = Buffer.alloc(64 * 1024, 7);
    const results = await Promise.allSettled([
      h.writer.putObject('tiles', 'race.json', Readable.from([same])),
      h.writer.putObject('tiles', 'race.json', Readable.from([same])),
      h.writer.putObject('tiles', 'race.json', Buffer.alloc(64 * 1024, 8)),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.created);
    const failed = results.filter((r) => r.status === 'rejected');
    // Either the different body won (both identical ones conflict) or an identical one did.
    if (ok.length === 2) {
      expect(ok.filter(Boolean)).toHaveLength(1);
      expect(failed).toHaveLength(1);
    } else {
      expect(ok).toEqual([true]);
      expect(failed).toHaveLength(2);
    }
    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toBeInstanceOf(StorageConflictError);
    }
  });

  test('a directory link out of the bucket is refused', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'farm-out-'));
    try {
      await mkdir(path.join(h.root, 'tiles'), { recursive: true });
      try {
        await symlink(outside, path.join(h.root, 'tiles', 'link'), 'junction');
      } catch {
        return; // no privilege for links here (some Windows setups)
      }
      await expect(h.writer.put('tiles', 'link/x.json', Buffer.from('{}'))).rejects.toThrow(
        /escapes/,
      );
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('tiles reads ignore signature parameters (M0 behaviour unchanged)', async () => {
    await mkdir(path.join(h.root, 'tiles'), { recursive: true });
    await writeFile(path.join(h.root, 'tiles', 'basemap.json'), '{"key":"x"}');
    const res = await h.fetch('/api/storage/tiles/basemap.json?sig=junk&exp=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect((await h.fetch('/api/storage/uploads/missing.json')).status).toBe(404);
    // A bad key with a signature answers like an unsigned request: uploads is not public (404).
    expect((await h.fetch('/api/storage/uploads/..%2Fx.json?sig=a&exp=1')).status).toBe(404);
    expect((await h.fetch('/api/storage/tiles/..%2Fx.json?sig=a&exp=1')).status).toBe(400);
  });

  test('constructor refuses a short secret', () => {
    expect(() => new LocalStorageWriter(h.root, 'short')).toThrow(/32/);
  });
});

describe('signing', () => {
  test('the canonical string covers method, bucket, key, expiry, limit and type', () => {
    expect(
      canonicalString({
        method: 'PUT',
        bucket: 'uploads',
        key: 'a/b.jpg',
        expires: 100,
        maxBytes: 5,
        contentType: 'image/jpeg',
      }),
    ).toBe('v1\nPUT\nuploads\na/b.jpg\n100\n5\nimage/jpeg');
    expect(canonicalString({ method: 'GET', bucket: 'uploads', key: 'k', expires: 7 })).toBe(
      'v1\nGET\nuploads\nk\n7',
    );
  });

  test('a GET signature never works as a PUT one (and other secrets never verify)', async () => {
    const h = await localHarness();
    try {
      const get = signStorageClaims(SECRET, {
        method: 'GET',
        bucket: 'uploads',
        key: 'a.jpg',
        expires: 4_000_000_000,
      });
      const q = new URLSearchParams(get);
      q.set('max', '10');
      q.set('ct', 'image/jpeg');
      const res = await h.fetch(`/api/storage/uploads/a.jpg?${q}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg' },
        body: 'x',
      });
      expect(res.status).toBe(403);
      const other = signStorageClaims('y'.repeat(40), {
        method: 'GET',
        bucket: 'uploads',
        key: 'a.jpg',
        expires: 4_000_000_000,
      });
      await h.writer.put('uploads', 'a.jpg', Buffer.from('x'));
      expect((await h.fetch(`/api/storage/uploads/a.jpg?${other}`)).status).toBe(403);
    } finally {
      await h.cleanup();
    }
  });

  test('content types compare without case or spacing', () => {
    expect(normalizeContentType(' Text/CSV ;  Charset=UTF-8 ')).toBe('text/csv; charset=utf-8');
  });
});
