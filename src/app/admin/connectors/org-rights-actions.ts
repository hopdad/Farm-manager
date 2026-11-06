'use server';
/**
 * /admin/connectors' "link to customer" (D17, decision 2a-10; docs/contracts-2a.md §4.4): writes
 * the ('deere', 'party', <org>, <org>) external ref for a Deere org that has no customer party
 * yet, the same link `customerOrgParty` reads first, so an agreement can be recorded on the
 * party before the org's first fields sync. A manager (ROLE_FOR.admin), checked first, on the
 * server. An org that already resolves to a party is never re-pointed from here.
 */
import { revalidatePath } from 'next/cache';
import { getPool } from '@/db/client';
import { linkDeereOrgToParty } from '@/db/queries/agreements';
import { isUuid } from '@/domain/ids';
import { ROLE_FOR } from '@/platform/auth/types';
import type { ActionResult } from '../action-result';
import { formText, runAction } from '../fields/_lib/access';

/** Deere org ids are short tokens (digits in live, 'org-…' in the stand-in). */
const ORG_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export async function linkDeereOrgAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return runAction(ROLE_FOR.admin, async () => {
    const orgId = formText(form, 'orgId').trim();
    const partyId = formText(form, 'partyId');
    if (!ORG_ID_RE.test(orgId)) return { ok: false, message: 'unknown Deere org' };
    if (!isUuid(partyId)) return { ok: false, message: 'pick a customer' };
    const r = await linkDeereOrgToParty(getPool(), orgId, partyId);
    switch (r.status) {
      case 'not_customer':
        return { ok: false, message: 'that party is not a customer (give it the customer role)' };
      case 'already_linked':
        return { ok: false, message: `Deere org ${orgId} is already ${r.partyName}'s` };
      case 'linked':
        revalidatePath('/admin/connectors');
        return {
          message: `Deere org ${orgId} linked to ${r.partyName}: record their agreement on their page`,
        };
    }
  });
}
