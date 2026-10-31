import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  currentCallStream,
  errorDetail,
  parseRetryAfter,
  type VendorCall,
  VendorHttpError,
  VendorNetworkError,
  VendorResponseError,
  vendorFetch,
  vendorJson,
  withCallStream,
} from './http';

type Step = Response | Error;

/** fetch stub answering `steps` in order; records calls. */
function stubFetch(steps: Step[]) {
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const s = steps.shift();
    if (!s) throw new Error('no more steps');
    if (s instanceof Error) throw s;
    return s;
  }) as typeof fetch;
  return { fn, calls };
}

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

const ok = (body: unknown = { ok: true }) => Response.json(body);
const status = (
  s: number,
  headers: Record<string, string> = {},
  body: unknown = { message: `HTTP ${s}` },
) => Response.json(body, { status: s, headers });
const URL_ = 'http://vendor.test/fleet/vehicles/locations/feed?after=secret-cursor';

describe('parseRetryAfter', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  test('delta seconds, HTTP dates and junk', () => {
    expect(parseRetryAfter('30', now)).toBe(30);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
    expect(parseRetryAfter('Thu, 29 Oct 2026 12:01:30 GMT', now)).toBe(90);
    expect(parseRetryAfter('Thu, 29 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
  test('fractional delta seconds round up (Samsara 0.40235, Terminal 0.62), never a date', () => {
    expect(parseRetryAfter('0.40235', now)).toBe(1);
    expect(parseRetryAfter('0.62', now)).toBe(1);
    expect(parseRetryAfter('1.5', now)).toBe(2);
    expect(parseRetryAfter('2.0', now)).toBe(2);
    expect(parseRetryAfter('1.2.3', now)).toBeUndefined();
  });
});

describe('vendorFetch retries', () => {
  test('a short Retry-After is waited out in-process, then the call succeeds', async () => {
    const f = stubFetch([status(429, { 'retry-after': '1' }), ok()]);
    const s = recordingSleep();
    const res = await vendorFetch(URL_, {}, { vendor: 'samsara', fetch: f.fn, sleep: s.sleep });
    expect(res.status).toBe(200);
    expect(s.waits).toEqual([1000]);
    expect(f.calls).toHaveLength(2);
  });

  test('a long Retry-After is thrown as retryAfterSeconds (the stream backs off)', async () => {
    const f = stubFetch([status(429, { 'retry-after': '30' }, { message: 'Rate limit exceeded' })]);
    const s = recordingSleep();
    const err = await vendorFetch(
      URL_,
      {},
      { vendor: 'samsara', fetch: f.fn, sleep: s.sleep },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorHttpError);
    expect(err).toMatchObject({
      status: 429,
      retryAfterSeconds: 30,
      detail: 'Rate limit exceeded',
    });
    expect((err as Error).message).not.toContain('secret-cursor');
    expect(s.waits).toEqual([]);
  });

  test('5xx and network errors back off and retry; then give up', async () => {
    const s = recordingSleep();
    const f = stubFetch([status(500), status(502), ok()]);
    expect((await vendorFetch(URL_, {}, { vendor: 'x', fetch: f.fn, sleep: s.sleep })).status).toBe(
      200,
    );
    expect(s.waits).toEqual([250, 500]);

    const net = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const g = stubFetch([net, net, net]);
    const err = await vendorFetch(
      URL_,
      {},
      { vendor: 'samsara', fetch: g.fn, sleep: s.sleep },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorNetworkError);
    expect((err as Error).message).toBe(
      'samsara /fleet/vehicles/locations/feed: unreachable (ECONNRESET)',
    );
    expect(g.calls).toHaveLength(3);
  });

  test('4xx is not retried; 401 surfaces for the caller to refresh', async () => {
    const f = stubFetch([
      status(401, {}, { errors: [{ message: 'Invalid or expired access token' }] }),
    ]);
    const err = (await vendorFetch(URL_, {}, { vendor: 'deere', fetch: f.fn }).catch(
      (e) => e,
    )) as VendorHttpError;
    expect(err.status).toBe(401);
    expect(err.detail).toBe('Invalid or expired access token');
    expect(f.calls).toHaveLength(1);
  });

  test('no retry may cross the deadline', async () => {
    const now = new Date('2026-10-29T12:00:00Z');
    const f = stubFetch([status(429, { 'retry-after': '2' })]);
    const s = recordingSleep();
    const err = await vendorFetch(
      URL_,
      {},
      {
        vendor: 'x',
        fetch: f.fn,
        sleep: s.sleep,
        now: () => now,
        deadline: new Date(now.getTime() + 2500),
      },
    ).catch((e) => e);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 2 });
    expect(s.waits).toEqual([]);
  });

  test('a caller abort is rethrown as is, without retries', async () => {
    const ac = new AbortController();
    const reason = new Error('job deadline');
    ac.abort(reason);
    const f = stubFetch([new DOMException('aborted', 'AbortError')]);
    await expect(
      vendorFetch(URL_, {}, { vendor: 'x', fetch: f.fn, signal: ac.signal }),
    ).rejects.toBe(reason);
  });
});

describe('vendorJson', () => {
  const schema = z.object({ n: z.number() });
  test('validates with the shared schema', async () => {
    expect(
      await vendorJson(schema, URL_, {}, { vendor: 'x', fetch: stubFetch([ok({ n: 1 })]).fn }),
    ).toEqual({
      n: 1,
    });
    const err = await vendorJson(
      schema,
      URL_,
      {},
      { vendor: 'x', fetch: stubFetch([ok({ n: 'one' })]).fn },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(VendorResponseError);
    expect((err as Error).message).toContain('n:');
  });

  test('errorDetail reads the common error shapes', () => {
    expect(errorDetail('{"message":"m","requestId":"r"}')).toEqual({ detail: 'm' });
    expect(errorDetail('{"error":"invalid_grant","error_description":"used"}')).toEqual({
      detail: 'used',
      oauthError: 'invalid_grant',
    });
    expect(errorDetail('{"errors":[{"message":"nope"}]}')).toEqual({ detail: 'nope' });
    expect(errorDetail('<html>')).toEqual({});
  });
});

describe('onCall (1f call counter)', () => {
  test('one call per attempt: retries count, outcomes and statuses as sent', async () => {
    const calls: VendorCall[] = [];
    const { fn } = stubFetch([status(503), status(429, { 'retry-after': '1' }), ok()]);
    const { sleep } = recordingSleep();
    await vendorFetch(
      URL_,
      { method: 'get' },
      { vendor: 'samsara', fetch: fn, sleep, onCall: (c) => calls.push(c) },
    );
    expect(calls.map((c) => [c.attempt, c.status, c.outcome])).toEqual([
      [0, 503, 'error'],
      [1, 429, 'rate_limited'],
      [2, 200, 'ok'],
    ]);
    for (const c of calls) {
      expect(c).toMatchObject({ vendor: 'samsara', method: 'GET' });
      expect(c.path).toBe('/fleet/vehicles/locations/feed'); // no query: the cursor stays out
      expect(c.ms).toBeGreaterThanOrEqual(0);
    }
  });

  test('a network error counts as an error with no status; a throwing hook is ignored', async () => {
    const calls: VendorCall[] = [];
    const { fn } = stubFetch([new TypeError('fetch failed'), ok()]);
    const { sleep } = recordingSleep();
    const res = await vendorFetch(
      URL_,
      {},
      {
        vendor: 'deere',
        fetch: fn,
        sleep,
        onCall: (c) => {
          calls.push(c);
          throw new Error('counter broke');
        },
      },
    );
    expect(res.status).toBe(200);
    expect(calls.map((c) => [c.status, c.outcome])).toEqual([
      [null, 'error'],
      [200, 'ok'],
    ]);
  });

  test('withCallStream labels the calls inside it (innermost wins); outside, the label is null', async () => {
    const calls: VendorCall[] = [];
    const once = () =>
      vendorFetch(
        URL_,
        {},
        { vendor: 'deere', fetch: stubFetch([ok()]).fn, onCall: (c) => calls.push(c) },
      );
    await once();
    await withCallStream('backfill', async () => {
      await once();
      await withCallStream('record', once);
      await Promise.all([once(), once()]);
    });
    expect(calls.map((c) => c.stream)).toEqual([
      null,
      'backfill',
      'record',
      'backfill',
      'backfill',
    ]);
    expect(currentCallStream()).toBeNull();
    expect(await withCallStream('x', async () => currentCallStream())).toBe('x');
  });

  test('without a hook nothing changes (the default counts nothing)', async () => {
    const { fn } = stubFetch([ok({ a: 1 })]);
    const body = await vendorJson(
      z.object({ a: z.number() }),
      URL_,
      {},
      { vendor: 'x', fetch: fn },
    );
    expect(body).toEqual({ a: 1 });
  });
});
