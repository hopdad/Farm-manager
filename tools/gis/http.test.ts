import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { describeError, downloadToFile, type FetchLike, fetchWithRetry, HttpError } from './http';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'farm-http-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sequence(...responses: (Response | Error)[]): FetchLike & { calls: number } {
  const state = { calls: 0 };
  const f: FetchLike = async () => {
    const next = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
    if (next instanceof Error) throw next;
    return next as Response;
  };
  // A live getter (Object.assign would copy the value once).
  return Object.defineProperty(f, 'calls', { get: () => state.calls }) as FetchLike & {
    calls: number;
  };
}

describe('fetchWithRetry', () => {
  test('retries 5xx, 429 and network errors, then returns the response', async () => {
    const f = sequence(
      new Response('', { status: 503 }),
      new TypeError('fetch failed'),
      new Response('', { status: 429 }),
      new Response('ok'),
    );
    const res = await fetchWithRetry('https://x/y', {}, { fetch: f, backoffMs: 1 });
    expect(await res.text()).toBe('ok');
    expect(f.calls).toBe(4);
  });

  test('does not retry a 404 and gives up after the last retry', async () => {
    const notFound = sequence(new Response('', { status: 404 }));
    expect((await fetchWithRetry('https://x', {}, { fetch: notFound, backoffMs: 1 })).status).toBe(
      404,
    );
    expect(notFound.calls).toBe(1);
    const down = sequence(new TypeError('fetch failed'));
    await expect(
      fetchWithRetry('https://x/z', {}, { fetch: down, retries: 2, backoffMs: 1 }),
    ).rejects.toThrow('GET https://x/z failed: fetch failed');
    expect(down.calls).toBe(3);
  });
});

describe('downloadToFile', () => {
  test('streams the body to disk and returns the byte count', async () => {
    const dest = path.join(dir, 'a.bin');
    const n = await downloadToFile('https://x/a', dest, { fetch: sequence(new Response('hello')) });
    expect(n).toBe(5);
    expect(await readFile(dest, 'utf8')).toBe('hello');
  });

  test('a non-2xx status throws HttpError and leaves no file', async () => {
    const dest = path.join(dir, 'b.bin');
    await expect(
      downloadToFile('https://x/b', dest, { fetch: sequence(new Response('', { status: 404 })) }),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(stat(dest)).rejects.toThrow();
  });

  test('describeError includes the cause', () => {
    const e = new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
    expect(describeError(e)).toBe('fetch failed: ECONNREFUSED');
    expect(describeError('x')).toBe('x');
  });
});
