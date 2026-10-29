/**
 * The Motive placeholder's cursor: a watermark per vehicle, so a truck whose ELD reports a little
 * later than another's is not dropped (review repro: A at 12:00:05, B at 12:00:03, then B 12:00:04).
 */
import { describe, expect, test } from 'vitest';
import { MotiveClient, parseMotiveCursor } from './client';

function fakeMotive(pages: Record<string, string>[]) {
  let call = 0;
  const fetch = (async () => {
    const located = pages[Math.min(call++, pages.length - 1)] as Record<string, string>;
    const vehicles = Object.entries(located).map(([id, at]) => ({
      vehicle: {
        id,
        number: `T${id}`,
        current_location: { lat: 41.9, lon: -84, bearing: 90, kph: 80, located_at: at },
      },
    }));
    return Response.json({
      vehicles,
      pagination: { per_page: 100, page_no: 1, total: vehicles.length },
    });
  }) as typeof globalThis.fetch;
  return new MotiveClient({ baseUrl: 'http://127.0.0.1:1/motive', apiKey: 'k' }, { fetch });
}

const ids = (r: { items: { externalId: string }[] }) => r.items.map((i) => i.externalId);

describe('MotiveClient.pollPositions', () => {
  test('each vehicle has its own watermark', async () => {
    const c = fakeMotive([
      { A: '2026-10-29T12:00:05Z', B: '2026-10-29T12:00:03Z' },
      { A: '2026-10-29T12:00:05Z', B: '2026-10-29T12:00:04Z' },
      { A: '2026-10-29T12:00:05Z', B: '2026-10-29T12:00:04Z' },
    ]);
    const first = await c.pollPositions(null);
    expect(ids(first)).toEqual(['A:2026-10-29T12:00:05.000Z', 'B:2026-10-29T12:00:03.000Z']);
    const second = await c.pollPositions(first.cursor);
    expect(ids(second)).toEqual(['B:2026-10-29T12:00:04.000Z']); // A unchanged, B newer
    const third = await c.pollPositions(second.cursor);
    expect(ids(third)).toEqual([]);
    expect(parseMotiveCursor(third.cursor)).toEqual({
      A: '2026-10-29T12:00:05.000Z',
      B: '2026-10-29T12:00:04.000Z',
    });
  });

  test('an empty, legacy (single ISO) or broken cursor starts fresh', () => {
    expect(parseMotiveCursor(null)).toEqual({});
    expect(parseMotiveCursor('')).toEqual({});
    expect(parseMotiveCursor('2026-10-29T12:00:05.000Z')).toEqual({});
    expect(parseMotiveCursor('{oops')).toEqual({});
    expect(parseMotiveCursor('{"A":"not a time","B":"2026-10-29T12:00:04Z"}')).toEqual({
      B: '2026-10-29T12:00:04Z',
    });
  });
});
