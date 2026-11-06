/**
 * The browser side of recording an agreement with its document (two-step upload,
 * docs/contracts-m1.md §9): grant, PUT straight to storage with the grant's headers, then the
 * record action with the key in place of the file; every failure is the answer and nothing is
 * recorded then; no file = the agreement alone.
 */
import { describe, expect, test } from 'vitest';
import { type ActionResult, actionResult } from '../../../action-result';
import { type GrantAnswer, recordWithDocument } from './upload';

const PARTY = '84162a8b-6504-52c6-97f2-7ed42b767f99';
const KEY = `agreements/${PARTY}/0b3f8f1e-5d43-4a7e-9a55-6c2c1f9f0a11.pdf`;

function setup(opts: { grant?: GrantAnswer; put?: number | Error } = {}) {
  const log: string[] = [];
  let recorded: FormData | null = null;
  let putInit: RequestInit | undefined;
  const deps = {
    partyId: PARTY,
    grant: async (partyId: string, file: { name: string; size: number }) => {
      log.push(`grant ${partyId} ${file.name} ${file.size}`);
      return (
        opts.grant ?? {
          ...actionResult(true, 'uploading'),
          data: {
            url: '/api/storage/uploads/x?sig=1',
            headers: { 'content-type': 'application/pdf' },
            key: KEY,
          },
        }
      );
    },
    record: async (_prev: ActionResult | null, form: FormData) => {
      log.push('record');
      recorded = form;
      return actionResult(true, 'Agreement recorded');
    },
    fetch: (async (url: string, init?: RequestInit) => {
      log.push(`put ${url}`);
      putInit = init;
      if (opts.put instanceof Error) throw opts.put;
      return new Response(null, { status: opts.put ?? 201 });
    }) as unknown as typeof fetch,
  };
  return {
    deps,
    log,
    recorded: () => recorded as FormData | null,
    putInit: () => putInit,
  };
}

function form(file?: File) {
  const f = new FormData();
  f.set('partyId', PARTY);
  f.set('signedOn', '2026-10-01');
  f.append('uses', 'billing');
  if (file) f.set('document', file);
  else f.set('document', new File([], ''));
  // A stale key from an earlier attempt never travels.
  f.set('documentKey', 'agreements/someone-else/x.pdf');
  return f;
}

const pdf = () => new File(['%PDF-1.4 signed'], 'signed.pdf', { type: 'application/pdf' });

describe('recordWithDocument', () => {
  test('grant, PUT with the grant headers, then record with the key instead of the file', async () => {
    const s = setup();
    const r = await recordWithDocument(form(pdf()), s.deps);
    expect(r).toMatchObject({ ok: true, message: 'Agreement recorded' });
    expect(s.log).toEqual([
      `grant ${PARTY} signed.pdf 15`,
      'put /api/storage/uploads/x?sig=1',
      'record',
    ]);
    expect(s.putInit()?.method).toBe('PUT');
    expect(s.putInit()?.headers).toEqual({ 'content-type': 'application/pdf' });
    expect(s.putInit()?.body).toBeInstanceOf(File);
    const sent = s.recorded();
    expect(sent?.get('documentKey')).toBe(KEY);
    expect(sent?.has('document')).toBe(false);
    expect(sent?.getAll('uses')).toEqual(['billing']);
  });

  test('no file: the agreement alone, no grant, no PUT', async () => {
    const s = setup();
    await recordWithDocument(form(), s.deps);
    expect(s.log).toEqual(['record']);
    expect(s.recorded()?.has('documentKey')).toBe(false);
    expect(s.recorded()?.has('document')).toBe(false);
  });

  test('a refused grant is the answer; nothing is uploaded or recorded', async () => {
    const s = setup({ grant: actionResult(false, 'the document must be a PDF or a photo') });
    const r = await recordWithDocument(form(pdf()), s.deps);
    expect(r).toMatchObject({ ok: false, message: 'the document must be a PDF or a photo' });
    expect(s.log).toHaveLength(1);
  });

  test('a failed or refused PUT: not recorded', async () => {
    for (const [put, text] of [
      [403, 'HTTP 403'],
      [413, 'too large'],
      [new TypeError('network'), 'check the connection'],
    ] as const) {
      const s = setup({ put });
      const r = await recordWithDocument(form(pdf()), s.deps);
      expect(r.ok).toBe(false);
      expect(r.message).toContain(text);
      expect(s.log).not.toContain('record');
    }
  });
});
