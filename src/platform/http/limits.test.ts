import { afterEach, describe, expect, test, vi } from 'vitest';
import { limitedBytes, limitedJson, MAX_API_RESPONSE_BYTES } from './limits';

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
