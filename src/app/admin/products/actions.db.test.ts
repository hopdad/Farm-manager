/**
 * /admin/products' server actions against the real database, as the sessions that press them:
 * below manager is refused on the server (nothing changes); a manager adds, edits (a stale
 * version is refused), retires, brings back and deletes; a product on a job can't be deleted.
 * (Next's revalidatePath and the app pool are swapped for the test's.)
 */
import { afterAll, describe, expect, test, vi } from 'vitest';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role } from '@/platform/auth/types';
import { setupTestDb } from '@/test/db';

const t = setupTestDb(import.meta.url);
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<typeof import('@/db/client')>()),
  getPool: () => t().pool,
}));
const {
  createProductAction,
  deleteProductAction,
  restoreProductAction,
  retireProductAction,
  updateProductAction,
} = await import('./actions');
const { listProducts } = await import('@/db/queries/products');

afterAll(() => vi.restoreAllMocks());

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const as = (role: Role) => makeSession({ role, displayName: `Test ${role}` });
const byName = async (name: string) =>
  (await listProducts(t().pool)).find((p) => p.name === name) ?? null;

describe('/admin/products actions', () => {
  test('below manager: refused on the server, nothing added', async () => {
    for (const role of ['viewer', 'driver', 'operator'] as const) {
      const r = await runWithSession(as(role), () =>
        createProductAction(null, form({ kind: 'fuel', name: 'Nope', unit: 'gal' })),
      );
      expect(r, role).toMatchObject({
        ok: false,
        message: 'Changing products needs a manager or the owner.',
      });
    }
    expect(
      await runWithSession(null, () =>
        retireProductAction(null, form({ id: crypto.randomUUID() })),
      ),
    ).toMatchObject({ ok: false, message: 'Sign in first.' });
    expect(await byName('Nope')).toBeNull();
  });

  test('a manager adds, edits, retires, brings back and deletes', async () => {
    const m = as('manager');
    expect(
      await runWithSession(m, () =>
        createProductAction(null, form({ kind: 'fuel', name: ' ', unit: 'gal' })),
      ),
    ).toMatchObject({ ok: false, message: 'Give the product a name.' });
    expect(
      await runWithSession(m, () =>
        createProductAction(
          null,
          form({
            kind: 'chemical',
            name: 'Atrazine 4L',
            unit: 'gal',
            epaRegNo: '100-497',
            restrictedUse: 'on',
          }),
        ),
      ),
    ).toMatchObject({ ok: true, message: 'Added Atrazine 4L' });
    const p = await byName('Atrazine 4L');
    expect(p).toMatchObject({ restrictedUse: true, epaRegNo: '100-497', active: true });
    if (!p) throw new Error('missing');

    const edit = await runWithSession(m, () =>
      updateProductAction(
        null,
        form({
          id: p.id,
          version: p.version,
          kind: 'chemical',
          name: 'Atrazine 4L (RUP)',
          unit: 'gal',
        }),
      ),
    );
    expect(edit).toMatchObject({ ok: true, message: 'Saved Atrazine 4L (RUP)' });
    // The unchecked box is false: restricted use comes off.
    expect((await byName('Atrazine 4L (RUP)'))?.restrictedUse).toBe(false);
    const stale = await runWithSession(m, () =>
      updateProductAction(
        null,
        form({ id: p.id, version: p.version, kind: 'chemical', name: 'Mine', unit: 'gal' }),
      ),
    );
    expect(stale).toMatchObject({ ok: false, message: /changed Atrazine 4L \(RUP\) since/ });

    expect(
      await runWithSession(m, () => retireProductAction(null, form({ id: p.id }))),
    ).toMatchObject({
      ok: true,
      message: /Retired Atrazine 4L \(RUP\)/,
    });
    expect((await byName('Atrazine 4L (RUP)'))?.active).toBe(false);
    expect(
      await runWithSession(m, () => restoreProductAction(null, form({ id: p.id }))),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await runWithSession(m, () =>
        deleteProductAction(null, form({ id: p.id, name: 'Atrazine 4L (RUP)' })),
      ),
    ).toMatchObject({ ok: true, message: 'Deleted Atrazine 4L (RUP)' });
    expect(await byName('Atrazine 4L (RUP)')).toBeNull();
    expect(
      await runWithSession(m, () => retireProductAction(null, form({ id: 'not-a-uuid' }))),
    ).toMatchObject({ ok: false, message: 'That product no longer exists.' });
  });

  test('a product on a job is never deleted: retire it', async () => {
    const m = as('manager');
    await runWithSession(m, () =>
      createProductAction(null, form({ kind: 'fertilizer', name: '28% UAN', unit: 'gal' })),
    );
    const p = await byName('28% UAN');
    if (!p) throw new Error('missing');
    const j = await t().pool.query<{ id: string }>(
      `insert into farm.jobs (kind, business_line) values ('fertilize', 'spraying') returning id`,
    );
    await t().pool.query('insert into farm.job_products (job_id, product_id) values ($1, $2)', [
      j.rows[0]?.id,
      p.id,
    ]);
    expect(
      await runWithSession(m, () => deleteProductAction(null, form({ id: p.id, name: '28% UAN' }))),
    ).toMatchObject({
      ok: false,
      message: '28% UAN is on 1 job: retire it instead (the jobs keep it).',
    });
    expect(await byName('28% UAN')).not.toBeNull();
  });
});
