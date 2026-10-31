import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  CallTally,
  type CallTallyRow,
  currentCallStream,
  errorDetail,
  parseRetryAfter,
  setCallTallySink,
  type VendorCall,
  VendorHttpError,
  VendorNetworkError,
  VendorResponseError,
  vendorFetch,
  vendorJson,
  withCallStream,
  withCallTally,
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

describe('the ambient call tally (1f, sync-health)', () => {
  const at = new Date('2026-10-30T23:59:59Z');
  const call = (vendor: string, outcome: VendorCall['outcome']) => ({ vendor, outcome });

  test('CallTally adds per vendor, stream and UTC day; errors and 429s apart', () => {
    const t = new CallTally();
    t.add(call('deere', 'ok'), 'locations', at);
    t.add(call('deere', 'error'), 'locations', at);
    t.add(call('deere', 'rate_limited'), 'locations', at);
    t.add(call('deere', 'ok'), 'locations', new Date('2026-10-31T00:00:01Z'));
    t.add(call('samsara', 'ok'), 'positions', at);
    expect(t.total).toBe(5);
    expect(t.rows()).toEqual([
      {
        vendor: 'deere',
        stream: 'locations',
        day: '2026-10-30',
        calls: 3,
        errors: 1,
        rateLimited: 1,
      },
      {
        vendor: 'deere',
        stream: 'locations',
        day: '2026-10-31',
        calls: 1,
        errors: 0,
        rateLimited: 0,
      },
      {
        vendor: 'samsara',
        stream: 'positions',
        day: '2026-10-30',
        calls: 1,
        errors: 0,
        rateLimited: 0,
      },
    ]);
    expect(t.drain()).toHaveLength(3);
    expect(t.total).toBe(0);
  });

  test('withCallTally counts every attempt under its stream, unlabelled, on the client clock', async () => {
    const tally = new CallTally();
    const labels: (string | null)[] = [];
    const { fn } = stubFetch([status(503), ok(), status(429, {}), new Error('ECONNRESET')]);
    const { sleep } = recordingSleep();
    const opts = {
      vendor: 'deere',
      fetch: fn,
      sleep,
      maxRetries: 0,
      now: () => at,
      onCall: (c: VendorCall) => labels.push(c.stream),
    };
    await withCallTally(tally, 'locations', async () => {
      await vendorFetch(URL_, {}, { ...opts, maxRetries: 1 }); // 503 then 200
      await vendorFetch(URL_, {}, opts).catch(() => {}); // 429
      await vendorFetch(URL_, {}, opts).catch(() => {}); // no answer
      expect(currentCallStream()).toBeNull();
    });
    expect(labels).toEqual([null, null, null, null]);
    expect(tally.rows()).toEqual([
      {
        vendor: 'deere',
        stream: 'locations',
        day: '2026-10-30',
        calls: 4,
        errors: 2,
        rateLimited: 1,
      },
    ]);
    // Outside any scope nothing is counted.
    await vendorFetch(URL_, {}, { vendor: 'deere', fetch: stubFetch([ok()]).fn });
    expect(tally.total).toBe(4);
  });

  test('withCallStream hands its tally to the installed sink when fn settles (also on a throw)', async () => {
    const flushed: CallTallyRow[][] = [];
    const previous = setCallTallySink(async (rows) => {
      flushed.push(rows);
    });
    try {
      const fetchOk = () => stubFetch([ok(), ok()]).fn;
      const result = await withCallStream('record', async () => {
        await vendorFetch(URL_, {}, { vendor: 'samsara', fetch: fetchOk(), now: () => at });
        await withCallStream('backfill', () =>
          vendorFetch(URL_, {}, { vendor: 'deere', fetch: fetchOk(), now: () => at }),
        );
        return 42;
      });
      expect(result).toBe(42);
      // The inner scope flushed first, with its own label; nothing is counted twice.
      expect(flushed).toEqual([
        [
          {
            vendor: 'deere',
            stream: 'backfill',
            day: '2026-10-30',
            calls: 1,
            errors: 0,
            rateLimited: 0,
          },
        ],
        [
          {
            vendor: 'samsara',
            stream: 'record',
            day: '2026-10-30',
            calls: 1,
            errors: 0,
            rateLimited: 0,
          },
        ],
      ]);
      await expect(
        withCallStream('record', async () => {
          await vendorFetch(URL_, {}, { vendor: 'samsara', fetch: fetchOk(), now: () => at });
          throw new Error('work failed');
        }),
      ).rejects.toThrow('work failed');
      expect(flushed).toHaveLength(3);
      // A scope with no calls flushes nothing; a sink that fails never fails the work.
      await withCallStream('record', async () => {});
      expect(flushed).toHaveLength(3);
      setCallTallySink(async () => {
        throw new Error('database down');
      });
      expect(
        await withCallStream('record', async () => {
          await vendorFetch(URL_, {}, { vendor: 'samsara', fetch: fetchOk() });
          return 'done';
        }),
      ).toBe('done');
    } finally {
      setCallTallySink(previous);
    }
  });

  test('without a sink the tally is dropped (unit tests need no database)', async () => {
    const previous = setCallTallySink(null);
    try {
      expect(
        await withCallStream('record', async () => {
          await vendorFetch(URL_, {}, { vendor: 'samsara', fetch: stubFetch([ok()]).fn });
          return 1;
        }),
      ).toBe(1);
    } finally {
      setCallTallySink(previous);
    }
  });
});

describe('errorDetail', () => {
  test("reads Deere's Equipment API bare error array", () => {
    expect(errorDetail('[{"code":"403","message":"No access to organization 4"}]')).toEqual({
      detail: 'No access to organization 4',
      oauthError: undefined,
    });
    expect(errorDetail('[]')).toEqual({ detail: undefined, oauthError: undefined });
    expect(errorDetail('null')).toEqual({});
  });
});
