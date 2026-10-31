/**
 * POST /admin/vehicles/kind against the real database, run as the sessions it serves: the role is
 * checked first on the server (401 signed out, 403 viewer / driver / operator), then the origin,
 * content type, size and body; a manager sets a kind (kind_set_by admin, ONE fleet/invalidate)
 * that later vendor tags never change, and can hand it back to the tags.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { listenAppEvents } from '@/connectors/testkit';
import { applyVendorVehicle } from '@/db/queries/vehicles';
import { machines } from '@/db/schema';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role, Session } from '@/platform/auth/types';
import { setupTestDb } from '@/test/db';
import { handleSetVehicleKind } from './handler';

const t = setupTestDb(import.meta.url);
let pickup: string;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

const as = (role: Role | null): Session | null =>
  role === null ? null : makeSession({ role, displayName: `Test ${role}` });

async function post(
  session: Session | null,
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
) {
  const req = new Request('http://localhost:3117/admin/vehicles/kind', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await runWithSession(session, () => handleSetVehicleKind(req, t().pool));
  expect(res.headers.get('cache-control')).toBe('no-store');
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function row() {
  const r = await t().pool.query('select kind, kind_set_by from farm.machines where id = $1', [
    pickup,
  ]);
  return r.rows[0];
}

beforeAll(async () => {
  const [m] = await t()
    .db.insert(machines)
    .values({ kind: 'pickup', unitNo: 'PU1', kindSetBy: 'vendor', telematicsVia: 'ford_pro' })
    .returning({ id: machines.id });
  pickup = m?.id as string;
  listener = await listenAppEvents(t().appUrl);
});
afterAll(async () => {
  await listener?.close();
});

describe('POST /admin/vehicles/kind', () => {
  test('signed out: 401; a viewer, driver or operator: 403; nothing changes', async () => {
    expect((await post(null, { machineId: pickup, kind: 'service_truck' })).status).toBe(401);
    for (const role of ['viewer', 'driver', 'operator'] as const) {
      const r = await post(as(role), { machineId: pickup, kind: 'service_truck' });
      expect(r.status, role).toBe(403);
    }
    expect(await row()).toEqual({ kind: 'pickup', kind_set_by: 'vendor' });
  });

  test('a manager: body checks first, then the kind, set by hand, with ONE invalidate', async () => {
    const m = as('manager');
    expect((await post(m, { machineId: pickup, kind: 'combine' })).status).toBe(400);
    expect((await post(m, 'nope')).status).toBe(400);
    expect(
      (await post(m, { machineId: pickup, kind: 'semi' }, { 'content-type': 'text/plain' })).status,
    ).toBe(415);
    expect((await post(m, { machineId: pickup, kind: 'semi', pad: 'x'.repeat(5000) })).status).toBe(
      413,
    );
    expect(
      (
        await post(
          m,
          { machineId: pickup, kind: 'semi' },
          {
            'content-type': 'application/json',
            origin: 'https://evil.example',
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (await post(m, { machineId: '00000000-0000-4000-8000-000000000000', kind: 'semi' })).status,
    ).toBe(404);

    const before = listener.of('fleet', 'invalidate').length;
    const ok = await post(m, { machineId: pickup, kind: 'service_truck' });
    expect(ok).toEqual({
      status: 200,
      body: { ok: true, machineId: pickup, kind: 'service_truck', kindSetBy: 'admin' },
    });
    await listener.settle();
    const sent = listener.of('fleet', 'invalidate').slice(before);
    expect(sent.map((x) => x.payload)).toEqual([
      expect.objectContaining({ event: 'machine', reason: 'changed' }),
    ]);

    // Later vendor tags never change it.
    await applyVendorVehicle(t().pool, pickup, { kindFromTags: 'pickup', via: 'ford_pro' });
    expect(await row()).toEqual({ kind: 'service_truck', kind_set_by: 'admin' });
  });

  test('release hands the kind back to the vendor tags', async () => {
    const r = await post(as('owner'), { machineId: pickup, release: true });
    expect(r.body).toMatchObject({ kind: 'service_truck', kindSetBy: 'default' });
    await applyVendorVehicle(t().pool, pickup, { kindFromTags: 'pickup', via: null });
    expect(await row()).toEqual({ kind: 'pickup', kind_set_by: 'vendor' });
  });
});
