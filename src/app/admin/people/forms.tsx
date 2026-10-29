'use client';
/**
 * Forms for the sign-in admin pages (/admin/people, /admin/devices). Like the shared admin
 * controls (one announced notice line for every result), but the result is reported from the
 * submit itself, not from the form's own state: a successful action often removes its form
 * (Unlock, Revoke), and a result held by an unmounted form would never be shown.
 */
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';
import type { ActionResult } from '../action-result';
import css from '../admin.module.css';

type Report<R extends ActionResult> = (r: R) => void;

// biome-ignore lint/suspicious/noExplicitAny: one context serves every result type
const ReportContext = createContext<Report<any>>(() => {});

/** Provides the notice line (and `onResult`: the devices page keeps the last code there). */
export function ResultProvider<R extends ActionResult>({
  children,
  onResult,
}: {
  children: ReactNode;
  /** Sees every result (client wrappers only: functions don't cross the server boundary). */
  onResult?: (r: R) => void;
}) {
  const [last, setLast] = useState<R | null>(null);
  const report = useCallback(
    (r: R) => {
      setLast(r);
      onResult?.(r);
    },
    [onResult],
  );
  return (
    <ReportContext.Provider value={report}>
      {children}
      <p
        role="status"
        aria-live="polite"
        data-testid="admin-notice"
        className={`${css.notice} ${last ? `${css.noticeShown} ${last.ok ? css.noticeOk : css.noticeBad}` : ''}`}
      >
        {last ? last.message : ''}
      </p>
    </ReportContext.Provider>
  );
}

export function ResultForm<R extends ActionResult>({
  action,
  children,
  className,
  testId,
}: {
  action: (prev: R | null, form: FormData) => Promise<R>;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const report = useContext(ReportContext) as Report<R>;
  return (
    <form
      action={async (form: FormData) => {
        report(await action(null, form));
      }}
      className={className}
      data-testid={testId}
    >
      {children}
    </form>
  );
}
