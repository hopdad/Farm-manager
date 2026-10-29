/**
 * The field routes against a real database, under chosen sessions (runWithSession): who may
 * read, who may save notes, and every refusal (401, 403, 404, 409, 413, 415, 400).
 */
import { describe, expect, test } from 'vitest';
import type { Queryable } from '@/db/client';
import type { FieldDetail } from '@/domain/fields';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import { ROLES, type Role } from '@/platform/auth/types';
import { setupTestDb } from '@/test/db';
import { ADRIAN_QUARTER_SECTION, insertField } from '@/test/fixtures';
import { FIELD_ROLE_HEADER } from '@/ui/fields/protocol';
import { handleFieldDetail, handleSaveNotes, isSameOriginRequest } from './handler';

const t = setupTestDb(import.meta.url);

const as = <T>(role: Role | null, fn: () => Promise<T>) =>
  runWithSession(role === null ? null : makeSession({ role }), fn);

function put(fieldId: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000/api/fields/${fieldId}/notes`, {
    method: 'PUT',
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function seeded() {
  const { fieldId } = await insertField(t().db, {
    name: `Route ${Math.random().toString(16).slice(2, 8)}`,
    geom: ADRIAN_QUARTER_SECTION,
    tenure: 'owned',
  });
  const res = await as('viewer', () => handleFieldDetail(fieldId, t().pool));
  const detail = (await res.json()) as FieldDetail;
  return { fieldId, version: detail.notes.version };
}

describe('GET /api/fields/<id>', () => {
  test('every role may read; the response is private and names the role', async () => {
    const { fieldId } = await seeded();
    for (const role of ROLES) {
      const res = await as(role, () => handleFieldDetail(fieldId, t().pool));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get(FIELD_ROLE_HEADER)).toBe(role);
      const body = (await res.json()) as FieldDetail;
      expect(body.field.id).toBe(fieldId);
      expect(body.field.acres).toBeCloseTo(160, 0);
      expect(body.openJobs).toEqual({ count: 0, placeholder: true });
    }
  });

  test('signed out → 401, no-store', async () => {
    const { fieldId } = await seeded();
    const res = await as(null, () => handleFieldDetail(fieldId, t().pool));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ status: 401 });
  });

  test('unknown or malformed ids → 404', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'nope', '../etc']) {
      const res = await as('viewer', () => handleFieldDetail(id, t().pool));
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('a database failure → 503, not a crash', async () => {
    const broken: Queryable = {
      query: (() => Promise.reject(new Error('connection refused'))) as Queryable['query'],
    };
    const res = await as('viewer', () =>
      handleFieldDetail('00000000-0000-4000-8000-000000000000', broken),
    );
    expect(res.status).toBe(503);
  });
});

describe('PUT /api/fields/<id>/notes', () => {
  test('a manager saves; the version moves; the next GET shows it', async () => {
    const { fieldId, version } = await seeded();
    const res = await as('manager', () =>
      handleSaveNotes(put(fieldId, { text: '  Gate code 1234\r\n', version }), fieldId, t().db),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { notes } = (await res.json()) as { notes: FieldDetail['notes'] };
    expect(notes.text).toBe('Gate code 1234');
    expect(notes.version).not.toBe(version);

    const again = await as('viewer', () => handleFieldDetail(fieldId, t().pool));
    expect(((await again.json()) as FieldDetail).notes).toEqual(notes);
  });

  test('viewer, driver and operator get 403; signed out gets 401; nothing is written', async () => {
    const { fieldId, version } = await seeded();
    for (const role of ['viewer', 'driver', 'operator'] as const) {
      const res = await as(role, () =>
        handleSaveNotes(put(fieldId, { text: role, version }), fieldId, t().db),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ status: 403, required: 'manager' });
    }
    const anon = await as(null, () =>
      handleSaveNotes(put(fieldId, { text: 'anon', version }), fieldId, t().db),
    );
    expect(anon.status).toBe(401);
    const r = await t().pool.query('select notes from farm.fields where id = $1', [fieldId]);
    expect(r.rows[0]?.notes).toBeNull();
  });

  test('the owner may save too', async () => {
    const { fieldId, version } = await seeded();
    const res = await as('owner', () =>
      handleSaveNotes(put(fieldId, { text: 'owner note', version }), fieldId, t().db),
    );
    expect(res.status).toBe(200);
  });

  test('a stale version → 409 with the stored notes', async () => {
    const { fieldId, version } = await seeded();
    const first = await as('manager', () =>
      handleSaveNotes(put(fieldId, { text: 'first', version }), fieldId, t().db),
    );
    expect(first.status).toBe(200);
    const second = await as('manager', () =>
      handleSaveNotes(put(fieldId, { text: 'second', version }), fieldId, t().db),
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ notes: { text: 'first' } });
  });

  test('bad requests: cross-site, wrong type, too large, not JSON, bad body, unknown field', async () => {
    const { fieldId, version } = await seeded();
    const cases: [Request, number, string][] = [
      [put(fieldId, { text: 'x', version }, { origin: 'http://evil.example' }), 403, fieldId],
      [put(fieldId, { text: 'x', version }, { 'content-type': 'text/plain' }), 415, fieldId],
      [put(fieldId, { text: 'x'.repeat(300 * 1024), version }), 413, fieldId],
      [put(fieldId, '{not json'), 400, fieldId],
      [put(fieldId, { text: 'x', version: 'yesterday' }), 400, fieldId],
      [put(fieldId, { text: 'x'.repeat(10_001), version }), 400, fieldId],
      [put('nope', { text: 'x', version }), 404, 'nope'],
      [
        put('00000000-0000-4000-8000-000000000000', { text: 'x', version }),
        404,
        '00000000-0000-4000-8000-000000000000',
      ],
    ];
    for (const [req, status, id] of cases) {
      const res = await as('manager', () => handleSaveNotes(req, id, t().db));
      expect({ status: res.status, body: await res.json() }).toMatchObject({
        status,
        body: { error: expect.any(String) },
      });
    }
    const r = await t().pool.query('select notes from farm.fields where id = $1', [fieldId]);
    expect(r.rows[0]?.notes).toBeNull();
  });
});

describe('isSameOriginRequest', () => {
  const req = (headers: Record<string, string>) => new Request('http://x/', { headers });
  test('no Origin (not a browser page) is allowed; the Origin must match the host', () => {
    expect(isSameOriginRequest(req({ host: '192.168.1.20:3000' }))).toBe(true);
    expect(
      isSameOriginRequest(req({ host: '192.168.1.20:3000', origin: 'http://192.168.1.20:3000' })),
    ).toBe(true);
    expect(
      isSameOriginRequest(req({ host: '192.168.1.20:3000', origin: 'http://localhost:3000' })),
    ).toBe(false);
    expect(isSameOriginRequest(req({ host: 'a:3000', origin: 'null' }))).toBe(false);
    expect(
      isSameOriginRequest(
        req({
          host: 'internal:3000',
          'x-forwarded-host': 'farm.example.com',
          origin: 'https://farm.example.com',
        }),
      ),
    ).toBe(true);
  });
});
