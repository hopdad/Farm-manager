import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { describe, expect, test } from 'vitest';
import { failureNotice, STALE_PAGE_MESSAGE } from './action-failure';

/** What the Flight client rejects with when the action threw (production, unminified). */
const PROD_SERVER_ERROR =
  'An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included on this error instance which may provide additional details about the nature of the error.';

describe('failureNotice', () => {
  test('an action id the server does not know: reload, a retry cannot help', () => {
    // As server-action-reducer.js throws it on x-nextjs-action-not-found: 1.
    const e = new UnrecognizedActionError(
      'Server Action "00ab" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    );
    const n = failureNotice(e);
    expect(n).toMatchObject({ ok: false, message: STALE_PAGE_MESSAGE, reload: true });
    expect(n.message).toMatch(/Reload the page/);
    expect(n.message).not.toMatch(/could not be reached/);
  });

  test('no answer at all (fetch rejected): try again', () => {
    const n = failureNotice(new TypeError('Failed to fetch'));
    expect(n).toMatchObject({
      ok: false,
      message: 'The server could not be reached (Failed to fetch). Try again.',
    });
    expect(n.reload).toBeUndefined();
  });

  test('a throw on the server: its digest, reload, no "Try again"', () => {
    const n = failureNotice(Object.assign(new Error(PROD_SERVER_ERROR), { digest: '3735928559' }));
    expect(n).toMatchObject({
      ok: false,
      message:
        'The server could not finish that (error 3735928559 in the server log). Reload the page to see what was saved.',
      reload: true,
    });
    expect(n.message).not.toMatch(/Try again/);
    // A server-side TypeError arrives with a digest too: still the server's fault, not the network.
    const typeErr = Object.assign(new TypeError('Cannot read properties of undefined'), {
      digest: '7',
    });
    expect(failureNotice(typeErr).message).toMatch(/^The server could not finish that \(error 7 /);
    expect(failureNotice(Object.assign(new Error('x'), { digest: undefined })).message).toMatch(
      /\(see the server log\)/,
    );
  });

  test('any other rejection (a proxy page, a cut stream) is a server-side failure', () => {
    const n = failureNotice(new Error('An unexpected response was received from the server.'));
    expect(n.message).toBe(
      'The server could not finish that (An unexpected response was received from the server.). Reload the page to see what was saved.',
    );
    expect(n.reload).toBe(true);
    expect(failureNotice('boom').message).toMatch(/\(boom\)/);
  });
});
