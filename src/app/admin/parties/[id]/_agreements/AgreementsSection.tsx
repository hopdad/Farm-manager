/**
 * The data-rights agreements of a customer (D17, decision 2a-10; docs/contracts-2a.md §7.6) on
 * /admin/parties/<id>: list, record (signed on, permitted uses, notes, the signed document
 * through the private `uploads` bucket's two-step grant) and revoke. Shown for customer
 * parties. The page has already checked ROLE_FOR.admin; every action checks again.
 *
 * FOUNDATION STUB, owned by the rights-usage builder (this folder): renders nothing yet. Props
 * frozen (additive changes only).
 */
import type { PartyDetail } from '@/db/queries/parties';

export interface AgreementsSectionProps {
  party: PartyDetail;
}

export async function AgreementsSection(_props: AgreementsSectionProps) {
  return null;
}
