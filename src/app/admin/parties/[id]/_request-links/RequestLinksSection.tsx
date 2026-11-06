/**
 * A customer's request links (decision 2a-9, the stretch web form; docs/contracts-2a.md §7.6) on
 * /admin/parties/<id>: make a link (/r/<token>, shown once, with a QR code), see when it was last
 * used, revoke it. Shown for customer parties only (role customer). The page has already checked
 * ROLE_FOR.admin; every action checks again (./actions.ts).
 *
 * Owned by the job-forms builder (this folder). Props frozen (additive changes only).
 */
import { getPool } from '@/db/client';
import type { PartyDetail } from '@/db/queries/parties';
import { listRequestLinks } from '@/db/queries/request-links';
import { REQUEST_LINK_MAX_PER_DAY } from '@/domain/work-jobs';
import { RequestLinksCard } from './RequestLinksCard';

export interface RequestLinksSectionProps {
  party: PartyDetail;
}

export async function RequestLinksSection({ party }: RequestLinksSectionProps) {
  if (!party.roles.includes('customer')) return null;
  const now = new Date();
  const links = await listRequestLinks(getPool(), party.id, now);
  return (
    <RequestLinksCard
      partyId={party.id}
      partyName={party.displayName}
      links={links}
      maxPerDay={REQUEST_LINK_MAX_PER_DAY}
      now={now.toISOString()}
    />
  );
}
