/**
 * The Jobs tab's loader with fakes: the first load, refetch on `jobs`/`updated` naming this field
 * (and only that), on resync, never two requests at once, polling only while realtime is down,
 * the realtime mode from the snapshot's headers or the job-options probe, and the failure states.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import type { RealtimeClient, SubscribeOptions } from '../../../../platform/realtime/types';
import { FIXTURE_IDS, makeJobView, makeSnapshot } from '../../../work/forms/fixtures';
import {
  type FieldJobsState,
  jobsOfField,
  probeRealtimeHeaders,
  type RealtimeHeaders,
  resetRealtimeProbe,
  startFieldJobs,
} from './loader';

const FIELD = FIXTURE_IDS.field;

class FakeRealtime {
  subs: { topic: string; onEvent: (e: unknown) => void; opts: SubscribeOptions }[] = [];
  live = true;
  client: RealtimeClient = {
    subscribe: ((topic: string, onEvent: (e: unknown) => void, opts: SubscribeOptions) => {
      const sub = { topic, onEvent, opts };
      this.subs.push(sub);
      return () => {
        this.subs = this.subs.filter((s) => s !== sub);
      };
    }) as RealtimeClient['subscribe'],
  };
  emit(topic: string, event: string, payload: unknown) {
    for (const s of this.subs) if (s.topic === topic) s.onEvent({ event, payload, seq: 1 });
  }
  resync() {
    for (const s of this.subs) s.opts.onResync();
  }
}

class FakeTimers {
  fns: (() => void)[] = [];
  setInterval = (fn: () => void) => {
    this.fns.push(fn);
    return this.fns.length;
  };
  clearInterval = () => {
    this.fns = [];
  };
  tick() {
    for (const f of this.fns) f();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

function setup(
  opts: { headers?: Record<string, string>; probe?: RealtimeHeaders | null; status?: number } = {},
) {
  let jobs = [makeJobView()];
  let status = opts.status ?? 200;
  let pending: (() => void) | null = null;
  let gate = false;
  const calls: string[] = [];
  const rt = new FakeRealtime();
  const timers = new FakeTimers();
  const states: FieldJobsState[] = [];
  const resolved: RealtimeHeaders[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (gate) await new Promise<void>((r) => (pending = r));
    return new Response(JSON.stringify(makeSnapshot(jobs, { canPlan: true, role: 'manager' })), {
      status,
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    });
  }) as typeof fetch;
  const loader = startFieldJobs({
    fieldId: FIELD,
    fetch: fetchFn,
    realtime: (h) => {
      resolved.push(h);
      return { client: rt.client, connected: () => rt.live };
    },
    onState: (s) => states.push(s),
    timers,
    probe: async () =>
      'probe' in opts ? (opts.probe ?? null) : { realtime: 'sse', appEnv: 'test' },
  });
  return {
    loader,
    rt,
    timers,
    states,
    calls,
    resolved,
    last: () => states.at(-1) as FieldJobsState,
    setJobs: (j: typeof jobs) => {
      jobs = j;
    },
    setStatus: (s: number) => {
      status = s;
    },
    hold: (on: boolean) => {
      gate = on;
    },
    release: () => {
      const p = pending as (() => void) | null;
      pending = null;
      p?.();
    },
  };
}

beforeEach(() => resetRealtimeProbe());

describe('startFieldJobs', () => {
  test('loads the field’s jobs, then subscribes to jobs with the probed mode', async () => {
    const s = setup();
    expect(s.states[0]?.status).toBe('loading');
    await settle();
    expect(s.calls[0]).toBe(`/api/v1/jobs?fieldId=${FIELD}`);
    expect(s.last()).toMatchObject({ status: 'ready', error: null });
    expect(s.last().jobs?.map((j) => j.id)).toEqual([FIXTURE_IDS.job]);
    expect(s.last().viewer?.canPlan).toBe(true);
    expect(s.rt.subs.map((x) => x.topic)).toEqual(['jobs']);
    expect(s.resolved).toEqual([{ realtime: 'sse', appEnv: 'test' }]);
    s.loader.stop();
    expect(s.rt.subs).toHaveLength(0);
  });

  test("the snapshot's own headers win over the probe", async () => {
    const s = setup({ headers: { 'x-farm-realtime': 'supabase', 'x-farm-app-env': 'production' } });
    await settle();
    expect(s.resolved).toEqual([{ realtime: 'supabase', appEnv: 'production' }]);
    s.loader.stop();
  });

  test('no realtime mode at all: it polls', async () => {
    const s = setup({ probe: null });
    await settle();
    expect(s.rt.subs).toHaveLength(0);
    s.timers.tick();
    await settle();
    expect(s.calls).toHaveLength(2);
    s.loader.stop();
  });

  test('refetches on updated naming this field, on resync; not for other fields', async () => {
    const s = setup();
    await settle();
    const before = s.calls.length;
    s.rt.emit('jobs', 'updated', {
      jobIds: [],
      fieldIds: [FIXTURE_IDS.otherField],
      machineIds: [],
      partyIds: [],
    });
    await settle();
    expect(s.calls.length).toBe(before);
    s.setJobs([makeJobView(), makeJobView({ id: crypto.randomUUID(), status: 'requested' })]);
    s.rt.emit('jobs', 'updated', { jobIds: [], fieldIds: [FIELD], machineIds: [], partyIds: [] });
    await settle();
    expect(s.calls.length).toBe(before + 1);
    expect(s.last().jobs).toHaveLength(2);
    s.rt.resync();
    await settle();
    expect(s.calls.length).toBe(before + 2);
    s.loader.stop();
  });

  test('an identical answer reports nothing new', async () => {
    const s = setup();
    await settle();
    const n = s.states.length;
    s.rt.resync();
    await settle();
    expect(s.states.length).toBe(n);
    s.loader.stop();
  });

  test('never two requests at once: triggers during a request queue exactly one more', async () => {
    const s = setup();
    await settle();
    s.hold(true);
    s.loader.refetch();
    await tick();
    const inFlight = s.calls.length;
    s.loader.refetch();
    s.loader.refetch();
    s.rt.resync();
    await tick();
    expect(s.calls.length).toBe(inFlight);
    s.hold(false);
    s.release();
    await settle();
    expect(s.calls.length).toBe(inFlight + 1);
    s.loader.stop();
  });

  test('polls only while realtime is down', async () => {
    const s = setup();
    await settle();
    const n = s.calls.length;
    s.timers.tick();
    await settle();
    expect(s.calls.length).toBe(n);
    s.rt.live = false;
    s.timers.tick();
    await settle();
    expect(s.calls.length).toBe(n + 1);
    s.loader.stop();
  });

  test('denied, an error before any data, and a failed refresh that keeps the list', async () => {
    const d = setup({ status: 403 });
    await settle();
    expect(d.last().status).toBe('denied');
    d.loader.stop();

    const e = setup({ status: 501 });
    await settle();
    expect(e.last()).toMatchObject({ status: 'error', error: 'the server answered 501' });
    e.loader.stop();

    const k = setup();
    await settle();
    k.setStatus(503);
    k.loader.refetch();
    await settle();
    expect(k.last()).toMatchObject({ status: 'ready', error: 'the server answered 503' });
    expect(k.last().jobs).toHaveLength(1);
    k.loader.stop();
  });

  test('a body that is not a snapshot is an unexpected response', async () => {
    const states: FieldJobsState[] = [];
    const l = startFieldJobs({
      fieldId: FIELD,
      fetch: (async () => new Response('{"lanes":1}', { status: 200 })) as unknown as typeof fetch,
      realtime: () => null,
      onState: (st) => states.push(st),
      timers: new FakeTimers(),
      probe: async () => null,
    });
    await settle();
    expect(states.at(-1)).toMatchObject({ status: 'error', error: 'unexpected response' });
    l.stop();
  });
});

describe('helpers', () => {
  test("jobsOfField keeps only this field's jobs, in board order", () => {
    const a = makeJobView({ id: crypto.randomUUID(), kind: 'haul' });
    const b = makeJobView({ id: crypto.randomUUID() });
    const elsewhere = makeJobView({ id: crypto.randomUUID(), field: null });
    expect(jobsOfField(makeSnapshot([a, b, elsewhere]), FIELD).map((j) => j.id)).toEqual([
      b.id,
      a.id,
    ]);
  });

  test('the probe asks HEAD once and keeps only a good answer', async () => {
    let n = 0;
    let ok = false;
    const f = (async (_: RequestInfo | URL, init?: RequestInit) => {
      n++;
      expect(init?.method).toBe('HEAD');
      return new Response(null, {
        status: ok ? 200 : 503,
        headers: ok ? { 'x-farm-realtime': 'sse', 'x-farm-app-env': 'development' } : {},
      });
    }) as typeof fetch;
    expect(await probeRealtimeHeaders(f)).toBeNull();
    await tick();
    ok = true;
    expect(await probeRealtimeHeaders(f)).toEqual({ realtime: 'sse', appEnv: 'development' });
    expect(await probeRealtimeHeaders(f)).toEqual({ realtime: 'sse', appEnv: 'development' });
    expect(n).toBe(2);
  });
});
