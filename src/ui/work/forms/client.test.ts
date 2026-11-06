/**
 * The job form's calls against a fake fetch: the options load (checked against the contract,
 * cached for the next form), POST and PATCH, the 409 with the current job, and each refusal in
 * words.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { JOB_CONFLICT_MESSAGE } from '../contract';
import { cachedJobOptions, clearJobOptionsCache, loadJobOptions, saveJob } from './client';
import { FIXTURE_IDS, makeJobOptions, makeJobView } from './fixtures';

type Call = { url: string; init: RequestInit };

function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => clearJobOptionsCache());

describe('loadJobOptions', () => {
  test('a good answer is returned and cached', async () => {
    const f = fakeFetch(() => json(200, makeJobOptions()));
    const r = await loadJobOptions(f.fn);
    expect(r.ok).toBe(true);
    expect(f.calls[0]?.url).toBe('/api/v1/job-options');
    expect(f.calls[0]?.init.cache).toBe('no-store');
    expect(cachedJobOptions()?.fields).toHaveLength(2);
  });

  test('refusals, bad answers and no connection', async () => {
    expect(await loadJobOptions(fakeFetch(() => json(403, { error: 'no' })).fn)).toMatchObject({
      ok: false,
      status: 403,
      message: 'Sign in again to plan jobs.',
    });
    expect(await loadJobOptions(fakeFetch(() => json(503, {})).fn)).toMatchObject({
      ok: false,
      message: 'The server answered 503.',
    });
    expect(await loadJobOptions(fakeFetch(() => json(200, { products: 1 })).fn)).toMatchObject({
      ok: false,
      message: 'Unexpected answer.',
    });
    const down = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await loadJobOptions(down.fn)).toMatchObject({ ok: false, status: null });
    expect(cachedJobOptions()).toBeNull();
  });
});

describe('saveJob', () => {
  test('a new job is a POST of the body; the answer is the job', async () => {
    const job = makeJobView();
    const f = fakeFetch(() => json(201, { job }));
    const r = await saveJob(f.fn, 'new', { kind: 'spray' });
    expect(r).toEqual({ kind: 'saved', job });
    expect(f.calls[0]).toMatchObject({ url: '/api/v1/jobs', init: { method: 'POST' } });
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ kind: 'spray' });
    const headers = (f.calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });

  test('an edit is a PATCH of that job', async () => {
    const f = fakeFetch(() => json(200, { job: makeJobView({ version: 4 }) }));
    const r = await saveJob(f.fn, 'edit', { version: 3, title: 'x' }, FIXTURE_IDS.job);
    expect(r.kind).toBe('saved');
    expect(f.calls[0]).toMatchObject({
      url: `/api/v1/jobs/${FIXTURE_IDS.job}`,
      init: { method: 'PATCH' },
    });
    await expect(saveJob(f.fn, 'edit', {})).rejects.toThrow(/job id/);
  });

  test('a 409 hands back the current job and the message', async () => {
    const current = makeJobView({ version: 9, title: 'Changed elsewhere' });
    const f = fakeFetch(() => json(409, { error: JOB_CONFLICT_MESSAGE, job: current }));
    expect(await saveJob(f.fn, 'edit', { version: 3 }, FIXTURE_IDS.job)).toEqual({
      kind: 'conflict',
      job: current,
      message: JOB_CONFLICT_MESSAGE,
    });
    const bare = fakeFetch(() => json(409, { error: 'x' }));
    expect(await saveJob(bare.fn, 'edit', { version: 3 }, FIXTURE_IDS.job)).toMatchObject({
      kind: 'error',
      status: 409,
      message: JOB_CONFLICT_MESSAGE,
    });
  });

  test('refusals in words; nothing claims to be saved', async () => {
    const say = async (status: number, body: unknown = {}) =>
      saveJob(fakeFetch(() => json(status, body)).fn, 'new', {});
    expect(await say(401)).toMatchObject({
      kind: 'error',
      message: 'Sign in again: nothing was saved.',
    });
    expect(await say(403)).toMatchObject({
      message: 'Only a manager can plan jobs: nothing was saved.',
    });
    expect(await say(404, { error: 'field not found' })).toMatchObject({
      message: 'Field not found.',
    });
    expect(await say(422, { error: 'not on a field', reason: 'not_on_field' })).toMatchObject({
      message: 'Not on a field.',
    });
    expect(await say(400, { error: 'the window must end after it starts' })).toMatchObject({
      message: 'The window must end after it starts.',
    });
    expect(await say(503)).toMatchObject({ message: /503: nothing was saved/ });
    const down = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await saveJob(down.fn, 'new', {})).toMatchObject({ kind: 'error', status: null });
    expect(await say(201, { job: { id: 'nope' } })).toMatchObject({ kind: 'error', status: 201 });
  });
});
