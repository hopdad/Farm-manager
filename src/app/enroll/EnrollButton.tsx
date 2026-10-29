'use client';
/** The one button that uses the code (a POST: link previews and prefetches never spend it). */
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { LoginState } from '../login/actions';
import css from '../login/login.module.css';

type Action = (prev: LoginState | null, form: FormData) => Promise<LoginState>;

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={`${css.button} ${css.primary} ${css.wide}`}
      disabled={pending}
      aria-busy={pending}
      data-testid="enroll-submit"
    >
      {pending ? 'Enrolling…' : label}
    </button>
  );
}

export function EnrollButton({
  action,
  code,
  label,
}: {
  action: Action;
  code: string;
  label: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={css.form}>
      <input type="hidden" name="code" value={code} />
      <p className={css.message} role="alert" data-testid="enroll-message">
        {state?.message ?? ''}
      </p>
      <Submit label={label} />
    </form>
  );
}
