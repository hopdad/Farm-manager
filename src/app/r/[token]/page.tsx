/**
 * /r/<token>: a customer's request link (job-forms, decision 2a-9; docs/contracts-2a.md §5.5).
 * Opens with no sign-in (`/r` is in PUBLIC_PAGE_PATHS): the token is the authorization. GET shows
 * a small form (what, where, when, notes, name and phone) and spends nothing; the POST (a server
 * action, ./actions.ts) creates a `requested` job for a manager to accept on the board. A revoked
 * or unknown token gets the same "this link doesn't work any more" page. Never indexed, never
 * sends the token on as a referrer.
 *
 * Until the app is online (MD), the link only opens on the farm's own network.
 */
import type { Metadata, Viewport } from 'next';
import { getConfig } from '@/config';
import { getPool } from '@/db/client';
import { REQUESTABLE_KINDS, resolveRequestLink } from '@/db/queries/request-links';
import { JOB_KIND_LABELS, REQUEST_LINK_MAX_PER_DAY } from '@/domain/work-jobs';
import css from '../../login/login.module.css';
import { RefusedView } from './RefusedView';
import { RequestForm } from './RequestForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Ask for work · Farm Ops',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b1210',
};

export default async function RequestLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let link: Awaited<ReturnType<typeof resolveRequestLink>> = null;
  try {
    link = await resolveRequestLink(getPool(), getConfig().SESSION_SECRET, token);
  } catch (e) {
    console.error('[r] lookup failed:', (e as Error).message);
    return (
      <main className={css.page} data-testid="request-page">
        <span className={css.brand}>Farm Ops</span>
        <h1 className={css.title}>Try again in a minute</h1>
        <p className={css.lead}>The farm&apos;s server didn&apos;t answer. Or call us.</p>
      </main>
    );
  }
  if (!link) return <RefusedView reason="unknown" />;
  return (
    <main className={css.page} data-testid="request-page">
      <span className={css.brand}>Farm Ops</span>
      <h1 className={css.title}>Ask us for work</h1>
      <p className={css.lead}>
        For {link.partyName}. Tell us what you need, where and when; we&apos;ll call you back to set
        it up.
      </p>
      <RequestForm
        token={token}
        kinds={REQUESTABLE_KINDS.map((k) => ({ value: k, label: JOB_KIND_LABELS[k] }))}
        fields={link.fields}
        maxPerDay={REQUEST_LINK_MAX_PER_DAY}
      />
    </main>
  );
}
