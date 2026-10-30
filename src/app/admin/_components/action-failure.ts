/**
 * What the admin notice says when a server action call rejects instead of answering
 * (controls.tsx's submit; redirect() and notFound() never get here, the router acts on them).
 * Three cases, because only the first can be fixed by pressing again:
 *
 *  - no answer at all: fetch() rejects with a TypeError (Wi-Fi gone, the PC restarting). The
 *    action never ran: try again.
 *  - a stale page: Next answers an action id it does not know (the app was rebuilt or restarted
 *    on a new build while this page was open) with x-nextjs-action-not-found and the call
 *    rejects with UnrecognizedActionError (next/dist/client/components/router-reducer/reducers/
 *    server-action-reducer.js). Pressing again sends the same id: only a reload helps.
 *  - the server failed: the action (or Next decoding the request) threw. The rejection carries
 *    the digest the server logged it under; production builds replace its message with a
 *    generic one. Any other rejection (a proxy's 502, the stream cut mid-answer) is a server-side
 *    failure as well. A retry is likely to fail the same way, and part of it may have happened:
 *    reload to see what was saved.
 */
import { unstable_isUnrecognizedActionError } from 'next/navigation';
import { type ActionResult, actionResult } from '../action-result';

/** A notice line; `reload` adds a Reload button (the fix is a fresh page, not another press). */
export interface Notice extends ActionResult {
  reload?: boolean;
}

export const STALE_PAGE_MESSAGE =
  'This page is out of date: the app was updated or restarted after it was opened. Reload the page, then try again.';

export function failureNotice(e: unknown): Notice {
  if (unstable_isUnrecognizedActionError(e)) {
    return { ...actionResult(false, STALE_PAGE_MESSAGE), reload: true };
  }
  if (e instanceof Error && 'digest' in e) {
    // Production builds replace the server's message with React's "An error occurred in the
    // Server Components render" (minified: error #441): the digest is what finds it in the log.
    const digest = typeof e.digest === 'string' && e.digest ? e.digest : null;
    return serverFailed(digest ? `error ${digest} in the server log` : 'see the server log');
  }
  if (e instanceof TypeError) {
    return actionResult(false, `The server could not be reached (${e.message}). Try again.`);
  }
  return serverFailed(e instanceof Error && e.message ? e.message : String(e));
}

const serverFailed = (detail: string): Notice => ({
  ...actionResult(
    false,
    `The server could not finish that (${detail}). Reload the page to see what was saved.`,
  ),
  reload: true,
});
