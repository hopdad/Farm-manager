import { describe, expect, test } from 'vitest';
import { parseNotifyPayload } from './hub';
import { MAX_TOPICS, parseTopics, SSE_HEADERS, SseParser, sseFrame } from './sse';

describe('sseFrame', () => {
  test('data-only frame', () => {
    expect(sseFrame({ data: '{"a":1}' })).toBe('data: {"a":1}\n\n');
  });

  test('named event, id, and multi-line data become several data lines', () => {
    expect(sseFrame({ event: 'ready', id: '7', data: 'a\nb\r\nc' })).toBe(
      'event: ready\nid: 7\ndata: a\ndata: b\ndata: c\n\n',
    );
  });

  test('rejects newlines in event names', () => {
    expect(() => sseFrame({ event: 'a\nb', data: '' })).toThrow(/newlines/);
  });
});

describe('SseParser', () => {
  test('round-trips frames split across arbitrary chunks, skipping comments and retry', () => {
    const text = [
      'retry: 3000\n\n',
      ': a comment\n\n',
      sseFrame({ event: 'ready', data: '{"topics":["fleet"]}' }),
      sseFrame({ data: 'line1\nline2' }),
      sseFrame({ event: 'ping', data: '123' }),
    ].join('');
    const p = new SseParser();
    const frames = [];
    for (let i = 0; i < text.length; i += 7) frames.push(...p.push(text.slice(i, i + 7)));
    expect(frames).toEqual([
      { event: 'ready', data: '{"topics":["fleet"]}', id: undefined },
      { event: undefined, data: 'line1\nline2', id: undefined },
      { event: 'ping', data: '123', id: undefined },
    ]);
  });

  test('handles CRLF line endings', () => {
    expect(new SseParser().push('event: x\r\ndata: y\r\n\r\n')).toEqual([
      { event: 'x', data: 'y', id: undefined },
    ]);
  });
});

describe('parseTopics', () => {
  test('sorted, unique, trimmed', () => {
    expect(parseTopics(' fleet,admin,fleet ')).toEqual({ ok: true, topics: ['admin', 'fleet'] });
  });

  test('per-entity topics are allowed', () => {
    expect(parseTopics('field:7c9e6679-7425-40de-944b-e07fc1f90ae7')).toMatchObject({ ok: true });
  });

  test.each([
    [null, /required/],
    ['', /required/],
    ['Fleet', /invalid/],
    ['fleet,../etc', /invalid/],
    ['a b', /invalid/],
  ])('rejects %j', (param, msg) => {
    const r = parseTopics(param);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });

  test(`at most ${MAX_TOPICS} topics`, () => {
    const many = Array.from({ length: MAX_TOPICS + 1 }, (_, i) => `t${i}`).join(',');
    expect(parseTopics(many).ok).toBe(false);
  });
});

describe('headers', () => {
  test('match the contract (no-transform also stops gzip buffering in next start)', () => {
    expect(SSE_HEADERS['Content-Type']).toMatch(/^text\/event-stream/);
    expect(SSE_HEADERS['Cache-Control']).toBe('no-cache, no-transform');
    expect(SSE_HEADERS['X-Accel-Buffering']).toBe('no');
  });
});

describe('parseNotifyPayload', () => {
  test("parses app.publish's NOTIFY text (with Postgres's spacing)", () => {
    const raw =
      '{"topic" : "fleet", "event" : "tick", "payload" : {"seq": 4, "ts": "x", "machines": []}}';
    expect(parseNotifyPayload(raw)).toEqual({ topic: 'fleet', event: 'tick', seq: 4, raw });
  });

  test.each([
    'not json',
    '[]',
    '{"topic":1,"event":"x","payload":{}}',
    '{"topic":"a","event":"b"}',
  ])('ignores %s', (raw) => {
    expect(parseNotifyPayload(raw)).toBeNull();
  });
});
