import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ResolvedMapLayer } from '../../../domain/map-layers';
import type {
  RealtimeClient,
  SubscribeOptions,
  TopicMessage,
} from '../../../platform/realtime/types';
import type { ResolvedRealtime } from '../fleet/realtime';
import { row } from '../layers/test-fixtures';
import { LAYERS_URL, parseLayersResponse, startLayersFeed } from './feed';

/** A realtime client the test drives: emit('layers', …), emitFields(…) and resync(). */
function fakeRealtime(connected = true) {
  const subs = new Map<string, { onEvent: (evt: unknown) => void; opts: SubscribeOptions }>();
  let unsubscribes = 0;
  const client: RealtimeClient = {
    subscribe: ((topic: string, onEvent: (evt: unknown) => void, o: SubscribeOptions) => {
      expect(['layers', 'fields']).toContain(topic);
      subs.set(topic, { onEvent, opts: o });
      return () => {
        unsubscribes += 1;
        subs.delete(topic);
      };
    }) as RealtimeClient['subscribe'],
  };
  const realtime: ResolvedRealtime = { client, connected: () => connected };
  return {
    realtime,
    emit: (evt: TopicMessage<'layers'>) => subs.get('layers')?.onEvent(evt),
    emitFields: (evt: TopicMessage<'fields'>) => subs.get('fields')?.onEvent(evt),
    resync: () => subs.get('layers')?.opts.onResync(),
    resyncFields: () => subs.get('fields')?.opts.onResync(),
    get unsubscribed() {
      return unsubscribes > 0 && subs.size === 0;
    },
  };
}

const ok = (layers: unknown[]) =>
  new Response(JSON.stringify({ layers }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

describe('parseLayersResponse', () => {
  test('keeps valid rows and drops malformed ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseLayersResponse({ layers: [row('soils'), { key: 'Bad!' }] });
    expect(r.layers.map((l) => l.key)).toEqual(['soils']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(() => parseLayersResponse({})).toThrow(/no layers/);
  });
});

describe('startLayersFeed', () => {
  test('loads at once, again on layers/updated and on resync, then unsubscribes', async () => {
    const rt = fakeRealtime();
    const fetch = vi.fn(async () => ok([row('soils')]));
    const got: ResolvedMapLayer[][] = [];
    const stop = startLayersFeed({
      realtime: rt.realtime,
      onLayers: (l) => got.push(l),
      onError: () => {},
      fetch,
    });
    await flush();
    expect(fetch).toHaveBeenCalledWith(LAYERS_URL, expect.objectContaining({ cache: 'no-store' }));
    expect(got).toHaveLength(1);
    rt.emit({ event: 'updated', payload: { key: 'soils', version: 'v2' }, seq: 2 });
    await flush();
    rt.resync();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(3);
    stop();
    expect(rt.unsubscribed).toBe(true);
  });

  test('field boundary or identity changes reload the list (the fields tile URL), debounced', async () => {
    const rt = fakeRealtime();
    const fetch = vi.fn(async () => ok([row('soils')]));
    const stop = startLayersFeed({
      realtime: rt.realtime,
      onLayers: () => {},
      onError: () => {},
      fetch,
    });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const updated = (parts: string[]) =>
      rt.emitFields({ event: 'updated', payload: { fieldId: 'f', parts } as never, seq: 1 });
    updated(['notes']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    // An import: a burst of boundary messages → one reload.
    for (let i = 0; i < 10; i++) updated(['identity', 'boundary']);
    await vi.advanceTimersByTimeAsync(400);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    // fields/invalidate (data:import) arrives as a resync.
    rt.resyncFields();
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(3);
    stop();
    expect(rt.unsubscribed).toBe(true);
  });

  test('overlapping refetches merge into one more', async () => {
    const rt = fakeRealtime();
    let release: (() => void) | null = null;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(ok([row('soils')]));
        }),
    );
    const stop = startLayersFeed({
      realtime: rt.realtime,
      onLayers: () => {},
      onError: () => {},
      fetch,
    });
    rt.resync();
    rt.resync();
    rt.resync();
    expect(fetch).toHaveBeenCalledTimes(1);
    (release as unknown as () => void)();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    (release as unknown as () => void)();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
  });

  test('a failure reports, keeps the last list, and retries', async () => {
    const rt = fakeRealtime();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValue(ok([row('soils')]));
    const errors: (string | null)[] = [];
    const got: ResolvedMapLayer[][] = [];
    const stop = startLayersFeed({
      realtime: rt.realtime,
      onLayers: (l) => got.push(l),
      onError: (e) => errors.push(e),
      fetch,
      retryMs: 1000,
    });
    await flush();
    expect(errors).toEqual(['GET /api/layers → HTTP 503']);
    expect(got).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(got).toHaveLength(1);
    expect(errors.at(-1)).toBeNull();
    stop();
  });

  test('polls only while realtime is not connected', async () => {
    const live = fakeRealtime(true);
    const f1 = vi.fn(async () => ok([]));
    const stop1 = startLayersFeed({
      realtime: live.realtime,
      onLayers: () => {},
      onError: () => {},
      fetch: f1,
      pollMs: 100,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(350);
    expect(f1).toHaveBeenCalledTimes(1);
    stop1();
    const down = fakeRealtime(false);
    const f2 = vi.fn(async () => ok([]));
    const stop2 = startLayersFeed({
      realtime: down.realtime,
      onLayers: () => {},
      onError: () => {},
      fetch: f2,
      pollMs: 100,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(350);
    expect(f2.mock.calls.length).toBeGreaterThanOrEqual(3);
    stop2();
  });
});
