'use server';
/**
 * The request-link section's server actions on /admin/parties/<id> (job-forms, decision 2a-9):
 * make a link for a customer (the token comes back ONCE, with the link and its QR code; only its
 * hash is stored) and revoke one. requireRole(ROLE_FOR.admin) FIRST in each (manager and above);
 * an ActionResult, never a throw to the client.
 */
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { getConfig } from '@/config';
import { getPool } from '@/db/client';
import {
  createRequestLink,
  MAX_REQUEST_LINK_LABEL_CHARS,
  requestLinkPath,
  revokeRequestLink,
} from '@/db/queries/request-links';
import { isUuid } from '@/domain/ids';
import { enrollLinks, privateAddresses } from '@/platform/auth/lan';
import { qrSvgPath } from '@/platform/auth/qr';
import { requireRole } from '@/platform/auth/server';
import { isAuthError, ROLE_FOR, type Session } from '@/platform/auth/types';
import { type ActionResult, actionResult } from '../../../action-result';

/** A link just made: shown once on the page (the server keeps only the token's hash). */
export interface MadeRequestLink {
  linkId: string;
  label: string | null;
  /** The link to send the customer (as this browser reached the app, else a LAN address). */
  url: string;
  /** The same on this PC (localhost), when this browser used localhost. */
  localUrl: string | null;
  /** The link on the PC's other LAN addresses. */
  lanUrls: string[];
  qr: { size: number; path: string };
}

export interface RequestLinkActionResult extends ActionResult {
  made?: MadeRequestLink;
}

const text = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function attempt(
  fn: (s: Session) => Promise<RequestLinkActionResult>,
): Promise<RequestLinkActionResult> {
  let session: Session;
  try {
    session = await requireRole(ROLE_FOR.admin);
  } catch (e) {
    if (isAuthError(e)) {
      return actionResult(
        false,
        e.status === 401 ? 'Sign in first.' : 'Request links need a manager or the owner.',
      );
    }
    throw e;
  }
  try {
    return await fn(session);
  } catch (e) {
    console.error('[admin/parties request links]', (e as Error).message);
    return actionResult(false, 'That failed on the server; try again.');
  }
}

/** The origin this request came in on (the browser's view of the app). */
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const fallback = new URL(getConfig().PUBLIC_URL);
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? fallback.host;
  const proto = h.get('x-forwarded-proto') ?? fallback.protocol.replace(':', '');
  return new URL(`${proto}://${host}`).origin;
}

export async function createRequestLinkAction(
  _prev: RequestLinkActionResult | null,
  form: FormData,
): Promise<RequestLinkActionResult> {
  return attempt(async (session) => {
    const partyId = text(form, 'partyId');
    const label = text(form, 'label').slice(0, MAX_REQUEST_LINK_LABEL_CHARS) || null;
    const r = await createRequestLink(getPool(), getConfig().SESSION_SECRET, {
      partyId,
      label,
      createdBy: session.appUserId,
    });
    if (r.status === 'not_found') return actionResult(false, 'That customer no longer exists.');
    if (r.status === 'not_customer') {
      return actionResult(false, 'Request links are for customers: give them the customer role.');
    }
    const links = enrollLinks(await requestOrigin(), requestLinkPath(r.token), privateAddresses());
    revalidatePath(`/admin/parties/${partyId}`);
    return {
      ...actionResult(true, 'Link made: copy it now, it is shown only once'),
      made: {
        linkId: r.id,
        label,
        url: links.url,
        localUrl: links.localUrl,
        lanUrls: links.lanUrls,
        qr: qrSvgPath(links.url),
      },
    };
  });
}

export async function revokeRequestLinkAction(
  _prev: RequestLinkActionResult | null,
  form: FormData,
): Promise<RequestLinkActionResult> {
  return attempt(async () => {
    const partyId = text(form, 'partyId');
    const id = text(form, 'linkId');
    if (!isUuid(id) || !isUuid(partyId)) return actionResult(false, 'That link no longer exists.');
    const r = await revokeRequestLink(getPool(), { id, partyId }, new Date());
    if (r === 'not_found') return actionResult(false, 'That link no longer exists.');
    revalidatePath(`/admin/parties/${partyId}`);
    return actionResult(
      true,
      r === 'revoked' ? 'Link revoked: it no longer opens' : 'That link was already revoked',
    );
  });
}
