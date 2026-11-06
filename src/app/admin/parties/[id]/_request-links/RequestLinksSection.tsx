/**
 * A customer's request links (decision 2a-9, the stretch web form; docs/contracts-2a.md §7.6) on
 * /admin/parties/<id>: make a link (/r/<token>, shown once, with a QR code), see when it was last
 * used, revoke it. Shown for customer parties. The page has already checked ROLE_FOR.admin;
 * every action checks again.
 *
 * FOUNDATION STUB, owned by the job-forms builder (this folder): renders nothing yet. Props
 * frozen (additive changes only).
 */
import type { PartyDetail } from '@/db/queries/parties';

export interface RequestLinksSectionProps {
  party: PartyDetail;
}

export async function RequestLinksSection(_props: RequestLinksSectionProps) {
  return null;
}
