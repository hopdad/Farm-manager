/**
 * The board's usage heartbeat (docs/contracts-2a.md §7.7; done-when §11.4: every
 * USAGE_HEARTBEAT_MS): a beat at once and every interval while visible, none while hidden, a
 * catch-up beat on coming back once the last one is old enough, never two requests at once, and
 * a 401 or stop() ends it.
 */
import { describe, expect, test } from 'vitest';
import { USAGE_BUCKET_MINUTES, USAGE_HEARTBEAT_MS } from '../../domain/work-jobs';
import { USAGE_URL } from '../work/contract';
import { type HeartbeatDocument, type HeartbeatTimers, startUsageHeartbeat } from './heartbeat';

function fakeTimers() {
  let fn: (() => void) | null = null;
  let ms = 0;
  let cleared = false;
  const timers: HeartbeatTimers = {
    setInterval(f, m) {
      fn = f;
      ms = m;
      return 7;
    },
    clearInterval(h) {
      if (h === 7) cleared = true;
    },
  };
  return {
    timers,
    tick: () => fn?.(),
    get ms() {
      return ms;
    },
    get cleared() {
      return cleared;
    },
  };
}

function fakeDocument(state = 'visible') {
  const listeners = new Set<() => void>();
  const doc: HeartbeatDocument & { visibilityState: string } = {
    visibilityState: state,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
  };
  return {
    doc,
    set(next: string) {
      doc.visibilityState = next;
      for (const fn of listeners) fn();
    },
    listeners,
  };
}

function fakeFetch() {
  const calls: { url: string; init?: RequestInit; resolve(status: number): void }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      calls.push({
        url,
        init,
        resolve: (status) =>
          resolve(new Response(JSON.stringify({ recorded: status === 200 }), { status })),
      });
    })) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('startUsageHeartbeat', () => {
  test('the interval stays under the bucket', () => {
    expect(USAGE_HEARTBEAT_MS).toBeLessThan(USAGE_BUCKET_MINUTES * 60_000);
  });

  test('posts { route } at once and on every tick while visible', async () => {
    const t = fakeTimers();
    const d = fakeDocument();
    const f = fakeFetch();
    let now = 0;
    startUsageHeartbeat({
      route: '/board',
      fetch: f.fetchImpl,
      document: d.doc,
      timers: t.timers,
      now: () => now,
    });
    expect(t.ms).toBe(USAGE_HEARTBEAT_MS);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(USAGE_URL);
    expect(f.calls[0]?.init?.method).toBe('POST');
    expect(f.calls[0]?.init?.body).toBe(JSON.stringify({ route: '/board' }));
    expect(new Headers(f.calls[0]?.init?.headers).get('content-type')).toBe('application/json');
    f.calls[0]?.resolve(200);
    await flush();
    now += USAGE_HEARTBEAT_MS;
    t.tick();
    expect(f.calls).toHaveLength(2);
  });

  test('never two at once: a tick while a beat is out is skipped', async () => {
    const t = fakeTimers();
    const f = fakeFetch();
    startUsageHeartbeat({
      route: '/m',
      fetch: f.fetchImpl,
      document: fakeDocument().doc,
      timers: t.timers,
    });
    t.tick();
    t.tick();
    expect(f.calls).toHaveLength(1);
    f.calls[0]?.resolve(503);
    await flush();
    t.tick();
    expect(f.calls).toHaveLength(2);
  });

  test('hidden: nothing; visible again: a beat at once when the last is old enough', async () => {
    const t = fakeTimers();
    const d = fakeDocument('hidden');
    const f = fakeFetch();
    let now = 1_000;
    startUsageHeartbeat({
      route: '/board',
      fetch: f.fetchImpl,
      document: d.doc,
      timers: t.timers,
      now: () => now,
    });
    expect(f.calls).toHaveLength(0);
    t.tick();
    expect(f.calls).toHaveLength(0);
    d.set('visible');
    expect(f.calls).toHaveLength(1);
    f.calls[0]?.resolve(200);
    await flush();
    // A quick flip away and back: no extra beat (the bucket already has one).
    now += 30_000;
    d.set('hidden');
    d.set('visible');
    expect(f.calls).toHaveLength(1);
    now += USAGE_HEARTBEAT_MS;
    d.set('hidden');
    d.set('visible');
    expect(f.calls).toHaveLength(2);
  });

  test('a failed post is dropped; the next tick tries again', async () => {
    const t = fakeTimers();
    let n = 0;
    const failing = (() => {
      n++;
      return Promise.reject(new TypeError('offline'));
    }) as unknown as typeof fetch;
    startUsageHeartbeat({
      route: '/board',
      fetch: failing,
      document: fakeDocument().doc,
      timers: t.timers,
    });
    await flush();
    t.tick();
    await flush();
    expect(n).toBe(2);
  });

  test('stop() and a 401 end it: interval cleared, listener removed, no more posts', async () => {
    const t = fakeTimers();
    const d = fakeDocument();
    const f = fakeFetch();
    const stop = startUsageHeartbeat({
      route: '/board',
      fetch: f.fetchImpl,
      document: d.doc,
      timers: t.timers,
    });
    f.calls[0]?.resolve(401);
    await flush();
    expect(t.cleared).toBe(true);
    expect(d.listeners.size).toBe(0);
    t.tick();
    d.set('visible');
    expect(f.calls).toHaveLength(1);
    stop();

    const t2 = fakeTimers();
    const d2 = fakeDocument();
    const f2 = fakeFetch();
    const stop2 = startUsageHeartbeat({
      route: '/m',
      fetch: f2.fetchImpl,
      document: d2.doc,
      timers: t2.timers,
    });
    stop2();
    expect(t2.cleared).toBe(true);
    expect(d2.listeners.size).toBe(0);
    f2.calls[0]?.resolve(200);
    await flush();
    t2.tick();
    expect(f2.calls).toHaveLength(1);
  });
});
