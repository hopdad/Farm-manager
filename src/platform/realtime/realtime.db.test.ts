/**
 * The local realtime path end to end on a real database:
 *   publish() -> app.publish -> pg_notify -> RealtimeHub (LISTEN) -> /api/realtime SSE -> client
 * - the SSE stream delivers a publish within 1 s, only for subscribed topics, with heartbeats;
 * - closing the request unsubscribes; a hub that can't LISTEN answers 503;
 * - when the LISTEN connection is killed the hub reconnects and streams `resync`;
 * - the browser client (over HTTP, with a fetch-based EventSource) receives a publish within
 *   1 s and calls onResync after the server's LISTEN reconnect and after its own reconnect.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { setupTestDb } from '../../test/db';
import { createSseRealtimeClient, type EventSourceLike } from './client';
import { RealtimeHub } from './hub';
import { publish } from './publish';
import { handleRealtimeRequest, type SseFrame, SseParser } from './sse';
import type { NotifyMessage } from './types';

const t = setupTestDb(import.meta.url);
const APP_NAME = 'farm-realtime-test';
let hub: RealtimeHub;

beforeAll(() => {
  hub = new RealtimeHub({
    connectionString: t().appUrl,
    applicationName: APP_NAME,
    minBackoffMs: 50,
    maxBackoffMs: 200,
    pingIntervalMs: 0,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
});
afterAll(async () => {
  await hub?.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  fn: () => T | undefined | null | false,
  ms: number,
  what: string,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(10);
  }
}

/** Collects the frames of an SSE response as they arrive. */
function collect(res: Response): { frames: SseFrame[]; done: Promise<void> } {
  const frames: SseFrame[] = [];
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const done = (async () => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) return;
        frames.push(...parser.push(decoder.decode(value, { stream: true })));
      }
    } catch {
      // aborted
    }
  })();
  return { frames, done };
}

const data = (f: SseFrame) => JSON.parse(f.data) as NotifyMessage;

/** Kill the hub's LISTEN backend from the server side, like a database restart would. */
async function terminateListen(): Promise<number> {
  const r = await t().admin.query(
    `select pg_terminate_backend(pid) as ok from pg_stat_activity
      where application_name = $1 and datname = current_database()`,
    [APP_NAME],
  );
  return r.rowCount ?? 0;
}

describe('SSE handler over the hub', () => {
  test('streams ready, then a publish within 1 s, only for subscribed topics, with heartbeats', async () => {
    const ac = new AbortController();
    const res = await handleRealtimeRequest(
      new Request('http://x/api/realtime?topics=fleet', { signal: ac.signal }),
      { hub, heartbeatMs: 100 },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const { frames, done } = collect(res);
    const ready = await waitFor(() => frames.find((f) => f.event === 'ready'), 2_000, 'ready');
    expect(JSON.parse(ready.data)).toEqual({ topics: ['fleet'] });

    await publish('admin', 'clock', { paused: true }, t().pool); // not subscribed
    const sent = Date.now();
    await publish('fleet', 'tick', { ts: 'sse-1', machines: [] }, t().pool);
    const msg = await waitFor(() => frames.find((f) => !f.event), 1_000, 'the fleet tick');
    expect(Date.now() - sent).toBeLessThan(1_000);
    expect(data(msg)).toMatchObject({
      topic: 'fleet',
      event: 'tick',
      payload: { ts: 'sse-1', seq: 1 },
    });
    await waitFor(() => frames.filter((f) => f.event === 'ping').length >= 2, 2_000, 'heartbeats');
    expect(frames.filter((f) => !f.event).map((f) => data(f).topic)).toEqual(['fleet']);

    ac.abort();
    await done;
    await waitFor(() => hub.stats().subscribers === 0, 1_000, 'unsubscribe on abort');
  });

  test('rejects bad topics with 400 and answers 503 when it cannot LISTEN', async () => {
    const bad = await handleRealtimeRequest(new Request('http://x/api/realtime?topics=NO'), {
      hub,
    });
    expect(bad.status).toBe(400);
    const dead = new RealtimeHub({
      connectionString: t().appUrl.replace(/:\/\/([^:]+):[^@]+@/, '://$1:wrong-password@'),
      minBackoffMs: 1_000,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      const res = await handleRealtimeRequest(new Request('http://x/api/realtime?topics=fleet'), {
        hub: dead,
        readyTimeoutMs: 1_500,
      });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('3');
    } finally {
      await dead.close();
    }
  });

  test('a killed LISTEN connection reconnects and streams resync; later publishes still arrive', async () => {
    const ac = new AbortController();
    const res = await handleRealtimeRequest(
      new Request('http://x/api/realtime?topics=admin,fleet', { signal: ac.signal }),
      { hub, heartbeatMs: 60_000 },
    );
    const { frames, done } = collect(res);
    await waitFor(() => frames.find((f) => f.event === 'ready'), 2_000, 'ready');
    const connects = hub.stats().connects;
    expect(await terminateListen()).toBe(1);
    const resync = await waitFor(() => frames.find((f) => f.event === 'resync'), 3_000, 'resync');
    expect(JSON.parse(resync.data)).toEqual({ reason: 'reconnected' });
    expect(hub.stats().connects).toBe(connects + 1);
    expect(hub.state).toBe('listening');

    await publish('admin', 'clock', { paused: false }, t().pool);
    const msg = await waitFor(
      () =>
        frames.find(
          (f) => !f.event && data(f).topic === 'admin' && data(f).payload.paused === false,
        ),
      1_000,
      'admin/clock after the reconnect',
    );
    expect(data(msg).event).toBe('clock');
    ac.abort();
    await done;
  });
});

// ---------------------------------------------------------------------------------------------
// The browser client over real HTTP
// ---------------------------------------------------------------------------------------------

/** Minimal EventSource on fetch (Node's is behind a flag): enough for the client under test. */
class FetchEventSource implements EventSourceLike {
  readyState = 0;
  private readonly ac = new AbortController();
  private readonly listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  constructor(url: string) {
    void this.run(url);
  }
  addEventListener(type: string, l: (ev: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close(): void {
    this.readyState = 2;
    this.ac.abort();
  }
  private emit(type: string, data?: string): void {
    if (this.readyState === 2) return;
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  private async run(url: string): Promise<void> {
    try {
      const res = await fetch(url, { signal: this.ac.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      this.readyState = 1;
      const parser = new SseParser();
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        for (const f of parser.push(decoder.decode(chunk, { stream: true }))) {
          this.emit(f.event ?? 'message', f.data);
        }
      }
      throw new Error('stream ended');
    } catch {
      if (!this.ac.signal.aborted) this.emit('error');
      this.readyState = 2;
    }
  }
}

/** The route handler behind a real HTTP server (Request in, streamed Response out). */
async function serve(handler: (req: Request) => Promise<Response>) {
  const server = http.createServer(async (req, res) => {
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const response = await handler(
      new Request(`http://127.0.0.1${req.url ?? '/'}`, { method: req.method, signal: ac.signal }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) {
      res.end();
      return;
    }
    try {
      for await (const chunk of response.body) res.write(chunk);
    } catch {
      // client went away
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/realtime`,
    dropConnections: () => server.closeAllConnections(),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

describe('browser client against the SSE route', () => {
  test('receives a publish within 1 s and resyncs after server and client reconnects', async () => {
    const srv = await serve((req) => handleRealtimeRequest(req, { hub, heartbeatMs: 1_000 }));
    const client = createSseRealtimeClient({
      url: srv.url,
      createEventSource: (url) => new FetchEventSource(url),
      minBackoffMs: 50,
      maxBackoffMs: 200,
    });
    const ticks: string[] = [];
    let resyncs = 0;
    try {
      client.subscribe(
        'fleet',
        (evt) => {
          if (evt.event === 'tick') ticks.push(evt.payload.ts);
        },
        { onResync: () => resyncs++ },
      );
      await waitFor(() => client.state === 'ready' && resyncs === 1, 3_000, 'first ready');

      const sent = Date.now();
      await publish('fleet', 'tick', { ts: 'client-1', machines: [] }, t().pool);
      await waitFor(() => ticks.includes('client-1'), 1_000, 'client-1');
      expect(Date.now() - sent).toBeLessThan(1_000);

      // The database side drops: the hub reconnects and tells the client to resync.
      await terminateListen();
      await waitFor(() => resyncs === 2, 3_000, 'resync after the LISTEN reconnect');

      // The HTTP side drops: the client reconnects with backoff, then resyncs.
      srv.dropConnections();
      await waitFor(
        () => resyncs === 3 && client.state === 'ready',
        3_000,
        'resync after reconnect',
      );
      await publish('fleet', 'tick', { ts: 'client-2', machines: [] }, t().pool);
      await waitFor(() => ticks.includes('client-2'), 1_000, 'client-2');
    } finally {
      client.close();
      await srv.close();
    }
  });
});
