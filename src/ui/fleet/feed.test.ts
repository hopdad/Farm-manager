import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RealtimeClient, SubscribeOptions, TopicMessage } from '../../platform/realtime/types';
import type { FleetPanelData } from './contract';
import { startFleetPanelFeed } from './feed';
import type { PanelState } from './model';

const C1 = '00000000-0000-4000-8000-000000000001';

const snapshot = (status: 'active' | 'down' = 'active'): FleetPanelData => ({
  builtAt: '2026-11-30T15:00:00.000Z',
  machines: [
    {
      id: C1,
      unitNo: 'C1',
      kind: 'combine',
      make: null,
      model: null,
      status,
      downReason: status === 'down' ? 'Engine' : null,
      downAt: status === 'down' ? '2026-11-30T14:59:00.000Z' : null,
      downBy: null,
      position: null,
      place: null,
    },
  ],
  canMarkDown: false,
  modes: {
    deere: 'replay',
    samsara: 'replay',
    motive: 'off',
    geotab: 'off',
    aemp: 'off',
    cnh: 'off',
    terminal: 'off',
  },
  config: { appEnv: 'test', realtime: 'sse', staleAfterSeconds: 600, deereStaleAfterSeconds: 900 },
});

class FakeRealtime implements RealtimeClient {
  handlers: { onEvent: (e: TopicMessage<'fleet'>) => void; opts: SubscribeOptions }[] = [];
  connected = true;
  subscribe<T extends keyof import('../../platform/realtime/types').TopicEvents>(
    topic: T,
    onEvent: (evt: TopicMessage<T>) => void,
    opts: SubscribeOptions,
  ): () => void {
    expect(topic).toBe('fleet');
    const h = { onEvent: onEvent as (e: TopicMessage<'fleet'>) => void, opts };
    this.handlers.push(h);
    return () => {
      this.handlers = this.handlers.filter((x) => x !== h);
    };
  }
  emit(evt: TopicMessage<'fleet'>) {
    for (const h of this.handlers) h.onEvent(evt);
  }
}

function harness(responses: (() => Response)[]) {
  const states: PanelState[] = [];
  const rt = new FakeRealtime();
  let calls = 0;
  const fetch = vi.fn(async () => {
    const r = responses[Math.min(calls, responses.length - 1)] as () => Response;
    calls++;
    return r();
  });
  const feed = startFleetPanelFeed({
    onState: (s) => states.push(s),
    realtimeFor: () => ({ client: rt, connected: () => rt.connected }),
    fetch: fetch as unknown as typeof globalThis.fetch,
    pollMs: 1_000,
  });
  return { states, rt, fetch, feed, last: () => states.at(-1) as PanelState };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('startFleetPanelFeed', () => {
  test('loads the list, then subscribes with the server config and follows events', async () => {
    const h = harness([() => Response.json(snapshot())]);
    await vi.waitFor(() => expect(h.last()?.loaded).toBe(true));
    expect(h.fetch).toHaveBeenCalledWith(
      '/api/machines',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(h.rt.handlers).toHaveLength(1);
    h.rt.emit({
      event: 'machine',
      seq: 2,
      payload: { machineId: C1, status: 'down', downReason: 'Flat tire', downAt: null, by: 'Dana' },
    });
    expect(h.last().machines[0]).toMatchObject({ status: 'down', downReason: 'Flat tire' });
    h.feed.stop();
    expect(h.rt.handlers).toHaveLength(0);
  });

  test('onResync (reconnect, gap, invalidate) refetches', async () => {
    const h = harness([() => Response.json(snapshot()), () => Response.json(snapshot('down'))]);
    await vi.waitFor(() => expect(h.last()?.loaded).toBe(true));
    h.rt.handlers[0]?.opts.onResync();
    await vi.waitFor(() => expect(h.last().machines[0]?.status).toBe('down'));
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.feed.stop();
  });

  test('a malformed tick is ignored; a surprising one refetches', async () => {
    const h = harness([() => Response.json(snapshot()), () => Response.json(snapshot('down'))]);
    await vi.waitFor(() => expect(h.last()?.loaded).toBe(true));
    h.rt.emit({ event: 'tick', seq: 3, payload: { nope: true } as never });
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.rt.emit({
      event: 'tick',
      seq: 4,
      payload: {
        ts: '2026-11-30T15:00:05.000Z',
        machines: [
          {
            id: C1,
            unitNo: 'C1',
            kind: 'combine',
            lng: -83.9,
            lat: 41.9,
            heading: 0,
            speedMph: 0,
            activity: 'idle',
            fieldId: null,
            positionSource: 'deere_working',
            ts: '2026-11-30T15:00:00.000Z',
            status: 'down',
            stale: false,
          },
        ],
      },
    });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.last().machines[0]?.downReason).toBe('Engine'));
    h.feed.stop();
  });

  test('while ticks arrive, the list (geofence places) is refetched at most every 20 s', async () => {
    let wall = 0;
    const states: PanelState[] = [];
    const rt = new FakeRealtime();
    const fetch = vi.fn(async () => Response.json(snapshot()));
    const feed = startFleetPanelFeed({
      onState: (s) => states.push(s),
      realtimeFor: () => ({ client: rt, connected: () => true }),
      fetch: fetch as unknown as typeof globalThis.fetch,
      pollMs: 60_000,
      placeRefreshMs: 20_000,
      now: () => wall,
    });
    await vi.waitFor(() => expect(states.at(-1)?.loaded).toBe(true));
    const tick = (ts: string) => rt.emit({ event: 'tick', seq: 9, payload: { ts, machines: [] } });
    for (let i = 0; i < 4; i++) {
      wall += 5_000;
      tick('2026-11-30T15:00:05.000Z');
    }
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2); // the first load + one refresh at 20 s
    wall += 5_000;
    tick('2026-11-30T15:00:10.000Z');
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    feed.stop();
  });

  test('polls while realtime is down, not while it is up', async () => {
    vi.useFakeTimers();
    const h = harness([() => Response.json(snapshot())]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.rt.connected = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    h.feed.stop();
  });

  test('a refused or broken answer becomes a readable error', async () => {
    const h = harness([() => new Response('no', { status: 401 })]);
    await vi.waitFor(() => expect(h.last()?.error).toBe('Sign in to see the fleet'));
    h.feed.stop();
    const bad = harness([() => Response.json({ machines: 'x' })]);
    await vi.waitFor(() => expect(bad.last()?.error).toMatch(/unexpected response/));
    expect(bad.rt.handlers).toHaveLength(0); // no config yet: no subscription
    bad.feed.stop();
  });

  test('a machine event during an in-flight snapshot loads one more after it', async () => {
    let release: (r: Response) => void = () => {};
    const held = new Promise<Response>((r) => {
      release = r;
    });
    const h = harness([
      () => Response.json(snapshot()),
      // The 20 s place refresh, read before the mark-down committed: it still says active.
      () => held as unknown as Response,
      () => Response.json(snapshot('down')),
    ]);
    await vi.waitFor(() => expect(h.last()?.loaded).toBe(true));
    const pending = h.feed.refetch();
    await settle();
    h.rt.emit({
      event: 'machine',
      seq: 2,
      payload: { machineId: C1, status: 'down', downReason: 'Engine', downAt: null, by: 'Dana' },
    });
    expect(h.last().machines[0]?.status).toBe('down');
    release(Response.json(snapshot('active')));
    await pending;
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(h.last().machines[0]?.status).toBe('down');
    h.feed.stop();
  });

  test('an unreachable server keeps the list and says since when', async () => {
    let up = true;
    const fetch = vi.fn(async () => {
      if (!up) throw new TypeError('Failed to fetch');
      return Response.json(snapshot());
    });
    const states: PanelState[] = [];
    const feed = startFleetPanelFeed({
      onState: (s) => states.push(s),
      realtimeFor: () => ({ client: new FakeRealtime(), connected: () => false }),
      fetch: fetch as unknown as typeof globalThis.fetch,
      pollMs: 60_000,
      now: () => Date.parse('2026-11-30T20:29:00Z'),
    });
    await vi.waitFor(() => expect(states.at(-1)?.loaded).toBe(true));
    up = false;
    await feed.refetch();
    expect(states.at(-1)?.error).toBe(
      "Can't reach the farm PC since 3:29 PM: showing last known positions",
    );
    expect(states.at(-1)?.machines).toHaveLength(1);
    up = true;
    await feed.refetch();
    expect(states.at(-1)?.error).toBeNull();
    feed.stop();
  });

  test('nothing is reported after stop', async () => {
    const h = harness([() => Response.json(snapshot())]);
    h.feed.stop();
    await settle();
    await settle();
    expect(h.states).toEqual([]);
  });
});
