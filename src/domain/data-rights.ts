/**
 * Data-rights agreements (D17, decision 2a-10; docs/contracts-2a.md §4.4), pure: what an
 * agreement on file allows, how a recorded agreement is checked before it is written, and where
 * its signed document lives in the private `uploads` bucket. The database side is
 * src/db/queries/agreements.ts; the Deere read gate is src/connectors/deere/rights.ts.
 *
 *  - An agreement COUNTS while `revokedOn` is null (farm.data_rights_agreements; the attorney's
 *    wording is due Mar 1, 2027: until then any signed agreement on file is enough to read a
 *    customer's Deere org, contracts-2a §12).
 *  - `mayUseCustomerData(agreements, use)`: the policy every future use of customer data asks
 *    (M4's prospecting first): only an agreement in force that names the use allows it; none
 *    means no.
 */
import { PERMITTED_USES, type PermittedUse } from './work-jobs';

/** The parts of an agreement the policy reads. */
export interface AgreementTerms {
  permittedUses: readonly PermittedUse[];
  /** 'YYYY-MM-DD'; null while it counts. */
  revokedOn: string | null;
}

/** Does this agreement count (not revoked)? */
export function agreementInForce(a: AgreementTerms): boolean {
  return a.revokedOn === null;
}

/**
 * May the farm use this customer's data for `use`? True only when one of the customer's
 * agreements is in force and names the use. No agreements (or only revoked ones) = no.
 */
export function mayUseCustomerData(
  agreements: readonly AgreementTerms[],
  use: PermittedUse,
): boolean {
  return agreements.some((a) => agreementInForce(a) && a.permittedUses.includes(use));
}

// ---------------------------------------------------------------------------------------------
// Recording an agreement
// ---------------------------------------------------------------------------------------------

/** Longest notes an agreement takes (the form's limit; the column has none). */
export const MAX_AGREEMENT_NOTES_CHARS = 2_000;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date 'YYYY-MM-DD' (no Feb 30)? */
export function isCalendarDay(s: string): boolean {
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export interface RawAgreementInput {
  signedOn: string;
  permittedUses: readonly string[];
  notes: string;
}

export interface AgreementInput {
  signedOn: string;
  permittedUses: PermittedUse[];
  notes: string | null;
}

/**
 * Check a new agreement (the form). `today` is the farm's date ('YYYY-MM-DD', farmDate(now)):
 * an agreement can't be signed in the future. At least one use; the uses in PERMITTED_USES order,
 * without duplicates.
 */
export function validateAgreement(
  raw: RawAgreementInput,
  today: string,
): { ok: true; value: AgreementInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const signedOn = raw.signedOn.trim();
  if (!isCalendarDay(signedOn)) errors.push('the signing date is not a date (YYYY-MM-DD)');
  else if (signedOn > today) errors.push('the signing date is in the future');
  else if (signedOn < '1990-01-01') errors.push('the signing date is before 1990');
  const unknown = raw.permittedUses.filter(
    (u) => !(PERMITTED_USES as readonly string[]).includes(u),
  );
  if (unknown.length) errors.push(`unknown use(s): ${unknown.join(', ')}`);
  const uses = PERMITTED_USES.filter((u) => raw.permittedUses.includes(u));
  if (uses.length === 0 && unknown.length === 0) errors.push('pick at least one permitted use');
  const notes = raw.notes.trim() || null;
  if (notes && notes.length > MAX_AGREEMENT_NOTES_CHARS) {
    errors.push(`the notes are longer than ${MAX_AGREEMENT_NOTES_CHARS} characters`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { signedOn, permittedUses: uses, notes } };
}

/**
 * Check a revocation date: a real date, not before the signing date (the table's CHECK) and not
 * in the future (an agreement counts while `revoked_on` is null, so a date ahead would be a lie
 * about today).
 */
export function validateRevocation(
  revokedOn: string,
  signedOn: string,
  today: string,
): string | null {
  if (!isCalendarDay(revokedOn)) return 'the revocation date is not a date (YYYY-MM-DD)';
  if (revokedOn > today) return 'the revocation date is in the future';
  if (revokedOn < signedOn) return 'the revocation date is before the signing date';
  return null;
}

// ---------------------------------------------------------------------------------------------
// The signed document (private `uploads` bucket, two-step grant: docs/contracts-m1.md §9)
// ---------------------------------------------------------------------------------------------

/** Document types an agreement takes: a PDF or a photo of the signed page. Extension -> type. */
export const AGREEMENT_DOCUMENT_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;
export type AgreementDocumentExt = keyof typeof AGREEMENT_DOCUMENT_TYPES;

/** Where agreements' documents live inside the `uploads` bucket. */
export const AGREEMENT_DOCUMENT_PREFIX = 'agreements';

/** The extension (lower case) of a file name when it is one an agreement takes, else null. */
export function agreementDocumentExt(fileName: string): AgreementDocumentExt | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return Object.hasOwn(AGREEMENT_DOCUMENT_TYPES, ext) ? (ext as AgreementDocumentExt) : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `agreements/<party id>/<document id>.<ext>`: one key per upload, never reused. */
export function agreementDocumentKey(
  partyId: string,
  documentId: string,
  ext: AgreementDocumentExt,
): string {
  if (!UUID_RE.test(partyId) || !UUID_RE.test(documentId)) throw new Error('expected uuids');
  return `${AGREEMENT_DOCUMENT_PREFIX}/${partyId}/${documentId}.${ext}`;
}

/** Is `key` a document key made for this party by `agreementDocumentKey`? */
export function isAgreementDocumentKeyOf(key: string, partyId: string): boolean {
  const parts = key.split('/');
  if (parts.length !== 3 || parts[0] !== AGREEMENT_DOCUMENT_PREFIX || parts[1] !== partyId) {
    return false;
  }
  const file = parts[2] as string;
  const dot = file.lastIndexOf('.');
  return (
    dot > 0 &&
    UUID_RE.test(file.slice(0, dot)) &&
    agreementDocumentExt(file) === file.slice(dot + 1)
  );
}
