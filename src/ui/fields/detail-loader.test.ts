import { describe, expect, test } from 'vitest';
import type { FieldDetail } from '../../domain/fields';
import type { RealtimeClient, SubscribeOptions, TopicMessage } from '../../platform/realtime/types';
import {
  FieldDetailCache,
  type FieldDetailState,
  type IntervalTimers,
  initialDetailState,
  startFieldDetail,
} from './detail-loader';
import { FIXTURE_FIELD_ID, makeFieldDetail } from './fixtures';
import { FIELD_ROLE_HEADER } from './protocol';

const ID = FIXTURE_FIELD_ID;

/** A fetch whose answers the test releases one by one. */
function controlledFetch() {
  const calls: {
    url: string;
    init?: RequestInit;
    resolve(r: Response): void;
    reject(e: unknown): void;
  }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({ url, init, resolve, reject });
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    })) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (detail: FieldDetail, role = 'manager') =>
  new Response(JSON.stringify(detail), {
    status: 200,
    headers: { 'content-type': 'application/json', [FIELD_ROLE_HEADER]: role },
  });

function fakeRealtime(connected = true) {
  const subs: { topic: string; onEvent(e: unknown): void; opts: SubscribeOptions }[] = [];
  const client: RealtimeClient = {
    subscribe(topic, onEvent, opts) {
      const s = { topic, onEvent: onEvent as (e: unknown) => void, opts };
      subs.push(s);
      return () => {
        subs.splice(subs.indexOf(s), 1);
      };
    },
  };
  return {
    realtime: { client, connected: () => connected },
    subs,
    emit(msg: TopicMessage<'fields'>) {
      for (const s of subs) if (s.topic === 'fields') s.onEvent(msg);
    },
    resync() {
      for (const s of subs) s.opts.onResync();
    },
  };
}

function manualTimers() {
  const fns = new Map<number, () => void>();
  let n = 0;
  const timers: IntervalTimers = {
    setInterval(fn) {
      fns.set(++n, fn);
      return n;
    },
    clearInterval(h) {
      fns.delete(h as number);
    },
  };
  return {
    timers,
    tick: () => {
      for (const f of fns.values()) f();
    },
    count: () => fns.size,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(opts: { connected?: boolean; cache?: FieldDetailCache } = {}) {
  const f = controlledFetch();
  const rt = fakeRealtime(opts.connected ?? true);
  const tm = manualTimers();
  const states: FieldDetailState[] = [];
  const loader = startFieldDetail({
    fieldId: ID,
    fetch: f.fetchImpl,
    realtime: rt.realtime,
    onState: (s) => states.push(s),
    timers: tm.timers,
    cache: opts.cache ?? new FieldDetailCache(),
  });
  const last = () => states[states.length - 1] as FieldDetailState;
  return { ...f, ...rt, ...tm, states, loader, last };
}

describe('startFieldDetail', () => {
  test('loads once at start, then reports ready with the role the server sent', async () => {
    const h = harness();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(`/api/fields/${ID}`);
    expect(h.calls[0]?.init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
    expect(h.states[0]).toMatchObject({ status: 'loading', detail: null, role: 'viewer' });
    h.calls[0]?.resolve(ok(makeFieldDetail(), 'manager'));
    await flush();
    expect(h.last()).toMatchObject({ status: 'ready', role: 'manager', error: null });
    expect(h.last().detail?.field.name).toBe('Abernath East 80');
    h.loader.stop();
  });

  test('an unknown role header falls back to viewer', async () => {
    const h = harness();
    h.calls[0]?.resolve(ok(makeFieldDetail(), 'admin'));
    await flush();
    expect(h.last().role).toBe('viewer');
    h.loader.stop();
  });

  test('refetches on fields/updated for this field only, and on resync', async () => {
    const h = harness();
    h.calls[0]?.resolve(ok(makeFieldDetail()));
    await flush();
    h.emit({ event: 'updated', payload: { fieldId: 'other', parts: ['notes'] }, seq: 1 });
    expect(h.calls).toHaveLength(1);
    h.emit({ event: 'updated', payload: { fieldId: ID, parts: ['notes'] }, seq: 2 });
    expect(h.calls).toHaveLength(2);
    const changed = makeFieldDetail({
      notes: { text: 'new', updatedAt: null, updatedByName: null, version: 'v2' },
    });
    h.calls[1]?.resolve(ok(changed));
    await flush();
    expect(h.last().detail?.notes.text).toBe('new');
    h.resync();
    expect(h.calls).toHaveLength(3);
    h.loader.stop();
  });

  test('an identical answer reports nothing new (no re-render)', async () => {
    const h = harness();
    h.calls[0]?.resolve(ok(makeFieldDetail()));
    await flush();
    const n = h.states.length;
    const first = h.last().detail;
    h.resync();
    h.calls[1]?.resolve(ok(makeFieldDetail()));
    await flush();
    expect(h.states.length).toBe(n);
    expect(h.last().detail).toBe(first);
    h.loader.stop();
  });

  test('a body that is not JSON is an unexpected response', async () => {
    const h = harness();
    h.calls[0]?.resolve(new Response('<html>', { status: 200 }));
    await flush();
    expect(h.last()).toMatchObject({ status: 'error', error: 'unexpected response' });
    h.loader.stop();
  });

  test('triggers during a request queue exactly one more request', async () => {
    const h = harness();
    h.emit({ event: 'updated', payload: { fieldId: ID, parts: ['notes'] }, seq: 1 });
    h.resync();
    h.emit({ event: 'updated', payload: { fieldId: ID, parts: ['boundary'] }, seq: 2 });
    expect(h.calls).toHaveLength(1);
    h.calls[0]?.resolve(ok(makeFieldDetail()));
    await flush();
    expect(h.calls).toHaveLength(2);
    h.calls[1]?.resolve(ok(makeFieldDetail()));
    await flush();
    expect(h.calls).toHaveLength(2);
    h.loader.stop();
  });

  test('404 → not_found, 401/403 → denied, both drop the cached copy', async () => {
    const cache = new FieldDetailCache();
    cache.set(ID, { detail: makeFieldDetail(), role: 'owner' });
    const h = harness({ cache });
    h.calls[0]?.resolve(new Response('{"error":"field not found"}', { status: 404 }));
    await flush();
    expect(h.last()).toMatchObject({ status: 'not_found', detail: null });
    expect(cache.get(ID)).toBeUndefined();
    h.loader.refetch();
    h.calls[1]?.resolve(new Response('{}', { status: 403 }));
    await flush();
    expect(h.last()).toMatchObject({ status: 'denied', detail: null });
    h.loader.stop();
  });

  test('a failure keeps the detail it had and says why; with nothing to show it is an error', async () => {
    const h = harness();
    h.calls[0]?.reject(new TypeError('Failed to fetch'));
    await flush();
    expect(h.last()).toMatchObject({ status: 'error', error: 'no connection', detail: null });
    h.loader.refetch();
    h.calls[1]?.resolve(ok(makeFieldDetail()));
    await flush();
    h.loader.refetch();
    h.calls[2]?.resolve(new Response('{}', { status: 503 }));
    await flush();
    expect(h.last()).toMatchObject({ status: 'ready', error: 'the server answered 503' });
    expect(h.last().detail).not.toBeNull();
    h.loader.stop();
  });

  test('a body for another field is refused', async () => {
    const h = harness();
    h.calls[0]?.resolve(ok(makeFieldDetail({ field: { id: 'someone-else' } })));
    await flush();
    expect(h.last()).toMatchObject({ status: 'error', error: 'unexpected response' });
    h.loader.stop();
  });

  test('polls only while realtime is down', async () => {
    const up = harness({ connected: true });
    up.calls[0]?.resolve(ok(makeFieldDetail()));
    await flush();
    up.tick();
    expect(up.calls).toHaveLength(1);
    up.loader.stop();

    const down = harness({ connected: false });
    down.calls[0]?.resolve(ok(makeFieldDetail()));
    await flush();
    down.tick();
    expect(down.calls).toHaveLength(2);
    down.loader.stop();
  });

  test('stop aborts, unsubscribes, clears the poll and reports nothing more', async () => {
    const h = harness();
    const before = h.states.length;
    h.loader.stop();
    expect(h.subs).toHaveLength(0);
    expect(h.count()).toBe(0);
    h.calls[0]?.resolve(ok(makeFieldDetail()));
    await flush();
    expect(h.states.length).toBe(before);
    h.loader.refetch();
    expect(h.calls).toHaveLength(1);
  });

  test('a field seen before opens from the cache, then revalidates', async () => {
    const cache = new FieldDetailCache();
    cache.set(ID, { detail: makeFieldDetail(), role: 'owner' });
    expect(initialDetailState(ID, cache)).toMatchObject({ status: 'ready', role: 'owner' });
    const h = harness({ cache });
    expect(h.states[0]).toMatchObject({ status: 'ready', role: 'owner' });
    expect(h.calls).toHaveLength(1);
    h.loader.stop();
  });
});

describe('FieldDetailCache', () => {
  test('keeps the most recently used entries', () => {
    const c = new FieldDetailCache(2);
    const v = { detail: makeFieldDetail(), role: 'viewer' as const };
    c.set('a', v);
    c.set('b', v);
    c.get('a');
    c.set('c', v);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeDefined();
    expect(c.get('c')).toBeDefined();
    expect(c.size).toBe(2);
  });
});
