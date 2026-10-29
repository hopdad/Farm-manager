import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FleetTick, MachineView } from '../../../domain/fleet';
import { createSseRealtimeClient, type EventSourceLike } from '../../../platform/realtime/client';
import type { RealtimeClient, SubscribeOptions } from '../../../platform/realtime/types';
import {
  FIRST_SNAPSHOT_GRACE_MS,
  type FleetFeedPatch,
  STALE_CHECK_MS,
  startFleetFeed,
} from './feed';
import { FleetModel } from './model';
import type { ResolvedRealtime } from './realtime';

const T0 = Date.parse('2026-10-29T14:00:00Z');

function machine(over: Partial<MachineView> = {}): MachineView {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    unitNo: 'S1',
    kind: 'semi',
    lng: -84.0,
    lat: 41.9,
    heading: 90,
    speedMph: 45,
    activity: 'transport',
    fieldId: null,
    positionSource: 'eld',
    ts: new Date(T0).toISOString(),
    status: 'active',
    stale: false,
    ...over,
  };
}

/** A fetch that answers GET /api/fleet with `body()` and counts calls. */
function fleetEndpoint(body: () => FleetTick) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return Response.json(body());
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

/** A realtime client that never connects (what /api/realtime answering 404 looks like). */
const deadRealtime = (): ResolvedRealtime => {
  const client = createSseRealtimeClient({
    createEventSource: () => {
      const listeners = new Map<string, (ev: { data?: unknown }) => void>();
      const es: EventSourceLike = {
        readyState: 0,
        addEventListener: (type, l) => {
          listeners.set(type, l);
          if (type === 'error') queueMicrotask(() => l({}));
        },
        close: () => {},
      };
      return es;
    },
    random: () => 0,
  });
  return { client, connected: () => client.state === 'ready' };
};

/** A connected client that resyncs on subscribe and lets the test emit ticks. */
function liveRealtime() {
  const subs: { onEvent(evt: unknown): void; opts: SubscribeOptions }[] = [];
  const client: RealtimeClient = {
    subscribe(_topic, onEvent, opts) {
      const sub = { onEvent: onEvent as (evt: unknown) => void, opts };
      subs.push(sub);
      queueMicrotask(() => opts.onResync());
      return () => {
        subs.splice(subs.indexOf(sub), 1);
      };
    },
  };
  return {
    rt: { client, connected: () => true } satisfies ResolvedRealtime,
    tick: (machines: MachineView[]) => {
      for (const s of subs) {
        s.onEvent({ event: 'tick', seq: 2, payload: { ts: new Date().toISOString(), machines } });
      }
    },
    subscribers: () => subs.length,
  };
}

const model = () => new FleetModel({ staleAfterSeconds: 60, wallNow: () => new Date(T0 + 1000) });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startFleetFeed', () => {
  test('realtime that never connects: the snapshot still loads, then polls', async () => {
    const m = model();
    const api = fleetEndpoint(() => ({ ts: new Date(T0).toISOString(), machines: [machine()] }));
    const patches: FleetFeedPatch[] = [];
    const stop = startFleetFeed({
      model: m,
      realtime: deadRealtime(),
      fetch: api.fetch,
      onChange: (p) => patches.push(p),
    });
    await vi.advanceTimersByTimeAsync(FIRST_SNAPSHOT_GRACE_MS - 1);
    expect(api.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.calls).toEqual(['/api/fleet']);
    expect(m.size).toBe(1);
    expect(patches.at(-1)).toMatchObject({ connection: 'live', error: null });
    await vi.advanceTimersByTimeAsync(STALE_CHECK_MS * 3);
    expect(api.calls.length).toBe(4); // first load + one poll per period
    stop();
    await vi.advanceTimersByTimeAsync(STALE_CHECK_MS * 3);
    expect(api.calls.length).toBe(4);
  });

  test('connected realtime: one snapshot on resync, no polling, ticks apply', async () => {
    const m = model();
    const api = fleetEndpoint(() => ({ ts: new Date(T0).toISOString(), machines: [machine()] }));
    const live = liveRealtime();
    const stop = startFleetFeed({
      model: m,
      realtime: live.rt,
      fetch: api.fetch,
      onChange: () => {},
      animationNow: () => 0,
    });
    await vi.advanceTimersByTimeAsync(STALE_CHECK_MS * 4);
    expect(api.calls).toEqual(['/api/fleet']);
    live.tick([machine({ lng: -83.99, ts: new Date(T0 + 5000).toISOString() })]);
    expect(m.frame(Number.POSITIVE_INFINITY)[0]?.lng).toBe(-83.99);
    stop();
    expect(live.subscribers()).toBe(0);
  });

  test('the server gone while realtime is down: unavailable since the first failure, markers kept', async () => {
    const m = model();
    let up = true;
    const patches: FleetFeedPatch[] = [];
    let wall = 1_000_000;
    const stop = startFleetFeed({
      model: m,
      realtime: deadRealtime(),
      fetch: (async () => {
        if (!up) throw new TypeError('Failed to fetch');
        return Response.json({ ts: new Date(T0).toISOString(), machines: [machine()] });
      }) as typeof globalThis.fetch,
      onChange: (p) => patches.push(p),
      wallNow: () => wall,
    });
    await vi.advanceTimersByTimeAsync(FIRST_SNAPSHOT_GRACE_MS);
    expect(patches.at(-1)).toMatchObject({ connection: 'live', offlineSince: null });
    up = false;
    const firstFailure = wall + STALE_CHECK_MS;
    for (let i = 0; i < 3; i++) {
      wall += STALE_CHECK_MS;
      await vi.advanceTimersByTimeAsync(STALE_CHECK_MS);
    }
    expect(patches.at(-1)).toMatchObject({
      connection: 'unavailable',
      offlineSince: firstFailure,
      error: 'Failed to fetch',
    });
    expect(m.size).toBe(1);
    up = true;
    wall += STALE_CHECK_MS;
    await vi.advanceTimersByTimeAsync(STALE_CHECK_MS);
    expect(patches.at(-1)).toMatchObject({ connection: 'live', offlineSince: null, error: null });
    stop();
  });

  test('a failing snapshot reports unavailable while nothing is on the map', async () => {
    const m = model();
    const patches: FleetFeedPatch[] = [];
    const stop = startFleetFeed({
      model: m,
      realtime: liveRealtime().rt,
      fetch: (async () => new Response('down', { status: 503 })) as typeof globalThis.fetch,
      onChange: (p) => patches.push(p),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(patches.at(-1)).toMatchObject({ connection: 'unavailable' });
    expect(patches.at(-1)?.error).toContain('HTTP 503');
    stop();
  });
});
