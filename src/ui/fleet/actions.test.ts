import { describe, expect, test, vi } from 'vitest';
import { postMachineStatus } from './actions';

const ID = '00000000-0000-4000-8000-000000000001';
const fetchOf = (r: () => Response | Promise<Response>) =>
  vi.fn(async () => r()) as unknown as typeof globalThis.fetch;

describe('postMachineStatus', () => {
  test('POSTs JSON to the machine status URL and returns the result', async () => {
    const result = {
      machineId: ID,
      status: 'down',
      downReason: 'Flat tire',
      downAt: '2026-11-30T15:00:00.000Z',
      by: 'Dana',
    };
    const f = fetchOf(() => Response.json(result));
    const r = await postMachineStatus(ID, { status: 'down', reason: 'Flat tire' }, f);
    expect(r).toEqual({ ok: true, result });
    expect(f).toHaveBeenCalledWith(
      `/api/machines/${ID}/status`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ status: 'down', reason: 'Flat tire' }),
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
      }),
    );
  });

  test('refusals and failures read as sentences', async () => {
    const cases: [Response, RegExp][] = [
      [Response.json({ error: 'sign in required' }, { status: 401 }), /Sign in/],
      [Response.json({ error: 'needs driver' }, { status: 403 }), /role/],
      [Response.json({ error: 'cross-site request refused' }, { status: 403 }), /page may not/],
      [Response.json({ error: 'machine not found' }, { status: 404 }), /no longer exists/],
      [Response.json({ error: 'this machine is retired' }, { status: 409 }), /retired/],
      [Response.json({ error: 'say why it is down' }, { status: 400 }), /say why/],
      [new Response('<html>bad gateway</html>', { status: 502 }), /Could not save/],
    ];
    for (const [res, msg] of cases) {
      const r = await postMachineStatus(
        ID,
        { status: 'active' },
        fetchOf(() => res),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(msg);
    }
  });

  test('no connection', async () => {
    const r = await postMachineStatus(
      ID,
      { status: 'active' },
      fetchOf(() => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(r).toEqual({ ok: false, status: 0, error: expect.stringMatching(/No connection/) });
  });

  test('a 200 with an unexpected body is not reported as saved cleanly', async () => {
    const r = await postMachineStatus(
      ID,
      { status: 'active' },
      fetchOf(() => Response.json({})),
    );
    expect(r.ok).toBe(false);
  });
});
