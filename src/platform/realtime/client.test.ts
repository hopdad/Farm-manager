/**
 * The browser realtime client against a scripted EventSource: one shared connection, topic
 * unions, onResync on (re)connect / seq gaps / invalidate / server resync, backoff reconnect,
 * the watchdog and idle close.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FleetTick } from '../../domain/fleet';
import { createSseRealtimeClient, type EventSourceLike, type SseRealtimeClient } from './client';
import type { TopicMessage } from './types';

class FakeEventSource implements EventSourceLike {
  static all: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  private listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  static last(): FakeEventSource {
    const es = FakeEventSource.all.at(-1);
    if (!es) throw new Error('no EventSource created');
    return es;
  }
  get topics(): string[] {
    return decodeURIComponent(new URL(this.url, 'http://x').searchParams.get('topics') ?? '').split(
      ',',
    );
  }
  addEventListener(type: string, l: (ev: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data?: unknown): void {
    if (this.closed) return;
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  ready(): void {
    this.readyState = 1;
    this.emit('ready', JSON.stringify({ topics: this.topics }));
  }
  message(topic: string, event: string, payload: Record<string, unknown>): void {
    this.emit('message', JSON.stringify({ topic, event, payload }));
  }
}

const tick = (seq: number, ts = `t${seq}`): Record<string, unknown> => ({ ts, machines: [], seq });
const flush = () => Promise.resolve();

let client: SseRealtimeClient;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.all = [];
  client = createSseRealtimeClient({
    createEventSource: (url) => new FakeEventSource(url),
    random: () => 1, // no jitter: delay = full backoff
    minBackoffMs: 1_000,
    maxBackoffMs: 8_000,
    watchdogMs: 45_000,
    idleCloseMs: 5_000,
    onError: () => {},
  });
});

afterEach(() => {
  client.close();
  vi.useRealTimers();
});

describe('one shared EventSource', () => {
  test('subscribers in the same tick share one connection with the union of topics', async () => {
    client.subscribe('fleet', () => {}, { onResync: () => {} });
    client.subscribe('admin', () => {}, { onResync: () => {} });
    client.subscribe('fleet', () => {}, { onResync: () => {} });
    await flush();
    expect(FakeEventSource.all).toHaveLength(1);
    expect(FakeEventSource.last().url).toBe('/api/realtime?topics=admin%2Cfleet');
    expect(client.topics).toEqual(['admin', 'fleet']);
  });

  test('a new topic later reconnects with the larger union; a known topic does not', async () => {
    client.subscribe('fleet', () => {}, { onResync: () => {} });
    await flush();
    FakeEventSource.last().ready();
    client.subscribe('fleet', () => {}, { onResync: () => {} });
    await flush();
    expect(FakeEventSource.all).toHaveLength(1);
    client.subscribe('admin', () => {}, { onResync: () => {} });
    await flush();
    expect(FakeEventSource.all).toHaveLength(2);
    expect(FakeEventSource.all[0]?.closed).toBe(true);
    expect(FakeEventSource.last().topics).toEqual(['admin', 'fleet']);
  });
});

describe('events', () => {
  test('delivers a typed message without seq in the payload; narrowing works', async () => {
    const got: TopicMessage<'fleet'>[] = [];
    client.subscribe('fleet', (evt) => got.push(evt), { onResync: () => {} });
    await flush();
    const es = FakeEventSource.last();
    es.ready();
    es.message('fleet', 'tick', tick(1));
    es.message('admin', 'clock', { paused: true, seq: 1 }); // other topic: not delivered
    expect(got).toHaveLength(1);
    const evt = got[0] as TopicMessage<'fleet'>;
    expect(evt.seq).toBe(1);
    if (evt.event === 'tick') {
      const payload: FleetTick = evt.payload;
      expect(payload).toEqual({ ts: 't1', machines: [] });
    } else {
      throw new Error('expected a tick');
    }
  });

  test('ignores malformed data', async () => {
    const onEvent = vi.fn();
    client.subscribe('fleet', onEvent, { onResync: () => {} });
    await flush();
    const es = FakeEventSource.last();
    es.ready();
    es.emit('message', 'not json');
    es.emit('message', JSON.stringify({ topic: 'fleet', event: 'tick', payload: [] }));
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('a subscriber that throws does not stop the others', async () => {
    const errors: unknown[] = [];
    client.close();
    client = createSseRealtimeClient({
      createEventSource: (url) => new FakeEventSource(url),
      onError: (e) => errors.push(e),
    });
    const second = vi.fn();
    client.subscribe(
      'fleet',
      () => {
        throw new Error('boom');
      },
      { onResync: () => {} },
    );
    client.subscribe('fleet', second, { onResync: () => {} });
    await flush();
    FakeEventSource.last().ready();
    FakeEventSource.last().message('fleet', 'tick', tick(1));
    expect(second).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });
});

describe('onResync', () => {
  test('fires after connect (ready), not before', async () => {
    const onResync = vi.fn();
    client.subscribe('fleet', () => {}, { onResync });
    await flush();
    expect(onResync).not.toHaveBeenCalled();
    FakeEventSource.last().ready();
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  test('fires for a subscriber joining a live connection', async () => {
    client.subscribe('fleet', () => {}, { onResync: () => {} });
    await flush();
    FakeEventSource.last().ready();
    const late = vi.fn();
    client.subscribe('fleet', () => {}, { onResync: late });
    await flush();
    expect(late).toHaveBeenCalledTimes(1);
  });

  test('fires on a seq gap and when seq goes backwards (database reset); duplicates are dropped', async () => {
    const onResync = vi.fn();
    const onEvent = vi.fn();
    client.subscribe('fleet', onEvent, { onResync });
    await flush();
    const es = FakeEventSource.last();
    es.ready();
    onResync.mockClear();
    es.message('fleet', 'tick', tick(5)); // first after ready: baseline
    es.message('fleet', 'tick', tick(6));
    expect(onResync).not.toHaveBeenCalled();
    es.message('fleet', 'tick', tick(6)); // duplicate
    expect(onEvent).toHaveBeenCalledTimes(2);
    es.message('fleet', 'tick', tick(9)); // gap
    expect(onResync).toHaveBeenCalledTimes(1);
    es.message('fleet', 'tick', tick(1)); // counter reset
    expect(onResync).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledTimes(4);
  });

  test('invalidate is delivered, then resyncs', async () => {
    const order: string[] = [];
    client.subscribe('fleet', (e) => order.push(`event:${e.event}`), {
      onResync: () => order.push('resync'),
    });
    await flush();
    const es = FakeEventSource.last();
    es.ready();
    order.length = 0;
    es.message('fleet', 'invalidate', { event: 'tick', reason: 'too_large', seq: 1 });
    expect(order).toEqual(['event:invalidate', 'resync']);
  });

  test("the server's resync event (its LISTEN reconnected) resyncs everyone and resets seq", async () => {
    const onResync = vi.fn();
    client.subscribe('fleet', () => {}, { onResync });
    await flush();
    const es = FakeEventSource.last();
    es.ready();
    es.message('fleet', 'tick', tick(3));
    onResync.mockClear();
    es.emit('resync', JSON.stringify({ reason: 'reconnected' }));
    expect(onResync).toHaveBeenCalledTimes(1);
    es.message('fleet', 'tick', tick(10)); // new baseline, no gap resync
    expect(onResync).toHaveBeenCalledTimes(1);
  });
});

describe('reconnect', () => {
  test('backs off exponentially after errors, resyncs after reconnecting, resets after ready', async () => {
    const onResync = vi.fn();
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));
    client.subscribe('fleet', () => {}, { onResync });
    await flush();
    FakeEventSource.last().ready();
    expect(client.state).toBe('ready');

    FakeEventSource.last().emit('error');
    expect(FakeEventSource.all[0]?.closed).toBe(true);
    expect(client.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeEventSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.all).toHaveLength(2);

    FakeEventSource.last().emit('error'); // fails again before ready: 2 s
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeEventSource.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.all).toHaveLength(3);

    FakeEventSource.last().emit('error'); // 4 s
    await vi.advanceTimersByTimeAsync(4_000);
    expect(FakeEventSource.all).toHaveLength(4);
    FakeEventSource.last().emit('error'); // 8 s (max)
    await vi.advanceTimersByTimeAsync(8_000);
    FakeEventSource.last().emit('error'); // still 8 s
    await vi.advanceTimersByTimeAsync(8_000);
    expect(FakeEventSource.all).toHaveLength(6);

    onResync.mockClear();
    FakeEventSource.last().ready();
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('ready');
    FakeEventSource.last().emit('error'); // backoff was reset by ready: 1 s again
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.all).toHaveLength(7);
    expect(states).toContain('reconnecting');
  });

  test('topics added during backoff are included in the retry', async () => {
    client.subscribe('fleet', () => {}, { onResync: () => {} });
    await flush();
    FakeEventSource.last().emit('error');
    client.subscribe('admin', () => {}, { onResync: () => {} });
    await flush();
    expect(FakeEventSource.all).toHaveLength(1); // waits for the backoff
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.last().topics).toEqual(['admin', 'fleet']);
  });

  test('the watchdog reconnects when nothing (not even a ping) arrives', async () => {
    client.subscribe('fleet', () => {}, { onResync: () => {} });
    await flush();
    FakeEventSource.last().ready();
    await vi.advanceTimersByTimeAsync(30_000);
    FakeEventSource.last().emit('ping', '1');
    await vi.advanceTimersByTimeAsync(44_000);
    expect(FakeEventSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.all[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.all).toHaveLength(2);
  });

  test('retryNow skips the remaining backoff', async () => {
    client.subscribe('fleet', () => {}, { onResync: () => {} });
    await flush();
    FakeEventSource.last().emit('error');
    client.retryNow();
    expect(FakeEventSource.all).toHaveLength(2);
  });

  test('events from a replaced connection are ignored', async () => {
    const onEvent = vi.fn();
    client.subscribe('fleet', onEvent, { onResync: () => {} });
    await flush();
    const first = FakeEventSource.last();
    first.emit('error');
    await vi.advanceTimersByTimeAsync(1_000);
    first.closed = false; // a late event from the old socket
    first.message('fleet', 'tick', tick(1));
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  test('closes a few seconds after the last unsubscribe; a quick resubscribe keeps it', async () => {
    const off = client.subscribe('fleet', () => {}, { onResync: () => {} });
    await flush();
    FakeEventSource.last().ready();
    off();
    off(); // idempotent
    await vi.advanceTimersByTimeAsync(3_000);
    client.subscribe('fleet', () => {}, { onResync: () => {} }); // StrictMode-style remount
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeEventSource.last().closed).toBe(false);
    expect(FakeEventSource.all).toHaveLength(1);
  });

  test('idle close', async () => {
    const off = client.subscribe('fleet', () => {}, { onResync: () => {} });
    await flush();
    off();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeEventSource.last().closed).toBe(true);
    expect(client.state).toBe('idle');
  });

  test('an unsubscribed listener gets nothing more', async () => {
    const onEvent = vi.fn();
    const off = client.subscribe('fleet', onEvent, { onResync: () => {} });
    client.subscribe('fleet', () => {}, { onResync: () => {} });
    await flush();
    FakeEventSource.last().ready();
    off();
    FakeEventSource.last().message('fleet', 'tick', tick(1));
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('close() is final', () => {
    client.close();
    expect(client.state).toBe('closed');
    expect(() => client.subscribe('fleet', () => {}, { onResync: () => {} })).toThrow(/closed/);
  });
});
