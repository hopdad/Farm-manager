/**
 * The data-rights policy (D17, docs/contracts-2a.md §4.4 "Prospecting"; done-when §11.4
 * `mayUseCustomerData` tested), the agreement form's checks and the document keys.
 */
import { describe, expect, test } from 'vitest';
import {
  AGREEMENT_DOCUMENT_TYPES,
  type AgreementTerms,
  agreementDocumentExt,
  agreementDocumentKey,
  agreementInForce,
  isAgreementDocumentKeyOf,
  isCalendarDay,
  MAX_AGREEMENT_NOTES_CHARS,
  mayUseCustomerData,
  validateAgreement,
  validateRevocation,
} from './data-rights';
import { PERMITTED_USES } from './work-jobs';

const PARTY = '84162a8b-6504-52c6-97f2-7ed42b767f99';
const DOC = '0b3f8f1e-5d43-4a7e-9a55-6c2c1f9f0a11';

describe('mayUseCustomerData', () => {
  const billing: AgreementTerms = { permittedUses: ['billing'], revokedOn: null };
  const all: AgreementTerms = { permittedUses: [...PERMITTED_USES], revokedOn: null };
  const revokedAll: AgreementTerms = {
    permittedUses: [...PERMITTED_USES],
    revokedOn: '2026-10-01',
  };

  test('no agreement: no use at all', () => {
    for (const use of PERMITTED_USES) expect(mayUseCustomerData([], use)).toBe(false);
  });

  test('an agreement in force allows exactly the uses it names', () => {
    expect(mayUseCustomerData([billing], 'billing')).toBe(true);
    expect(mayUseCustomerData([billing], 'prospecting')).toBe(false);
    expect(mayUseCustomerData([billing], 'agronomy')).toBe(false);
    for (const use of PERMITTED_USES) expect(mayUseCustomerData([all], use)).toBe(true);
  });

  test('a revoked agreement allows nothing; another one in force still counts', () => {
    for (const use of PERMITTED_USES) expect(mayUseCustomerData([revokedAll], use)).toBe(false);
    expect(mayUseCustomerData([revokedAll, billing], 'billing')).toBe(true);
    expect(mayUseCustomerData([revokedAll, billing], 'prospecting')).toBe(false);
  });

  test('an agreement in force names no use: nothing', () => {
    expect(mayUseCustomerData([{ permittedUses: [], revokedOn: null }], 'billing')).toBe(false);
  });

  test('in force while not revoked', () => {
    expect(agreementInForce(billing)).toBe(true);
    expect(agreementInForce(revokedAll)).toBe(false);
  });
});

describe('validateAgreement', () => {
  const today = '2026-11-06';
  const ok = { signedOn: '2026-10-01', permittedUses: ['agronomy', 'billing'], notes: '  x  ' };

  test('a good agreement: uses in list order, notes trimmed', () => {
    expect(validateAgreement(ok, today)).toEqual({
      ok: true,
      value: { signedOn: '2026-10-01', permittedUses: ['billing', 'agronomy'], notes: 'x' },
    });
    expect(validateAgreement({ ...ok, notes: '   ', signedOn: today }, today)).toMatchObject({
      ok: true,
      value: { notes: null, signedOn: today },
    });
  });

  test('duplicates collapse', () => {
    const r = validateAgreement({ ...ok, permittedUses: ['billing', 'billing'] }, today);
    expect(r).toMatchObject({ ok: true, value: { permittedUses: ['billing'] } });
  });

  test.each([
    [{ signedOn: '2026-02-30' }, 'not a date'],
    [{ signedOn: '10/01/2026' }, 'not a date'],
    [{ signedOn: '2026-11-07' }, 'in the future'],
    [{ signedOn: '1989-12-31' }, 'before 1990'],
    [{ permittedUses: [] }, 'at least one'],
    [{ permittedUses: ['billing', 'resale'] }, 'unknown use'],
    [{ notes: 'x'.repeat(MAX_AGREEMENT_NOTES_CHARS + 1) }, 'longer than'],
  ])('%o is refused (%s)', (patch, message) => {
    const r = validateAgreement({ ...ok, ...patch }, today);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('; ')).toContain(message);
  });

  test('calendar days', () => {
    expect(isCalendarDay('2028-02-29')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('2026-13-01')).toBe(false);
    expect(isCalendarDay('2026-1-01')).toBe(false);
  });
});

describe('validateRevocation', () => {
  test('today or earlier, not before the signing date', () => {
    expect(validateRevocation('2026-11-06', '2026-10-01', '2026-11-06')).toBeNull();
    expect(validateRevocation('2026-10-01', '2026-10-01', '2026-11-06')).toBeNull();
    expect(validateRevocation('2026-11-07', '2026-10-01', '2026-11-06')).toContain('future');
    expect(validateRevocation('2026-09-30', '2026-10-01', '2026-11-06')).toContain('before');
    expect(validateRevocation('nope', '2026-10-01', '2026-11-06')).toContain('not a date');
  });
});

describe('document keys', () => {
  test('a PDF or a photo, by extension', () => {
    expect(agreementDocumentExt('Halvorsen signed.PDF')).toBe('pdf');
    expect(agreementDocumentExt('scan.jpeg')).toBe('jpeg');
    expect(agreementDocumentExt('scan.webp')).toBe('webp');
    expect(agreementDocumentExt('agreement.docx')).toBeNull();
    expect(agreementDocumentExt('logo.svg')).toBeNull();
    expect(agreementDocumentExt('pdf')).toBeNull();
    expect(agreementDocumentExt('.pdf')).toBeNull();
    expect(agreementDocumentExt('x.constructor')).toBeNull();
    expect(AGREEMENT_DOCUMENT_TYPES.pdf).toBe('application/pdf');
  });

  test('one key per party and upload, recognised only for its party', () => {
    const key = agreementDocumentKey(PARTY, DOC, 'pdf');
    expect(key).toBe(`agreements/${PARTY}/${DOC}.pdf`);
    expect(isAgreementDocumentKeyOf(key, PARTY)).toBe(true);
    expect(isAgreementDocumentKeyOf(key, DOC)).toBe(false);
    expect(isAgreementDocumentKeyOf(`agreements/${PARTY}/${DOC}.svg`, PARTY)).toBe(false);
    expect(isAgreementDocumentKeyOf(`agreements/${PARTY}/../${DOC}.pdf`, PARTY)).toBe(false);
    expect(isAgreementDocumentKeyOf(`agreements/${PARTY}/notes.pdf`, PARTY)).toBe(false);
    expect(isAgreementDocumentKeyOf(`photos/${PARTY}/${DOC}.pdf`, PARTY)).toBe(false);
    expect(() => agreementDocumentKey('nope', DOC, 'pdf')).toThrow();
  });
});
