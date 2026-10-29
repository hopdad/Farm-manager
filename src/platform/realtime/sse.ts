/**
 * Server-sent events for the local realtime adapter (server only): the wire format shared with
 * the browser client (./client.ts) and the `/api/realtime` handler.
 *
 *   GET /api/realtime?topics=fleet,admin
 *   200 text/event-stream; Cache-Control: no-cache, no-transform; X-Accel-Buffering: no
 *
 *   retry: 3000                            reconnect hint (the client does its own backoff)
 *   event: ready    data: {"topics":[…]}   the subscription is live: refetch snapshots now
 *   data: {"topic":"fleet","event":"tick","payload":{…,"seq":7}}   one per notification
 *   event: resync   data: {"reason":"reconnected"}   messages may have been missed: refetch
 *   event: ping     data: <epoch ms>       every 15 s (heartbeat; the client's watchdog)
 *
 * `ready` is sent only after the hub's LISTEN is active and this subscriber is registered, so
 * a snapshot fetched after `ready` can't miss a message published in between.
 * `no-transform` also stops Next's gzip middleware from buffering the stream (`next start`).
 */
import type { HubMessage, RealtimeHub } from './hub';

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};

export const HEARTBEAT_MS = 15_000;
export const MAX_TOPICS = 32;
/** Lower-case words with optional dots/dashes/underscores; per-entity topics `name:<id>`. */
const TOPIC_RE = /^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*(?::[A-Za-z0-9_-]{1,64})?$/;

export interface SseFrame {
  event?: string;
  data: string;
  id?: string;
}

/** One SSE frame. Multi-line data becomes several `data:` lines (the client joins them). */
export function sseFrame(frame: SseFrame): string {
  let out = '';
  if (frame.event) {
    if (/[\r\n]/.test(frame.event)) throw new Error('SSE event names cannot contain newlines');
    out += `event: ${frame.event}\n`;
  }
  if (frame.id !== undefined) out += `id: ${frame.id.replace(/[\r\n]/g, '')}\n`;
  for (const line of frame.data.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** Incremental SSE parser (tests and non-browser clients). Feed text, get complete frames. */
export class SseParser {
  private buf = '';
  push(text: string): SseFrame[] {
    this.buf += text;
    const frames: SseFrame[] = [];
    for (;;) {
      const m = /\r\n\r\n|\n\n|\r\r/.exec(this.buf);
      if (!m) break;
      const block = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      let event: string | undefined;
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r\n|\r|\n/)) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') id = value;
      }
      if (data.length || event) frames.push({ event, data: data.join('\n'), id });
    }
    return frames;
  }
}

export type TopicsResult = { ok: true; topics: string[] } | { ok: false; error: string };

/** `?topics=fleet,admin` -> sorted unique topic list. */
export function parseTopics(param: string | null): TopicsResult {
  const topics = [
    ...new Set(
      (param ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].sort();
  if (!topics.length) return { ok: false, error: 'topics query parameter is required' };
  if (topics.length > MAX_TOPICS) return { ok: false, error: `at most ${MAX_TOPICS} topics` };
  const bad = topics.filter((t) => t.length > 100 || !TOPIC_RE.test(t));
  if (bad.length) return { ok: false, error: `invalid topic name(s): ${bad.join(', ')}` };
  return { ok: true, topics };
}

export interface RealtimeRequestOptions {
  hub: RealtimeHub;
  /** Default 15 s. */
  heartbeatMs?: number;
  /** How long to wait for the LISTEN connection before answering 503. */
  readyTimeoutMs?: number;
  /** Reconnect hint sent to EventSource (`retry:`). */
  retryMs?: number;
  /** Close a stream whose client has stopped reading after this much is queued. */
  maxBufferedBytes?: number;
}

const noStore = { 'Cache-Control': 'no-store' };

/** The `/api/realtime` handler. The route file wires it to the global hub. */
export async function handleRealtimeRequest(
  req: Request,
  opts: RealtimeRequestOptions,
): Promise<Response> {
  const parsed = parseTopics(new URL(req.url).searchParams.get('topics'));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: noStore });
  const { hub } = opts;
  try {
    await hub.ready(opts.readyTimeoutMs ?? 5_000);
  } catch (e) {
    return Response.json(
      { error: 'realtime unavailable', detail: (e as Error).message },
      { status: 503, headers: { ...noStore, 'Retry-After': '3' } },
    );
  }
  if (req.signal.aborted) return new Response(null, { status: 499, headers: noStore });

  const topics = parsed.topics;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const maxBuffered = opts.maxBufferedBytes ?? 1_048_576;
  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    req.signal.removeEventListener('abort', cleanup);
    try {
      controllerRef?.close();
    } catch {
      // already closed or errored by the consumer
    }
  };

  const write = (text: string) => {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(text));
    } catch {
      cleanup();
      return;
    }
    // A client that stopped reading (asleep phone, dead socket) must not grow memory forever:
    // drop it; its EventSource reconnects and resyncs.
    if ((controllerRef.desiredSize ?? 0) < -maxBuffered) cleanup();
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controllerRef = controller;
        write(`retry: ${opts.retryMs ?? 3_000}\n\n`);
        unsubscribe = hub.subscribe({
          topics,
          onMessage: (m: HubMessage) => write(sseFrame({ data: m.raw })),
          onResync: (reason) =>
            write(sseFrame({ event: 'resync', data: JSON.stringify({ reason }) })),
        });
        write(sseFrame({ event: 'ready', data: JSON.stringify({ topics }) }));
        heartbeat = setInterval(
          () => write(sseFrame({ event: 'ping', data: String(Date.now()) })),
          heartbeatMs,
        );
        req.signal.addEventListener('abort', cleanup, { once: true });
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
  );

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
