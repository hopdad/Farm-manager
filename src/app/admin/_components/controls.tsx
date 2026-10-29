'use client';
/**
 * Touch-friendly form controls for the admin pages. Every control is a <form> bound to a server
 * action (works before hydration too); results go to one shared, screen-reader-announced
 * notice line instead of a message under every button.
 */
import {
  createContext,
  type ReactNode,
  useActionState,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult } from '../action-result';
import css from '../admin.module.css';

export type ServerAction = (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;

const NoticeContext = createContext<(r: ActionResult) => void>(() => {});

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [last, setLast] = useState<ActionResult | null>(null);
  return (
    <NoticeContext.Provider value={setLast}>
      {children}
      <p
        role="status"
        aria-live="polite"
        data-testid="admin-notice"
        className={`${css.notice} ${last ? `${css.noticeShown} ${last.ok ? css.noticeOk : css.noticeBad}` : ''}`}
      >
        {last ? last.message : ''}
      </p>
    </NoticeContext.Provider>
  );
}

export function ActionForm({
  action,
  children,
  className,
}: {
  action: ServerAction;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const report = useContext(NoticeContext);
  useEffect(() => {
    if (state) report(state);
  }, [state, report]);
  return (
    <form action={formAction} className={className}>
      {children}
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
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className ?? css.button}
      name={name}
      value={value}
      disabled={pending}
      aria-pressed={pressed}
      aria-busy={pending}
      data-testid={testId}
      title={title}
    >
      {children}
    </button>
  );
}
