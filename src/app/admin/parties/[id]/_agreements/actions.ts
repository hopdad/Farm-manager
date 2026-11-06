'use server';
/**
 * Server actions behind a customer's data-rights agreements on /admin/parties/<id> (D17,
 * decision 2a-10; docs/contracts-2a.md §7.6). Every one checks ROLE_FOR.admin (a manager) FIRST,
 * on the server (`runAction`), and never throws to the client.
 *
 *  - `agreementUploadGrantAction`: step 1 of the signed document's two-step upload
 *    (docs/contracts-m1.md §9): a short-lived signed PUT grant for a fresh key
 *    `agreements/<party>/<uuid>.<ext>` in the private `uploads` bucket (a PDF or a photo, at
 *    most 4 MB). The browser PUTs the bytes straight to storage (never through an action).
 *  - `recordAgreementAction`: the agreement itself (signed on, permitted uses, notes, and the
 *    uploaded document's key, checked to be this party's and to exist in storage).
 *  - `revokeAgreementAction`: revoked as of a date (today by default; never in the future,
 *    never before the signing date). From the next Deere run its orgs are not read in live.
 */
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getPool } from '@/db/client';
import { getAgreement, recordAgreement, revokeAgreement } from '@/db/queries/agreements';
import {
  AGREEMENT_DOCUMENT_TYPES,
  agreementDocumentExt,
  agreementDocumentKey,
  isAgreementDocumentKeyOf,
  validateAgreement,
  validateRevocation,
} from '@/domain/data-rights';
import { farmDate } from '@/domain/farm';
import { isUuid } from '@/domain/ids';
import { ROLE_FOR } from '@/platform/auth/types';
import { MAX_UPLOAD_BYTES } from '@/platform/storage/types';
import { getStorageWriter } from '@/platform/storage/writer';
import type { ActionResult } from '../../../action-result';
import { type DataResult, formText, runAction } from '../../../fields/_lib/access';

/** How long the browser has to PUT the document after asking (minutes are plenty on a LAN). */
const GRANT_SECONDS = 10 * 60;

const pathOf = (partyId: string) => `/admin/parties/${partyId}`;

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;

export interface AgreementUploadGrant {
  url: string;
  headers: Record<string, string>;
  key: string;
}

/** Step 1 of the document upload: a signed PUT grant for this party's next document. */
export async function agreementUploadGrantAction(
  partyId: string,
  file: { name: string; size: number },
): Promise<DataResult<AgreementUploadGrant>> {
  return runAction<AgreementUploadGrant>(ROLE_FOR.admin, async () => {
    if (!isUuid(partyId)) return { ok: false, message: 'unknown party' };
    const name = typeof file?.name === 'string' ? file.name : '';
    const size = Number(file?.size);
    const ext = agreementDocumentExt(name);
    if (!ext)
      return { ok: false, message: 'the document must be a PDF or a photo (JPEG, PNG, WebP)' };
    if (!Number.isSafeInteger(size) || size < 1) return { ok: false, message: 'the file is empty' };
    if (size > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        message: `the file is over ${mb(MAX_UPLOAD_BYTES)}: scan it at a lower resolution`,
      };
    }
    const key = agreementDocumentKey(partyId.toLowerCase(), randomUUID(), ext);
    const grant = await getStorageWriter().createUploadGrant({
      bucket: 'uploads',
      key,
      contentType: AGREEMENT_DOCUMENT_TYPES[ext],
      bytes: size,
      expiresInSeconds: GRANT_SECONDS,
    });
    return {
      message: 'uploading the document',
      data: { url: grant.url, headers: grant.headers, key: grant.key },
    };
  });
}

/** Record a signed agreement (with the document uploaded in step 1, when there is one). */
export async function recordAgreementAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return runAction(ROLE_FOR.admin, async (session) => {
    const partyId = formText(form, 'partyId').toLowerCase();
    if (!isUuid(partyId)) return { ok: false, message: 'unknown party' };
    const v = validateAgreement(
      {
        signedOn: formText(form, 'signedOn'),
        permittedUses: form.getAll('uses').filter((u): u is string => typeof u === 'string'),
        notes: formText(form, 'notes'),
      },
      farmDate(new Date()),
    );
    if (!v.ok) return { ok: false, message: v.errors.join('; ') };
    const documentKey = formText(form, 'documentKey').trim() || null;
    if (documentKey) {
      if (!isAgreementDocumentKeyOf(documentKey, partyId)) {
        return { ok: false, message: 'that document belongs to another party' };
      }
      if (!(await getStorageWriter().stat('uploads', documentKey))) {
        return { ok: false, message: "the document didn't arrive: choose the file again" };
      }
    }
    const r = await recordAgreement(
      getPool(),
      { ...v.value, partyId, documentKey },
      { appUserId: session.appUserId },
    );
    switch (r.status) {
      case 'not_customer':
        return { ok: false, message: 'only a customer can sign a data-rights agreement' };
      case 'document_in_use':
        return { ok: false, message: 'that document is already on another agreement' };
      case 'recorded':
        revalidatePath(pathOf(partyId));
        revalidatePath('/admin/connectors');
        return {
          message: `Agreement signed ${v.value.signedOn} recorded${documentKey ? ' with its document' : ''}`,
        };
    }
  });
}

/** Revoke one of this party's agreements as of a date (default today). */
export async function revokeAgreementAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return runAction(ROLE_FOR.admin, async () => {
    const id = formText(form, 'id');
    const partyId = formText(form, 'partyId').toLowerCase();
    if (!isUuid(id) || !isUuid(partyId)) return { ok: false, message: 'unknown agreement' };
    const today = farmDate(new Date());
    const revokedOn = formText(form, 'revokedOn').trim() || today;
    const a = await getAgreement(getPool(), id);
    if (!a || a.partyId !== partyId) return { ok: false, message: 'unknown agreement' };
    const bad = validateRevocation(revokedOn, a.signedOn, today);
    if (bad) return { ok: false, message: bad };
    const r = await revokeAgreement(getPool(), { id, partyId, revokedOn });
    if (r.status === 'not_found') return { ok: false, message: 'unknown agreement' };
    if (r.status === 'already_revoked') return { ok: false, message: 'already revoked' };
    revalidatePath(pathOf(partyId));
    revalidatePath('/admin/connectors');
    return { message: `Agreement revoked as of ${revokedOn}` };
  });
}
