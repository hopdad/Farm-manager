import { describe, expect, test } from 'vitest';
import type { RealtimeClient, SubscribeOptions } from '../../../platform/realtime/types';
import type { BoardSnapshot, CrewPerson } from '../contract';
import type { BoardApi, ReadResult } from './api';
import { type FeedState, startBoardFeed } from './feed';

const snap = (n: number): BoardSnapshot => ({
  asOf: `2026-11-06T17:00:0${n}.000Z`,
  viewer: { role: 'viewer', partyId: null, canPlan: false },
  lanes: [],
});
const CREW: CrewPerson[] = [
  {
    partyId: '00000000-0000-4000-8000-000000000001',
    appUserId: null,
    name: 'Dale Mercer',
    initials: 'DM',
    appRole: 'operator',
    active: true,
  },
];

/** A read the test answers by hand (to hold one in flight). */
function deferred<T>() {
  let resolve!: (v: ReadResult<T>) => void;
  const promise = new Promise<ReadResult<T>>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness(opts: { connected?: boolean } = {}) {
  const snapshotCalls: ReturnType<typeof deferred<BoardSnapshot>>[] = [];
  const crewCalls: ReturnType<typeof deferred<CrewPerson[]>>[] = [];
  const api: Pick<BoardApi, 'snapshot' | 'crew'> = {
    snapshot: () => {
      const d = deferred<BoardSnapshot>();
      snapshotCalls.push(d);
      return d.promise;
    },
    crew: () => {
      const d = deferred<CrewPerson[]>();
      crewCalls.push(d);
      return d.promise;
    },
  };
  const subs: { topic: string; onEvent(e: unknown): void; opts?: SubscribeOptions }[] = [];
  let unsubscribed = 0;
  const client = {
    subscribe(topic: string, onEvent: (e: unknown) => void, o?: SubscribeOptions) {
      subs.push({ topic, onEvent, opts: o });
      return () => {
        unsubscribed += 1;
      };
    },
  } as unknown as RealtimeClient;
  let connected = opts.connected ?? true;
  let tick: (() => void) | null = null;
  let cleared = false;
  const states: FeedState[] = [];
  const feed = startBoardFeed({
    api,
    realtime: { client, connected: () => connected },
    onState: (s) => states.push(s),
    timers: {
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      },
    },
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    feed,
    subs,
    states,
    snapshotCalls,
    crewCalls,
    flush,
    tick: () => tick?.(),
    setConnected: (v: boolean) => {
      connected = v;
    },
    unsubscribed: () => unsubscribed,
    cleared: () => cleared,
  };
}

describe('the board feed', () => {
  test('loads the snapshot and the crew at once and subscribes to `jobs`', async () => {
    const h = harness();
    expect(h.states[0]).toMatchObject({ status: 'loading', snapshot: null, crew: null });
    expect(h.snapshotCalls).toHaveLength(1);
    expect(h.crewCalls).toHaveLength(1);
    expect(h.subs.map((s) => s.topic)).toEqual(['jobs']);
    h.snapshotCalls[0]?.resolve({ ok: true, value: snap(1) });
    h.crewCalls[0]?.resolve({ ok: true, value: CREW });
    await h.flush();
    expect(h.states.at(-1)).toMatchObject({ status: 'ready', snapshot: snap(1), crew: CREW });
  });

  test('`updated` and `invalidate` refetch the snapshot; never two at once, one queued', async () => {
    const h = harness();
    const sub = h.subs[0];
    h.snapshotCalls[0]?.resolve({ ok: true, value: snap(1) });
    await h.flush();
    sub?.onEvent({
      event: 'updated',
      payload: { jobIds: [], fieldIds: [], machineIds: [], partyIds: [] },
    });
    expect(h.snapshotCalls).toHaveLength(2);
    // Two more triggers while that one runs: exactly one more request afterwards.
    sub?.onEvent({ event: 'updated', payload: {} });
    sub?.onEvent({ event: 'invalidate', payload: { reason: 'too_large' } });
    expect(h.snapshotCalls).toHaveLength(2);
    h.snapshotCalls[1]?.resolve({ ok: true, value: snap(2) });
    await h.flush();
    expect(h.snapshotCalls).toHaveLength(3);
    h.snapshotCalls[2]?.resolve({ ok: true, value: snap(3) });
    await h.flush();
    expect(h.snapshotCalls).toHaveLength(3);
    expect(h.states.at(-1)?.snapshot).toEqual(snap(3));
    // Other events of the topic don't refetch.
    sub?.onEvent({ event: 'something', payload: {} });
    expect(h.snapshotCalls).toHaveLength(3);
  });

  test('onResync refetches the snapshot and the crew', async () => {
    const h = harness();
    h.snapshotCalls[0]?.resolve({ ok: true, value: snap(1) });
    h.crewCalls[0]?.resolve({ ok: true, value: CREW });
    await h.flush();
    h.subs[0]?.opts?.onResync();
    expect(h.snapshotCalls).toHaveLength(2);
    expect(h.crewCalls).toHaveLength(2);
  });

  test('an identical answer reports nothing new', async () => {
    const h = harness();
    h.snapshotCalls[0]?.resolve({ ok: true, value: snap(1) });
    await h.flush();
    const n = h.states.length;
    h.feed.refetch();
    h.snapshotCalls[1]?.resolve({ ok: true, value: snap(1) });
    await h.flush();
    expect(h.states).toHaveLength(n);
  });

  test('polls every interval only while realtime is down', async () => {
    const h = harness({ connected: true });
    h.snapshotCalls[0]?.resolve({ ok: true, value: snap(1) });
    h.crewCalls[0]?.resolve({ ok: true, value: CREW });
    await h.flush();
    h.tick();
    expect(h.snapshotCalls).toHaveLength(1);
    h.setConnected(false);
    h.tick();
    expect(h.snapshotCalls).toHaveLength(2);
    expect(h.crewCalls).toHaveLength(2);
  });

  test('failures: kept snapshot with an error; denied clears; not on this server yet', async () => {
    const h = harness();
    h.snapshotCalls[0]?.resolve({
      ok: false,
      kind: 'unavailable',
      status: 501,
      message: 'the server answered 501',
    });
    await h.flush();
    expect(h.states.at(-1)).toMatchObject({ status: 'unavailable', snapshot: null });
    h.feed.refetch();
    h.snapshotCalls[1]?.resolve({ ok: true, value: snap(1) });
    await h.flush();
    h.feed.refetch();
    h.snapshotCalls[2]?.resolve({
      ok: false,
      kind: 'error',
      status: 500,
      message: 'the server answered 500',
    });
    await h.flush();
    expect(h.states.at(-1)).toMatchObject({
      status: 'ready',
      snapshot: snap(1),
      error: 'the server answered 500',
    });
    h.feed.refetch();
    h.snapshotCalls[3]?.resolve({ ok: false, kind: 'denied', status: 403, message: 'not allowed' });
    await h.flush();
    expect(h.states.at(-1)).toMatchObject({ status: 'denied', snapshot: null });
    h.crewCalls[0]?.resolve({ ok: false, kind: 'error', status: null, message: 'no connection' });
    await h.flush();
    expect(h.states.at(-1)?.crewError).toBe('no connection');
  });

  test('stop: unsubscribes, stops polling, drops late answers', async () => {
    const h = harness();
    const n = h.states.length;
    h.feed.stop();
    h.feed.stop();
    expect(h.unsubscribed()).toBe(1);
    expect(h.cleared()).toBe(true);
    h.snapshotCalls[0]?.resolve({ ok: true, value: snap(1) });
    await h.flush();
    expect(h.states).toHaveLength(n);
    h.feed.refetch();
    expect(h.snapshotCalls).toHaveLength(1);
  });
});
