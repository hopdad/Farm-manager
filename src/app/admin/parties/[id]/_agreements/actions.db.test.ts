/**
 * The agreements' server actions against a real database and a real (temporary) storage tree,
 * as the sessions that press them (D17; docs/contracts-2a.md §7.6; done-when §11.4 "recorded
 * with an uploaded document (two-step grant), revoked"):
 *
 *  - a viewer or driver is refused on the server by every action; nothing is written;
 *  - step 1, the grant: a PDF or a photo up to 4 MB, a fresh key under the party's prefix;
 *  - step 2, the browser's PUT, through the storage route's own handler with the grant's URL
 *    and headers (a forged signature is refused);
 *  - step 3, the record: the document must be this party's and must have arrived; one document
 *    backs one agreement; the agreement lands with its key and author;
 *  - revoke: as of today by default, never in the future, once.
 * (Next's revalidatePath, the app pool and the storage writer are swapped for the test's.)
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { farmDate } from '@/domain/farm';
import { deterministicId } from '@/domain/ids';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role } from '@/platform/auth/types';
import { MAX_UPLOAD_BYTES } from '@/platform/storage/types';
import { handleStoragePut } from '@/platform/storage/upload';
import { LocalStorageWriter } from '@/platform/storage/writer';
import { setupTestDb } from '@/test/db';

const t = setupTestDb(import.meta.url);
const SECRET = 'agreements-test-secret-0123456789abcdef';
let root = '';
let writer: LocalStorageWriter;

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<typeof import('@/db/client')>()),
  getPool: () => t().pool,
}));
vi.mock('@/platform/storage/writer', async (orig) => ({
  ...(await orig<typeof import('@/platform/storage/writer')>()),
  getStorageWriter: () => writer,
}));
const { agreementUploadGrantAction, recordAgreementAction, revokeAgreementAction } = await import(
  './actions'
);

const id = (k: string) => deterministicId('test', k);
const CUSTOMER = id('party:customer');
const OTHER = id('party:other-customer');
const LANDLORD = id('party:landlord');
const MANAGER_USER = id('user:manager');
const today = farmDate(new Date());

const as = (role: Role) =>
  makeSession({
    role,
    displayName: `Test ${role}`,
    appUserId: role === 'manager' ? MANAGER_USER : null,
  });

const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  }
  return f;
};

const agreements = async (partyId: string) =>
  (
    await t().pool.query<{
      id: string;
      signed_on: string;
      document_key: string | null;
      permitted_uses: string[];
      revoked_on: string | null;
      created_by: string | null;
    }>(
      `select id::text as id, signed_on::text as signed_on, document_key, permitted_uses,
              revoked_on::text as revoked_on, created_by::text as created_by
         from farm.data_rights_agreements where party_id = $1 order by created_at`,
      [partyId],
    )
  ).rows;

/** Step 2 as the browser does it: PUT the bytes to the grant's URL with its headers. */
async function put(url: string, headers: Record<string, string>, bytes: Uint8Array) {
  const u = new URL(url, 'http://localhost:3124');
  const [, , , bucket, ...key] = u.pathname.split('/').map(decodeURIComponent);
  return handleStoragePut(
    new Request(u, { method: 'PUT', headers, body: Buffer.from(bytes) }),
    writer,
    bucket as string,
    key,
    { secret: SECRET },
  );
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'farm-agreements-'));
  writer = new LocalStorageWriter(root, SECRET);
  for (const [pid, name, roles] of [
    [CUSTOMER, 'Halvor Test Farms', '{customer}'],
    [OTHER, 'Other Customer', '{customer}'],
    [LANDLORD, 'Lana Landlord', '{landlord}'],
    [id('party:manager'), 'Mona Manager', '{crew}'],
  ] as const) {
    await t().pool.query(
      `insert into farm.parties (id, kind, display_name, roles) values ($1::uuid, 'org', $2, $3::text[])`,
      [pid, name, roles],
    );
  }
  await t().pool.query(
    `insert into farm.app_users (id, party_id, role) values ($1::uuid, $2::uuid, 'manager')`,
    [MANAGER_USER, id('party:manager')],
  );
});
afterAll(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('roles', () => {
  test('a viewer or a driver is refused by every action; nothing is written', async () => {
    for (const role of ['viewer', 'driver'] as const) {
      const s = as(role);
      const g = await runWithSession(s, () =>
        agreementUploadGrantAction(CUSTOMER, { name: 'a.pdf', size: 100 }),
      );
      expect(g, role).toMatchObject({
        ok: false,
        message: 'This needs the manager role (or above).',
      });
      expect(g.data).toBeUndefined();
      const r = await runWithSession(s, () =>
        recordAgreementAction(
          null,
          form({ partyId: CUSTOMER, signedOn: '2026-10-01', uses: 'billing' }),
        ),
      );
      expect(r.ok).toBe(false);
      const v = await runWithSession(s, () =>
        revokeAgreementAction(null, form({ id: CUSTOMER, partyId: CUSTOMER })),
      );
      expect(v.ok).toBe(false);
    }
    expect(
      await runWithSession(null, () =>
        recordAgreementAction(null, form({ partyId: CUSTOMER, signedOn: '2026-10-01' })),
      ),
    ).toMatchObject({ ok: false, message: 'Sign in first.' });
    expect(await agreements(CUSTOMER)).toEqual([]);
  });
});

describe('record with a document (two-step grant), then revoke', () => {
  const m = () => as('manager');
  let key = '';
  let headers: Record<string, string> = {};
  let url = '';
  const bytes = new TextEncoder().encode('%PDF-1.4 signed by Halvor Test Farms');

  test('the grant: a PDF or a photo up to 4 MB, a fresh key under the party', async () => {
    for (const [file, message] of [
      [{ name: 'agreement.docx', size: 10 }, 'PDF or a photo'],
      [{ name: 'logo.svg', size: 10 }, 'PDF or a photo'],
      [{ name: 'a.pdf', size: 0 }, 'empty'],
      [{ name: 'a.pdf', size: MAX_UPLOAD_BYTES + 1 }, 'over 4 MB'],
    ] as const) {
      const g = await runWithSession(m(), () => agreementUploadGrantAction(CUSTOMER, file));
      expect(g.ok, file.name).toBe(false);
      expect(g.message).toContain(message);
    }
    expect(
      (
        await runWithSession(m(), () =>
          agreementUploadGrantAction('nope', { name: 'a.pdf', size: 9 }),
        )
      ).ok,
    ).toBe(false);
    const g = await runWithSession(m(), () =>
      agreementUploadGrantAction(CUSTOMER, { name: 'Signed.PDF', size: bytes.length }),
    );
    expect(g.ok).toBe(true);
    key = g.data?.key ?? '';
    url = g.data?.url ?? '';
    headers = g.data?.headers ?? {};
    expect(key).toMatch(new RegExp(`^agreements/${CUSTOMER}/[0-9a-f-]{36}\\.pdf$`));
    expect(url).toMatch(/^\/api\/storage\/uploads\/agreements\/.+\?.+/);
    expect(headers).toEqual({ 'content-type': 'application/pdf' });
  });

  test('step 2: the PUT lands with the grant; a forged one is refused', async () => {
    const forged = url.replace(/sig=[^&]+/, 'sig=AAAA');
    expect((await put(forged, headers, bytes)).status).toBe(403);
    expect((await put(url, { 'content-type': 'image/png' }, bytes)).status).toBe(403);
    const res = await put(url, headers, bytes);
    expect(res.status).toBe(201);
    expect(await writer.stat('uploads', key)).toMatchObject({ size: bytes.length });
  });

  test("step 3: the record checks the document is this party's and arrived", async () => {
    const base = { partyId: CUSTOMER, signedOn: '2026-10-01', uses: ['billing', 'agronomy'] };
    const other = await runWithSession(m(), () =>
      recordAgreementAction(null, form({ ...base, partyId: OTHER, documentKey: key })),
    );
    expect(other).toMatchObject({ ok: false, message: 'that document belongs to another party' });
    const missing = key.replace(/[0-9a-f]{12}\.pdf$/, '000000000000.pdf');
    expect(
      await runWithSession(m(), () =>
        recordAgreementAction(null, form({ ...base, documentKey: missing })),
      ),
    ).toMatchObject({ ok: false, message: "the document didn't arrive: choose the file again" });
    expect(
      await runWithSession(m(), () =>
        recordAgreementAction(null, form({ ...base, uses: [], documentKey: key })),
      ),
    ).toMatchObject({ ok: false, message: 'pick at least one permitted use' });
    expect(
      await runWithSession(m(), () =>
        recordAgreementAction(null, form({ ...base, partyId: LANDLORD })),
      ),
    ).toMatchObject({ ok: false, message: 'only a customer can sign a data-rights agreement' });
    expect(await agreements(CUSTOMER)).toEqual([]);

    const ok = await runWithSession(m(), () =>
      recordAgreementAction(null, form({ ...base, notes: 'paper copy filed', documentKey: key })),
    );
    expect(ok).toMatchObject({
      ok: true,
      message: 'Agreement signed 2026-10-01 recorded with its document',
    });
    expect(await agreements(CUSTOMER)).toEqual([
      expect.objectContaining({
        signed_on: '2026-10-01',
        document_key: key,
        permitted_uses: ['billing', 'agronomy'],
        revoked_on: null,
        created_by: MANAGER_USER,
      }),
    ]);
    // One document backs one agreement.
    expect(
      await runWithSession(m(), () =>
        recordAgreementAction(null, form({ ...base, documentKey: key })),
      ),
    ).toMatchObject({ ok: false, message: 'that document is already on another agreement' });
  });

  test('without a document: the agreement alone', async () => {
    const r = await runWithSession(m(), () =>
      recordAgreementAction(null, form({ partyId: OTHER, signedOn: today, uses: 'prospecting' })),
    );
    expect(r).toMatchObject({ ok: true, message: `Agreement signed ${today} recorded` });
    expect((await agreements(OTHER))[0]).toMatchObject({ document_key: null });
  });

  test("revoke: never in the future, not another party's, once", async () => {
    const [a] = await agreements(CUSTOMER);
    const aid = a?.id as string;
    expect(
      await runWithSession(m(), () =>
        revokeAgreementAction(null, form({ id: aid, partyId: OTHER })),
      ),
    ).toMatchObject({ ok: false, message: 'unknown agreement' });
    expect(
      await runWithSession(m(), () =>
        revokeAgreementAction(null, form({ id: aid, partyId: CUSTOMER, revokedOn: '2999-01-01' })),
      ),
    ).toMatchObject({ ok: false, message: 'the revocation date is in the future' });
    expect(
      await runWithSession(m(), () =>
        revokeAgreementAction(null, form({ id: aid, partyId: CUSTOMER, revokedOn: '2026-09-01' })),
      ),
    ).toMatchObject({ ok: false, message: 'the revocation date is before the signing date' });
    expect(
      await runWithSession(m(), () =>
        revokeAgreementAction(null, form({ id: aid, partyId: CUSTOMER })),
      ),
    ).toMatchObject({ ok: true, message: `Agreement revoked as of ${today}` });
    expect((await agreements(CUSTOMER))[0]?.revoked_on).toBe(today);
    expect(
      await runWithSession(m(), () =>
        revokeAgreementAction(null, form({ id: aid, partyId: CUSTOMER })),
      ),
    ).toMatchObject({ ok: false, message: 'already revoked' });
  });
});
