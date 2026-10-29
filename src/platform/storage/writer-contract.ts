/**
 * The storage write side's adapter contract suite (plan §7 "Adapter contracts"; docs/
 * contracts-m1.md §9). One suite, run against every adapter: the local one now
 * (./writer.test.ts), the Supabase one at MD (against `supabase start`) with its own harness.
 *
 * The harness gives a fresh writer and a `fetch` that performs the browser's side: PUT to a
 * grant's URL and GET a signed read URL. Locally that `fetch` drives the /api/storage route's
 * logic (./upload.ts); at MD it is the real `fetch` against Supabase Storage. A harness with a
 * controllable clock also runs the expiry cases (`advance`); one without skips them.
 */
import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { StorageKeyError } from './keys';
import type { StorageWriter } from './types';
import { MAX_UPLOAD_BYTES, StorageConflictError, StorageTooLargeError } from './types';

export interface WriterHarness {
  writer: StorageWriter;
  /** The browser side: PUT a grant's URL, GET a signed URL (absolute or origin-relative). */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Move the clock forward (null: the adapter's clock can't be moved; expiry cases skip). */
  advance: ((seconds: number) => void) | null;
  cleanup(): Promise<void>;
}

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed) % 251);

/** Flip one character of the `sig` parameter (a forged signature of the same length). */
export function forge(url: string): string {
  const u = new URL(url, 'http://forge.invalid');
  const sig = u.searchParams.get('sig') ?? '';
  const c = sig.slice(-1) === 'A' ? 'B' : 'A';
  u.searchParams.set('sig', sig.slice(0, -1) + c);
  return url.startsWith('/') ? `${u.pathname}${u.search}` : u.toString();
}

/** Change one signed parameter (keeps the signature). */
export function tamper(url: string, param: string, value: string): string {
  const u = new URL(url, 'http://forge.invalid');
  u.searchParams.set(param, value);
  return url.startsWith('/') ? `${u.pathname}${u.search}` : u.toString();
}

/** The same query on another key. */
export function otherKey(url: string, key: string): string {
  const u = new URL(url, 'http://forge.invalid');
  u.pathname = u.pathname.replace(/[^/]+$/, encodeURIComponent(key));
  return url.startsWith('/') ? `${u.pathname}${u.search}` : u.toString();
}

async function put(h: WriterHarness, url: string, body: Uint8Array, contentType: string) {
  return h.fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: Buffer.from(body),
  });
}

export function describeStorageWriterContract(
  name: string,
  makeHarness: () => Promise<WriterHarness>,
): void {
  describe(`storage writer contract: ${name}`, () => {
    const withHarness = (fn: (h: WriterHarness) => Promise<void>) => async () => {
      const h = await makeHarness();
      try {
        await fn(h);
      } finally {
        await h.cleanup();
      }
    };

    test(
      'signed PUT: accepted once; a retry with the same bytes is a no-op; other bytes 409',
      withHarness(async (h) => {
        const body = bytes(1000);
        const grant = await h.writer.createUploadGrant({
          bucket: 'uploads',
          key: 'photos/p1.jpg',
          contentType: 'image/jpeg',
          bytes: body.length,
        });
        expect(grant).toMatchObject({ bucket: 'uploads', key: 'photos/p1.jpg', method: 'PUT' });
        expect(grant.maxBytes).toBe(1000);
        expect(grant.headers['content-type']).toBe('image/jpeg');
        expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now() - 60_000);

        const first = await put(h, grant.url, body, 'image/jpeg');
        expect(first.status).toBe(201);
        expect(await h.writer.stat('uploads', 'photos/p1.jpg')).toMatchObject({ size: 1000 });

        expect((await put(h, grant.url, body, 'image/jpeg')).status).toBe(200);
        expect((await put(h, grant.url, bytes(1000, 7), 'image/jpeg')).status).toBe(409);
        // A new grant for a taken key is refused up front.
        await expect(
          h.writer.createUploadGrant({
            bucket: 'uploads',
            key: 'photos/p1.jpg',
            contentType: 'image/jpeg',
            bytes: 10,
          }),
        ).rejects.toBeInstanceOf(StorageConflictError);
      }),
    );

    test(
      'forged, tampered and misused PUT URLs are refused with 403 and store nothing',
      withHarness(async (h) => {
        const body = bytes(100);
        const grant = await h.writer.createUploadGrant({
          bucket: 'uploads',
          key: 'a.jpg',
          contentType: 'image/jpeg',
          bytes: 100,
        });
        expect((await put(h, forge(grant.url), body, 'image/jpeg')).status).toBe(403);
        expect((await put(h, tamper(grant.url, 'max', '4000000'), body, 'image/jpeg')).status).toBe(
          403,
        );
        expect(
          (await put(h, tamper(grant.url, 'exp', '9999999999'), body, 'image/jpeg')).status,
        ).toBe(403);
        expect((await put(h, otherKey(grant.url, 'b.jpg'), body, 'image/jpeg')).status).toBe(403);
        // The signed content type must be the one sent.
        expect((await put(h, grant.url, body, 'image/png')).status).toBe(403);
        // An unsigned PUT is never accepted.
        const unsigned = h.writer.publicUrl('uploads', 'a.jpg');
        expect((await put(h, unsigned, body, 'image/jpeg')).status).toBe(403);
        expect(await h.writer.stat('uploads', 'a.jpg')).toBeNull();
        expect(await h.writer.stat('uploads', 'b.jpg')).toBeNull();
      }),
    );

    test(
      'expired PUT grants are refused',
      withHarness(async (h) => {
        if (!h.advance) return;
        const grant = await h.writer.createUploadGrant({
          bucket: 'uploads',
          key: 'late.jpg',
          contentType: 'image/jpeg',
          bytes: 10,
          expiresInSeconds: 60,
        });
        h.advance(61);
        expect((await put(h, grant.url, bytes(10), 'image/jpeg')).status).toBe(403);
        expect(await h.writer.stat('uploads', 'late.jpg')).toBeNull();
      }),
    );

    test(
      '4 MB limit: grants over it are refused; a PUT may not send more than it declared',
      withHarness(async (h) => {
        await expect(
          h.writer.createUploadGrant({
            bucket: 'uploads',
            key: 'big.pdf',
            contentType: 'application/pdf',
            bytes: MAX_UPLOAD_BYTES + 1,
          }),
        ).rejects.toBeInstanceOf(StorageTooLargeError);
        const grant = await h.writer.createUploadGrant({
          bucket: 'uploads',
          key: 'small.pdf',
          contentType: 'application/pdf',
          bytes: 100,
        });
        expect((await put(h, grant.url, bytes(101), 'application/pdf')).status).toBe(413);
        expect(await h.writer.stat('uploads', 'small.pdf')).toBeNull();
        // Fewer bytes than declared are fine.
        expect((await put(h, grant.url, bytes(50), 'application/pdf')).status).toBe(201);
      }),
    );

    test(
      'signed GET: served privately; unsigned 404, forged, other key and expired 403',
      withHarness(async (h) => {
        const body = bytes(500, 3);
        await h.writer.put('uploads', 'docs/r.pdf', body, { contentType: 'application/pdf' });
        await h.writer.put('uploads', 'docs/other.pdf', bytes(10), {
          contentType: 'application/pdf',
        });
        expect((await h.fetch(h.writer.publicUrl('uploads', 'docs/r.pdf'))).status).toBe(404);

        const url = await h.writer.createSignedReadUrl('uploads', 'docs/r.pdf', 60);
        const ok = await h.fetch(url);
        expect(ok.status).toBe(200);
        expect(ok.headers.get('cache-control')).toBe('private, no-store');
        expect(Buffer.from(await ok.arrayBuffer()).equals(Buffer.from(body))).toBe(true);
        const part = await h.fetch(url, { headers: { range: 'bytes=10-19' } });
        expect(part.status).toBe(206);
        expect((await part.arrayBuffer()).byteLength).toBe(10);

        expect((await h.fetch(forge(url))).status).toBe(403);
        expect((await h.fetch(otherKey(url, 'other.pdf'))).status).toBe(403);
        if (h.advance) {
          h.advance(61);
          expect((await h.fetch(url)).status).toBe(403);
        }
      }),
    );

    test(
      'put(): no overwrites in tiles, content-addressed keys must match their bytes',
      withHarness(async (h) => {
        const body = bytes(2048, 5);
        const first = await h.writer.put('tiles', 'naip/test.json', body);
        expect(first.size).toBe(2048);
        await h.writer.put('tiles', 'naip/test.json', Readable.from([Buffer.from(body)]));
        await expect(
          h.writer.put('tiles', 'naip/test.json', bytes(2048, 9)),
        ).rejects.toBeInstanceOf(StorageConflictError);
        await expect(h.writer.put('tiles', 'naip/aoi.00000000.pmtiles', body)).rejects.toThrow(
          /hash/,
        );
        const r = await h.fetch(h.writer.publicUrl('tiles', 'naip/test.json'));
        expect(r.status).toBe(200);
        expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(body))).toBe(true);
      }),
    );

    test(
      'path guard: bad keys never reach storage',
      withHarness(async (h) => {
        for (const key of ['../x.jpg', 'a/../../x.jpg', '/abs.jpg', 'C:/x.jpg', 'a\\b.jpg']) {
          await expect(
            h.writer.createUploadGrant({
              bucket: 'uploads',
              key,
              contentType: 'image/jpeg',
              bytes: 1,
            }),
          ).rejects.toBeInstanceOf(StorageKeyError);
          await expect(h.writer.put('tiles', key, bytes(1))).rejects.toBeInstanceOf(
            StorageKeyError,
          );
        }
      }),
    );

    test(
      'grants refuse a type other than the key serves as, and scriptable types',
      withHarness(async (h) => {
        await expect(
          h.writer.createUploadGrant({
            bucket: 'uploads',
            key: 'x.jpg',
            contentType: 'text/html',
            bytes: 1,
          }),
        ).rejects.toThrow(/does not match/);
        await expect(
          h.writer.createUploadGrant({
            bucket: 'uploads',
            key: 'x.svg',
            contentType: 'image/svg+xml',
            bytes: 1,
          }),
        ).rejects.toThrow(/not allowed/);
      }),
    );

    test(
      'delete: true once, then false',
      withHarness(async (h) => {
        await h.writer.put('tiles', 'old.json', bytes(3));
        expect(await h.writer.delete('tiles', 'old.json')).toBe(true);
        expect(await h.writer.delete('tiles', 'old.json')).toBe(false);
        expect(await h.writer.stat('tiles', 'old.json')).toBeNull();
      }),
    );
  });
}
