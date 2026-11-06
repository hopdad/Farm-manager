import { describe, expect, test } from 'vitest';
import { JOB_CONFLICT_MESSAGE } from '../contract';
import { createBoardApi } from './api';
import { createMapWorld, MockJobsApi, makeJobView } from './testkit';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JOB = makeJobView({ id: id(1), kind: 'spray', version: 4 });

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(answer: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: String(input), init };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('writes: the routes, the bodies, the version', () => {
  test('each write goes to its route with the version the screen saw', async () => {
    const { fn, calls } = fakeFetch(() => json(200, { job: JOB }));
    const api = createBoardApi(fn);
    await api.setField(JOB, { fieldId: id(2) });
    await api.setField(JOB, { at: { lng: -83.7, lat: 41.7 } });
    await api.assign(JOB, { machineId: id(3) });
    await api.assign(JOB, { partyId: id(4) });
    await api.unassign(JOB, id(5));
    await api.unassign(JOB, id(5), 'person');
    await api.setStatus(JOB, 'in_progress');
    await api.cancel(JOB, '  rain coming  ');
    await api.cancel(JOB, '   ');
    const seen = calls.map((c) => [
      c.init?.method,
      c.url,
      c.init?.body ? JSON.parse(String(c.init.body)) : null,
    ]);
    expect(seen).toEqual([
      ['PUT', `/api/v1/jobs/${id(1)}/field`, { version: 4, fieldId: id(2) }],
      ['PUT', `/api/v1/jobs/${id(1)}/field`, { version: 4, at: { lng: -83.7, lat: 41.7 } }],
      ['POST', `/api/v1/jobs/${id(1)}/assignments`, { version: 4, machineId: id(3) }],
      ['POST', `/api/v1/jobs/${id(1)}/assignments`, { version: 4, partyId: id(4) }],
      ['DELETE', `/api/v1/jobs/${id(1)}/assignments/${id(5)}?version=4`, null],
      ['DELETE', `/api/v1/jobs/${id(1)}/assignments/${id(5)}?version=4&part=person`, null],
      ['POST', `/api/v1/jobs/${id(1)}/status`, { version: 4, status: 'in_progress' }],
      ['POST', `/api/v1/jobs/${id(1)}/cancel`, { version: 4, reason: 'rain coming' }],
      ['POST', `/api/v1/jobs/${id(1)}/cancel`, { version: 4 }],
    ]);
    const put = calls[0]?.init;
    expect(put?.credentials).toBe('same-origin');
    expect(put?.cache).toBe('no-store');
    expect((put?.headers ?? {}) as Record<string, string>).toMatchObject({
      'content-type': 'application/json',
    });
    // A DELETE has no body and no content type.
    expect((calls[4]?.init?.headers ?? {}) as Record<string, string>).not.toHaveProperty(
      'content-type',
    );
  });

  test('reorder sends the lane and answers the snapshot', async () => {
    const api = new MockJobsApi(createMapWorld({}));
    api.put(makeJobView({ id: id(1), kind: 'spray', sortKey: 10 }));
    api.put(makeJobView({ id: id(2), kind: 'spray', sortKey: 20 }));
    const { fn } = fakeFetch(async (c) => {
      const r = await api.handle({
        method: c.init?.method ?? 'GET',
        url: `http://x${c.url}`,
        body: String(c.init?.body ?? ''),
        viewer: { role: 'manager', partyId: null },
      });
      return json(r.status, r.body);
    });
    const r = await createBoardApi(fn).reorder('spraying', [
      { id: id(2), version: 1 },
      { id: id(1), version: 1 },
    ]);
    expect(r.ok && r.snapshot.lanes[0]?.jobs.map((j) => j.id)).toEqual([id(2), id(1)]);
  });
});

describe('refusals become plain results', () => {
  const answer = async (res: Response | Error) => {
    const { fn } = fakeFetch(() => {
      if (res instanceof Error) throw res;
      return res;
    });
    return createBoardApi(fn).setStatus(JOB, 'done');
  };

  test('409: the current job and the conflict message', async () => {
    const current = { ...JOB, version: 5, title: 'Theirs' };
    const r = await answer(json(409, { error: JOB_CONFLICT_MESSAGE, job: current }));
    expect(r).toEqual({ ok: false, kind: 'conflict', job: current, message: JOB_CONFLICT_MESSAGE });
    // A 409 without a job still says it.
    expect(await answer(json(409, { error: 'x' }))).toMatchObject({
      message: JOB_CONFLICT_MESSAGE,
    });
  });

  test('422 with its reason, in plain words', async () => {
    expect(await answer(json(422, { error: 'not on a field', reason: 'not_on_field' }))).toEqual({
      ok: false,
      kind: 'rule',
      reason: 'not_on_field',
      message: 'That spot is not on a field',
    });
    expect(
      await answer(
        json(422, { error: 'only billing (M3) marks a job invoiced', reason: 'not_allowed' }),
      ),
    ).toMatchObject({ reason: 'not_allowed', message: 'only billing (M3) marks a job invoiced' });
    expect(await answer(json(422, { error: 'odd', reason: 'unknown' }))).toMatchObject({
      reason: null,
      message: 'odd',
    });
  });

  test('401/403, 404, 5xx, no connection, a bad answer', async () => {
    expect(await answer(json(401, { error: 'x' }))).toMatchObject({ kind: 'denied' });
    expect(await answer(json(403, { error: 'only the people on this job can change it' }))).toEqual(
      {
        ok: false,
        kind: 'denied',
        message: 'only the people on this job can change it',
      },
    );
    expect(await answer(json(404, {}))).toMatchObject({ kind: 'not_found' });
    expect(await answer(json(503, { error: 'db' }))).toMatchObject({
      kind: 'error',
      message: "The server couldn't save it (503); try again",
    });
    expect(await answer(new TypeError('offline'))).toMatchObject({ kind: 'error' });
    expect(await answer(json(200, { nope: true }))).toMatchObject({ kind: 'error' });
  });
});

describe('reads', () => {
  test('snapshot: parsed, refused, not on this server yet, broken', async () => {
    const snap = {
      asOf: '2026-11-06T17:00:00.000Z',
      viewer: { role: 'viewer', partyId: null, canPlan: false },
      lanes: [],
    };
    const read = async (res: Response) => createBoardApi(fakeFetch(() => res).fn).snapshot();
    expect(await read(json(200, snap))).toEqual({ ok: true, value: snap });
    expect(await read(json(403, {}))).toMatchObject({ ok: false, kind: 'denied', status: 403 });
    expect(await read(json(501, { error: 'not built yet' }))).toMatchObject({
      ok: false,
      kind: 'unavailable',
      status: 501,
    });
    expect(await read(json(500, {}))).toMatchObject({ ok: false, kind: 'error', status: 500 });
    expect(await read(new Response('<html>', { status: 200 }))).toMatchObject({
      ok: false,
      kind: 'error',
      message: 'unexpected response',
    });
  });

  test('crew', async () => {
    const people = [
      {
        partyId: id(1),
        appUserId: null,
        name: 'Dale',
        initials: 'DM',
        appRole: null,
        active: true,
      },
    ];
    const r = await createBoardApi(fakeFetch(() => json(200, { people })).fn).crew();
    expect(r).toEqual({ ok: true, value: people });
  });

  test('an aborted read throws (the feed drops it); a failed one does not', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { fn } = fakeFetch(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(createBoardApi(fn).snapshot(ctrl.signal)).rejects.toThrow();
    expect(await createBoardApi(fn).snapshot()).toMatchObject({ ok: false, kind: 'error' });
  });
});
