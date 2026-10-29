'use client';
/** The owner's first-run form (name + PIN twice) and the reset form (which owner + PIN twice). */
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { LoginState } from '../actions';
import css from '../login.module.css';

type Action = (prev: LoginState | null, form: FormData) => Promise<LoginState>;

function Submit({ children }: { children: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={`${css.button} ${css.primary} ${css.wide}`}
      disabled={pending}
      aria-busy={pending}
      data-testid="owner-submit"
    >
      {pending ? 'Saving…' : children}
    </button>
  );
}

function PinFields() {
  const props = {
    className: css.input,
    type: 'password',
    inputMode: 'numeric' as const,
    pattern: '[0-9]*',
    autoComplete: 'new-password',
    minLength: 4,
    maxLength: 8,
    required: true,
  };
  return (
    <>
      <label className={css.label}>
        New PIN (4 to 8 digits, not 1111 or 1234)
        <input {...props} name="pin" data-testid="owner-pin" />
      </label>
      <label className={css.label}>
        The same PIN again
        <input {...props} name="pin2" data-testid="owner-pin2" />
      </label>
    </>
  );
}

export function OwnerSetupForm({ action, code }: { action: Action; code: string }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={css.form} data-testid="owner-setup-form">
      <input type="hidden" name="code" value={code} />
      <label className={css.label}>
        Your name
        <input
          className={css.input}
          name="name"
          defaultValue="Derrick Hopson"
          autoComplete="name"
          required
          minLength={2}
          maxLength={80}
          data-testid="owner-name"
        />
      </label>
      <PinFields />
      <p className={css.message} role="alert" data-testid="owner-message">
        {state?.message ?? ''}
      </p>
      <Submit>Make me the owner</Submit>
    </form>
  );
}

export function OwnerResetForm({
  action,
  reset,
  owners,
}: {
  action: Action;
  reset: string;
  owners: { id: string; displayName: string }[];
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={css.form} data-testid="owner-reset-form">
      <input type="hidden" name="reset" value={reset} />
      <label className={css.label}>
        Owner
        <select className={css.input} name="ownerId" defaultValue={owners[0]?.id}>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.displayName}
            </option>
          ))}
        </select>
      </label>
      <PinFields />
      <p className={css.message} role="alert" data-testid="owner-message">
        {state?.message ?? ''}
      </p>
      <Submit>Set the new PIN and sign in</Submit>
    </form>
  );
}
