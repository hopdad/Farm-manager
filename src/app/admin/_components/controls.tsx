'use client';
/**
 * Touch-friendly form controls for the admin pages. Every control is a <form> bound to a server
 * action; results go to one shared, screen-reader-announced notice line instead of a message
 * under every button.
 *
 * The submit itself reports the result, the moment the action's answer arrives, as an ordinary
 * state update (after the await, outside the form's transition). It must not come from the
 * form's useActionState state: React commits that state only with the action's whole router
 * transition, i.e. once the server has also streamed the page that revalidatePath re-renders
 * and every router refresh started meanwhile has landed (LiveRefresh refreshes on the realtime
 * events the action itself causes, e.g. the weather job it nudges). On a busy PC or CI runner
 * that page arrived 5 to 12 s after the answer and the notice sat empty all that time.
 * Reporting from the submit also keeps the result of a form that the answer removes (Unlock,
 * Revoke), and a call that rejects says why (action-failure.ts: no connection, a page from an
 * older build, a server error) instead of nothing. A press before hydration is queued by React
 * and replayed once the page is live.
 *
 * The pressed button is busy (disabled, aria-busy) from the press until that same answer, not
 * for useFormStatus's whole pending time, which is the same router transition as above.
 */
import { unstable_rethrow } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult } from '../action-result';
import css from '../admin.module.css';
import { failureNotice, type Notice } from './action-failure';

/** An admin server action as the forms call it (`prev` is always null: no action reads it). */
export type ServerAction<R extends ActionResult = ActionResult> = (
  prev: R | null,
  form: FormData,
) => Promise<R>;

type Report = (r: Notice) => void;

const NoticeContext = createContext<Report>(() => {});

/**
 * The submission of the enclosing ActionForm whose answer has arrived last: useFormStatus's
 * `data` is the very FormData the action was called with (a press and React's replay of a press
 * before hydration alike), so a button compares the two to tell whether its press is answered.
 */
const AnsweredContext = createContext<FormData | null>(null);

/** The notice line for every form below it (one per page). */
export function NoticeProvider<R extends ActionResult = ActionResult>({
  children,
  onResult,
}: {
  children: ReactNode;
  /**
   * Sees every result too (client wrappers only: functions don't cross the server boundary).
   * A failure the client reports itself (the call rejected) has only Notice's fields.
   */
  onResult?: (r: R) => void;
}) {
  const [last, setLast] = useState<Notice | null>(null);
  const report = useCallback(
    (r: Notice) => {
      setLast(r);
      onResult?.(r as R);
    },
    [onResult],
  );
  return (
    <NoticeContext.Provider value={report}>
      {children}
      <p
        role="status"
        aria-live="polite"
        data-testid="admin-notice"
        className={`${css.notice} ${last ? `${css.noticeShown} ${last.ok ? css.noticeOk : css.noticeBad}` : ''}`}
      >
        {last ? last.message : ''}
        {last?.reload && (
          <button
            type="button"
            className={`${css.button} ${css.noticeAction}`}
            data-testid="admin-notice-reload"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        )}
      </p>
    </NoticeContext.Provider>
  );
}

/** Run the action for a submitted form, then report its answer, or why there was none. */
async function submit<R extends ActionResult>(
  action: ServerAction<R>,
  form: FormData,
  report: Report,
): Promise<void> {
  let r: Notice;
  try {
    r = await action(null, form);
  } catch (e) {
    // redirect() / notFound() in an action are Next's own: the router acts on them.
    unstable_rethrow(e);
    r = failureNotice(e);
  }
  report(r);
}

export function ActionForm<R extends ActionResult>({
  action,
  children,
  className,
  testId,
}: {
  action: ServerAction<R>;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const report = useContext(NoticeContext);
  const [answered, setAnswered] = useState<FormData | null>(null);
  return (
    <form
      action={(form: FormData) =>
        // Both updates come after the await, in one render: the button frees up with the notice.
        submit(action, form, (r) => {
          setAnswered(form);
          report(r);
        })
      }
      className={className}
      data-testid={testId}
    >
      <AnsweredContext.Provider value={answered}>{children}</AnsweredContext.Provider>
    </form>
  );
}

export function SubmitButton({
  children,
  className,
  name,
  value,
  pressed,
  testId,
  title,
}: {
  children: ReactNode;
  className?: string;
  name?: string;
  value?: string;
  pressed?: boolean;
  testId?: string;
  title?: string;
}) {
  const { pending, data } = useFormStatus();
  const answered = useContext(AnsweredContext);
  // Still disabled while the request is out (no double submit); free once it is answered.
  const busy = pending && data !== answered;
  return (
    <button
      type="submit"
      className={className ?? css.button}
      name={name}
      value={value}
      disabled={busy}
      aria-pressed={pressed}
      aria-busy={busy}
      data-testid={testId}
      title={title}
    >
      {children}
    </button>
  );
}
