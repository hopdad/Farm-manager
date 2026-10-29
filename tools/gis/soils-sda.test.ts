import { describe, expect, test } from 'vitest';
import type { FetchLike } from './http';
import {
  parseSdaBody,
  SDA_FORMAT,
  SDA_MAX_QUERY_BYTES,
  SDA_POST_URL,
  SdaError,
  sdaQuery,
  sdaRecords,
  serviceExceptionOf,
} from './soils-sda';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * A fetch that records its calls and answers from `responses` (the last one repeats). Each
 * entry is a factory: a Response body can be read once, and a clone()'d body can't be
 * cancelled while its twin is unread (fetchWithRetry cancels the bodies it retries past).
 */
function recorder(...responses: (() => Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = (
      responses[Math.min(calls.length - 1, responses.length - 1)] as () => Response | Error
    )();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

describe('parseSdaBody', () => {
  test('JSON+COLUMNNAME: the first row is the column names', () => {
    const t = parseSdaBody(
      JSON.stringify({
        Table: [
          ['mukey', 'muname'],
          ['168', 'Blount loam'],
          ['169', null],
        ],
      }),
    );
    expect(t.columns).toEqual(['mukey', 'muname']);
    expect(t.rows).toEqual([
      ['168', 'Blount loam'],
      ['169', null],
    ]);
    expect(sdaRecords(t)).toEqual([
      { mukey: '168', muname: 'Blount loam' },
      { mukey: '169', muname: null },
    ]);
  });

  test('{} is an empty result (how SDA says "no rows")', () => {
    expect(parseSdaBody('{}')).toEqual({ columns: [], rows: [] });
  });

  test('a header without rows is an empty table', () => {
    expect(parseSdaBody('{"Table":[["mukey"]]}')).toEqual({ columns: ['mukey'], rows: [] });
  });

  test('record keys are lower-cased', () => {
    expect(sdaRecords(parseSdaBody('{"Table":[["MUKEY","AreaSymbol"],["1","MI091"]]}'))).toEqual([
      { mukey: '1', areasymbol: 'MI091' },
    ]);
  });

  test.each([
    ['not JSON', '<html>down</html>', 'unavailable'],
    ['an array', '[]', 'parse'],
    ['two tables', '{"Table":[["a"]],"Table1":[["b"]]}', 'parse'],
    ['ragged rows', '{"Table":[["a","b"],["1"]]}', 'parse'],
    ['no header', '{"Table":[[1,2]]}', 'parse'],
    ['nested values', '{"Table":[["a"],[{"x":1}]]}', 'parse'],
  ])('%s → SdaError', (_name, text, kind) => {
    try {
      parseSdaBody(text);
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SdaError);
      expect((e as SdaError).kind).toBe(kind);
    }
  });
});

describe('serviceExceptionOf', () => {
  test('extracts and unescapes the message', () => {
    expect(
      serviceExceptionOf(
        '<ServiceExceptionReport><ServiceException>Invalid column name &apos;foo&apos;.</ServiceException></ServiceExceptionReport>',
      ),
    ).toBe("Invalid column name 'foo'.");
    expect(serviceExceptionOf('<html/>')).toBeNull();
  });
});

describe('sdaQuery', () => {
  test('POSTs {format, query} as JSON to the documented endpoint', async () => {
    const r = recorder(() => json({ Table: [['n'], ['1']] }));
    const reply = await sdaQuery('SELECT 1 AS n', { fetch: r.fetch });
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0];
    expect(call?.url).toBe(SDA_POST_URL);
    expect(call?.init?.method).toBe('POST');
    expect(new Headers(call?.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      format: SDA_FORMAT,
      query: 'SELECT 1 AS n',
    });
    expect(reply.table.rows).toEqual([['1']]);
    expect(reply.text).toBe('{"Table":[["n"],["1"]]}');
    expect(reply.bytes).toBe(reply.text.length);
  });

  test('a ServiceException becomes kind "service" with the message', async () => {
    const r = recorder(
      () =>
        new Response(
          '<ServiceException>Invalid object name &apos;mupolygonx&apos;.</ServiceException>',
          {
            status: 400,
            headers: { 'content-type': 'text/xml' },
          },
        ),
    );
    await expect(sdaQuery('SELECT * FROM mupolygonx', { fetch: r.fetch })).rejects.toMatchObject({
      kind: 'service',
      status: 400,
      message: "SDA: Invalid object name 'mupolygonx'.",
    });
  });

  test('5xx are retried, then reported', async () => {
    const r = recorder(() => new Response('busy', { status: 503 }));
    await expect(
      sdaQuery('SELECT 1', { fetch: r.fetch, retries: 2, backoffMs: 1 }),
    ).rejects.toMatchObject({ kind: 'http', status: 503 });
    expect(r.calls).toHaveLength(3);
  });

  test('the maintenance page (not JSON) is "unavailable"', async () => {
    const r = recorder(
      () =>
        new Response('Site is under daily maintenance from 12:30 AM CST to 12:45 AM CST.', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    await expect(sdaQuery('SELECT 1', { fetch: r.fetch })).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  test('network failures are "network" and say POST', async () => {
    const r = recorder(() => new TypeError('fetch failed'));
    const e = await sdaQuery('SELECT 1', { fetch: r.fetch, retries: 0 }).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: 'network' });
    expect((e as Error).message).toMatch(/^POST https:\/\/SDMDataAccess.+failed: fetch failed/);
  });

  test('refuses a query over the 2.5 MB limit without sending it', async () => {
    const r = recorder(() => json({}));
    await expect(
      sdaQuery(`SELECT '${'x'.repeat(SDA_MAX_QUERY_BYTES)}'`, { fetch: r.fetch }),
    ).rejects.toMatchObject({ kind: 'query_too_long' });
    expect(r.calls).toHaveLength(0);
  });
});
