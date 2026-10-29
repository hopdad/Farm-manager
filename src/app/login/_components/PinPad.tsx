'use client';
/**
 * Pick your name, enter your PIN (D8). Works before hydration too (plain form + server action);
 * the on-screen keypad is for touch screens without a keyboard (the wall, cab iPads in gloves).
 * A failed attempt shows the server's message (wrong PIN with tries left, or locked).
 */
import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { LoginState } from '../actions';
import css from '../login.module.css';

export interface PinPerson {
  id: string;
  displayName: string;
  role: string;
  /** ISO time the person is locked until, if locked now. */
  lockedUntil: string | null;
}

type Action = (prev: LoginState | null, form: FormData) => Promise<LoginState>;

/** /login with a person preselected (names are links, so they work before hydration). */
function loginHref(next: string | null, personId: string | null): string {
  const q = new URLSearchParams();
  if (personId) q.set('person', personId);
  if (next) q.set('next', next);
  const s = q.toString();
  return s ? `/login?${s}` : '/login';
}

const MAX_DIGITS = 8;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={`${css.button} ${css.primary} ${css.wide}`}
      disabled={pending}
      aria-busy={pending}
      data-testid="pin-submit"
    >
      {pending ? 'Checking…' : label}
    </button>
  );
}

export function PinPad({
  people,
  action,
  next,
  submitLabel = 'Sign in',
  emptyText,
  initialPersonId = null,
}: {
  people: PinPerson[];
  action: Action;
  next: string | null;
  submitLabel?: string;
  emptyText: string;
  /** Preselected person (`/login?person=<id>`: how the names work before the page hydrates). */
  initialPersonId?: string | null;
}) {
  const [state, formAction] = useActionState(action, null);
  // Nobody is picked until they tap their name (or the link names them): a lone manager's name
  // must not sit pre-selected on a signed-out page, where every wrong PIN counts against them.
  const [pickedId, setPickedId] = useState<string | null>(
    people.some((p) => p.id === initialPersonId) ? (initialPersonId ?? null) : null,
  );
  const [pin, setPin] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const picked = people.find((p) => p.id === pickedId) ?? null;

  // A refused attempt clears the PIN for the next try.
  useEffect(() => {
    if (state) {
      setPin('');
      input.current?.focus();
    }
  }, [state]);

  if (people.length === 0) {
    return (
      <p className={css.muted} data-testid="pin-empty">
        {emptyText}
      </p>
    );
  }

  if (!picked) {
    return (
      <div className={css.names} data-testid="pin-names">
        {people.map((p) => (
          <a
            key={p.id}
            href={loginHref(next, p.id)}
            className={`${css.name} ${p.lockedUntil ? css.nameLocked : ''}`}
            onClick={(e) => {
              e.preventDefault();
              setPickedId(p.id);
              setPin('');
            }}
            data-testid="pin-name"
            data-person-id={p.id}
          >
            {p.displayName}
            <small>{p.lockedUntil ? 'locked for now' : p.role}</small>
          </a>
        ))}
      </div>
    );
  }

  const press = (k: (typeof KEYS)[number]) => {
    if (k === 'clear') setPin('');
    else if (k === 'back') setPin((v) => v.slice(0, -1));
    else setPin((v) => (v.length < MAX_DIGITS ? v + k : v));
  };

  return (
    <form action={formAction} className={css.form} data-testid="pin-pad">
      <div className={`${css.row} ${css.spread}`}>
        <span className={css.picked} data-testid="pin-picked">
          {picked.displayName}
        </span>
        <a
          href={loginHref(next, null)}
          className={css.button}
          onClick={(e) => {
            e.preventDefault();
            setPickedId(null);
            setPin('');
          }}
        >
          Not you?
        </a>
      </div>
      <input type="hidden" name="appUserId" value={picked.id} />
      {next && <input type="hidden" name="next" value={next} />}
      <label className={`${css.label} ${css.pinField}`}>
        PIN
        <input
          ref={input}
          className={css.input}
          name="pin"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={MAX_DIGITS}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, MAX_DIGITS))}
          data-testid="pin-input"
          // biome-ignore lint/a11y/noAutofocus: the PIN pad's only job is this field
          autoFocus
        />
      </label>
      <fieldset className={css.keys} aria-label="Keypad">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            className={css.key}
            onClick={() => press(k)}
            aria-label={k === 'back' ? 'Delete last digit' : k === 'clear' ? 'Clear' : k}
          >
            {k === 'back' ? '⌫' : k === 'clear' ? 'C' : k}
          </button>
        ))}
      </fieldset>
      <p className={css.message} role="alert" aria-live="assertive" data-testid="pin-message">
        {state?.message ?? ''}
      </p>
      <Submit label={submitLabel} />
    </form>
  );
}
