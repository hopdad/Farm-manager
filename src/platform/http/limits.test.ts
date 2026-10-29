import { afterEach, describe, expect, test, vi } from 'vitest';
import { limitedBytes, limitedJson, MAX_API_RESPONSE_BYTES, readLimitedText } from './limits';

afterEach(() => vi.restoreAllMocks());

describe('response size guard (plan §1: production limits apply locally)', () => {
  test('small responses pass through unchanged', async () => {
    const r = limitedJson({ ok: true }, { status: 202, headers: { 'cache-control': 'no-store' } });
    expect(r.status).toBe(202);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ ok: true });
    const b = limitedBytes(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'application/x-protobuf' },
    });
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(b.headers.get('content-type')).toBe('application/x-protobuf');
  });

  test('over 4 MB becomes a 500 that says why, and the route is logged', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const big = { blob: 'x'.repeat(MAX_API_RESPONSE_BYTES) };
    const r = limitedJson(big, {}, { route: 'api/fleet', enforce: true });
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/over 4 MB/);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/^\[api\/fleet\] response of \d+ bytes/);
    const bytes = limitedBytes(new Uint8Array(MAX_API_RESPONSE_BYTES + 1), {}, { enforce: true });
    expect(bytes.status).toBe(500);
    // Exactly at the limit is fine; UTF-8 is measured in bytes, not characters.
    expect(limitedBytes(new Uint8Array(MAX_API_RESPONSE_BYTES), {}, { enforce: true }).status).toBe(
      200,
    );
    expect(limitedBytes('é'.repeat(3), {}, { enforce: true, limit: 5 }).status).toBe(500);
  });

  test('not enforced (production): passes through', () => {
    const r = limitedBytes(new Uint8Array(10), {}, { enforce: false, limit: 5 });
    expect(r.status).toBe(200);
  });
});

describe('readLimitedText (request bodies, plan §1: 4 MB)', () => {
  const chunked = (chunks: number, size: number) => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ >= chunks) c.close();
        else c.enqueue(new Uint8Array(size).fill(0x61));
      },
    });
    // duplex: a streamed body has no Content-Length (what a chunked upload looks like)
    return new Request('http://x/api/webhooks/samsara', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  };

  test('reads a small body', async () => {
    const r = new Request('http://x', { method: 'POST', body: 'héllo' });
    expect(await readLimitedText(r)).toBe('héllo');
    expect(await readLimitedText(new Request('http://x'))).toBe('');
  });

  test('stops at the limit even without Content-Length', async () => {
    const r = chunked(10, 1024);
    expect(r.headers.get('content-length')).toBeNull();
    expect(await readLimitedText(r, 4096)).toBeNull();
    expect(await readLimitedText(chunked(4, 1024), 4096)).toHaveLength(4096);
  });

  test('a declared length over the limit is refused without reading', async () => {
    const r = new Request('http://x', {
      method: 'POST',
      body: 'x',
      headers: { 'content-length': String(5 * 1024 * 1024) },
    });
    expect(await readLimitedText(r)).toBeNull();
  });
});
