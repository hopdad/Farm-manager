import { describe, expect, test } from 'vitest';
import { FIXTURE_FIELD_ID, makeFieldDetail } from './fixtures';
import { NotesDrafts, saveNotesRequest } from './notes-client';

const notes = makeFieldDetail().notes;

function respond(status: number, body: unknown) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe('saveNotesRequest', () => {
  test('PUTs JSON with the version and returns the saved notes', async () => {
    const { fetchImpl, seen } = respond(200, { notes });
    const r = await saveNotesRequest(fetchImpl, FIXTURE_FIELD_ID, 'hello', 'v1');
    expect(r).toEqual({ kind: 'saved', notes });
    expect(seen[0]?.url).toBe(`/api/fields/${FIXTURE_FIELD_ID}/notes`);
    expect(seen[0]?.init).toMatchObject({
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ text: 'hello', version: 'v1' });
  });

  test('409 is a conflict carrying the stored notes', async () => {
    const r = await saveNotesRequest(respond(409, { error: 'x', notes }).fetchImpl, 'f', 'a', 'v');
    expect(r).toEqual({ kind: 'conflict', notes });
  });

  test('401 / 403 are refusals with a reason a person understands', async () => {
    expect(await saveNotesRequest(respond(401, {}).fetchImpl, 'f', 'a', 'v')).toMatchObject({
      kind: 'denied',
      message: expect.stringMatching(/sign in/i),
    });
    expect(await saveNotesRequest(respond(403, {}).fetchImpl, 'f', 'a', 'v')).toMatchObject({
      kind: 'denied',
      message: expect.stringMatching(/managers and owners/),
    });
  });

  test('other failures say what the server said, or that it was unreachable', async () => {
    expect(
      await saveNotesRequest(respond(400, { error: 'notes are limited' }).fetchImpl, 'f', 'a', 'v'),
    ).toEqual({ kind: 'failed', message: 'Not saved: notes are limited.' });
    expect(await saveNotesRequest(respond(502, '<html>').fetchImpl, 'f', 'a', 'v')).toEqual({
      kind: 'failed',
      message: 'Not saved: the server answered 502.',
    });
    expect(await saveNotesRequest(respond(404, {}).fetchImpl, 'f', 'a', 'v')).toMatchObject({
      kind: 'failed',
      message: expect.stringMatching(/no longer exists/),
    });
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await saveNotesRequest(offline, 'f', 'a', 'v')).toMatchObject({
      kind: 'failed',
      message: expect.stringMatching(/connection/),
    });
  });
});

describe('NotesDrafts', () => {
  test('keeps one draft per field until cleared', () => {
    const d = new NotesDrafts();
    d.set('a', { text: 'x', baseVersion: 'v1' });
    d.set('b', { text: 'y', baseVersion: 'v1' });
    d.set('a', { text: 'x2', baseVersion: 'v1' });
    expect(d.get('a')).toEqual({ text: 'x2', baseVersion: 'v1' });
    d.clear('a');
    expect(d.get('a')).toBeUndefined();
    expect(d.get('b')?.text).toBe('y');
  });
});
