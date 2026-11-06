'use client';
/**
 * The request-link card's interactive part (job-forms, decision 2a-9): the links with their use,
 * "Make a link" and Revoke. A link just made is shown here ONCE (its address and QR code): the
 * server keeps only the token's hash, so reloading the page can't show it again. The results go
 * to the page's one notice line (the party page's NoticeProvider).
 */
import { useState } from 'react';
import { ActionForm, SubmitButton } from '../../../_components/controls';
import css from '../../../admin.module.css';
import fd from '../../../fields/field-data.module.css';
import { ago, detroitTime } from '../../../format';
import {
  createRequestLinkAction,
  type MadeRequestLink,
  type RequestLinkActionResult,
  revokeRequestLinkAction,
} from './actions';
import own from './request-links.module.css';

export interface RequestLinkItem {
  id: string;
  label: string | null;
  createdAt: string;
  createdByName: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  requestsToday: number;
  requestsTotal: number;
}

export function RequestLinksCard({
  partyId,
  partyName,
  links,
  maxPerDay,
  now,
}: {
  partyId: string;
  partyName: string;
  links: RequestLinkItem[];
  maxPerDay: number;
  /** The server's clock when the page rendered (ages read the same on every screen). */
  now: string;
}) {
  const [made, setMade] = useState<MadeRequestLink | null>(null);
  const make = async (
    prev: RequestLinkActionResult | null,
    form: FormData,
  ): Promise<RequestLinkActionResult> => {
    const r = await createRequestLinkAction(prev, form);
    if (r.made) setMade(r.made);
    return r;
  };
  const at = new Date(now);
  return (
    <section className={css.card} data-testid="party-request-links">
      <h2>Request links</h2>
      <p className={css.muted}>
        A link {partyName} can open without signing in to ask for work (up to {maxPerDay} requests a
        day). Each request lands on the board as a requested job. Until the app is online it only
        opens on the farm&apos;s own network.
      </p>

      {made && (
        <div className={own.made} data-testid="request-link-made" aria-live="polite">
          <p>
            <strong>Copy this link now:</strong> it is shown only once.
          </p>
          <a className={`${css.mono} ${own.url}`} href={made.url} data-testid="request-link-url">
            {made.url}
          </a>
          {made.localUrl && (
            <p className={css.muted}>
              That is this PC&apos;s shop-network address (a phone can&apos;t open localhost). On
              this PC: <span className={css.mono}>{made.localUrl}</span>
            </p>
          )}
          <svg
            viewBox={`0 0 ${made.qr.size} ${made.qr.size}`}
            role="img"
            aria-label={`QR code for ${made.url}`}
            data-testid="request-link-qr"
            shapeRendering="crispEdges"
            className={own.qr}
          >
            <path d={made.qr.path} fill="#000" />
          </svg>
          <button type="button" className={css.button} onClick={() => setMade(null)}>
            Done
          </button>
        </div>
      )}

      {links.length === 0 && <p className={css.muted}>No links yet.</p>}
      {links.length > 0 && (
        <ul className={css.events}>
          {links.map((l) => (
            <li
              key={l.id}
              className={own.link}
              data-testid="request-link-row"
              data-link-id={l.id}
              data-state={l.revokedAt ? 'revoked' : 'active'}
            >
              <div>
                <strong>{l.label ?? 'Request link'}</strong>{' '}
                <span className={`${css.badge} ${l.revokedAt ? css.idle : css.ok}`}>
                  {l.revokedAt ? 'revoked' : 'works'}
                </span>
                <div className={css.muted}>
                  Made {detroitTime(l.createdAt)}
                  {l.createdByName ? ` by ${l.createdByName}` : ''}
                  {l.revokedAt ? ` · revoked ${detroitTime(l.revokedAt)}` : ''}
                </div>
                <div className={css.muted} data-testid="request-link-used">
                  {l.lastUsedAt ? `Last used ${ago(l.lastUsedAt, at)}` : 'Never used'} ·{' '}
                  {l.requestsToday} today, {l.requestsTotal} in all
                </div>
              </div>
              {!l.revokedAt && (
                <ActionForm action={revokeRequestLinkAction}>
                  <input type="hidden" name="partyId" value={partyId} />
                  <input type="hidden" name="linkId" value={l.id} />
                  <SubmitButton
                    className={`${css.button} ${css.danger}`}
                    testId="request-link-revoke"
                  >
                    Revoke
                  </SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}

      <ActionForm action={make} className={`${fd.form} ${own.newForm}`}>
        <input type="hidden" name="partyId" value={partyId} />
        <label className={fd.label}>
          Label (optional, e.g. &quot;for Gail&apos;s phone&quot;)
          <input
            className={fd.input}
            name="label"
            maxLength={80}
            autoComplete="off"
            data-testid="request-link-label"
          />
        </label>
        <SubmitButton className={`${css.button} ${css.primary}`} testId="request-link-new">
          Make a link
        </SubmitButton>
      </ActionForm>
    </section>
  );
}
