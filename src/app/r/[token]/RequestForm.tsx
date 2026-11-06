'use client';
/**
 * The customer's request form on /r/<token> (job-forms, decision 2a-9): what (the kind of work),
 * where (one of their fields, or in words), when (first and last day, optional), notes, name and
 * phone. One POST (the server action) per press; the inputs keep what was typed when the server
 * says what to fix. Phone-first: 48 px targets, 16 px type (no zoom on iOS).
 */
import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import css from '../../login/login.module.css';
import { type RequestFormState, submitRequestAction } from './actions';
import { RefusedCard } from './RefusedView';
import own from './request.module.css';

interface Values {
  kind: string;
  fieldId: string;
  where: string;
  from: string;
  by: string;
  notes: string;
  name: string;
  phone: string;
}

const EMPTY: Values = {
  kind: '',
  fieldId: '',
  where: '',
  from: '',
  by: '',
  notes: '',
  name: '',
  phone: '',
};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={`${css.button} ${css.primary} ${css.wide}`}
      disabled={pending}
      aria-busy={pending}
      data-testid="request-submit"
    >
      {pending ? 'Sending…' : 'Send the request'}
    </button>
  );
}

export function RequestForm({
  token,
  kinds,
  fields,
  maxPerDay,
}: {
  token: string;
  kinds: { value: string; label: string }[];
  fields: { id: string; name: string; acres: number | null }[];
  maxPerDay: number;
}) {
  const [state, formAction] = useActionState<RequestFormState | null, FormData>(
    submitRequestAction,
    null,
  );
  const [values, setValues] = useState<Values>(EMPTY);
  const [shownDone, setShownDone] = useState<number | null>(null);
  const set = (k: keyof Values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  if (state?.status === 'refused') return <RefusedCard reason="unknown" />;
  if (state?.status === 'limit') return <RefusedCard reason="limit" />;
  if (state?.status === 'done' && shownDone !== state.at) {
    return (
      <section
        className={`${css.card} ${css.narrow}`}
        data-testid="request-done"
        role="status"
        aria-live="polite"
      >
        <h2 className={css.title}>Thanks, we have it</h2>
        <p className={css.lead}>
          Your request is on our board. We&apos;ll call {values.name || 'you'}
          {values.phone ? ` at ${values.phone}` : ''} to set it up.
        </p>
        <button
          type="button"
          className={`${css.button} ${css.wide}`}
          onClick={() => {
            setValues((v) => ({ ...EMPTY, name: v.name, phone: v.phone }));
            setShownDone(state.at);
          }}
          data-testid="request-another"
        >
          Ask for something else
        </button>
      </section>
    );
  }
  const invalid = state?.status === 'invalid' ? state : null;
  const bad = (k: keyof Values) => (invalid?.field === k ? true : undefined);

  return (
    <section className={`${css.card} ${css.narrow}`}>
      <form action={formAction} className={css.form} data-testid="request-form">
        <input type="hidden" name="token" value={token} />
        {(invalid || state?.status === 'failed') && (
          <p className={css.message} role="alert" data-testid="request-error">
            {invalid?.message ?? (state?.status === 'failed' ? state.message : '')}
          </p>
        )}
        <label className={css.label}>
          What do you need done?
          <select
            className={css.input}
            name="kind"
            required
            value={values.kind}
            onChange={set('kind')}
            aria-invalid={bad('kind')}
            data-testid="request-kind"
          >
            <option value="" disabled>
              Pick one…
            </option>
            {kinds.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        {fields.length > 0 && (
          <label className={css.label}>
            Which field?
            <select
              className={css.input}
              name="fieldId"
              value={values.fieldId}
              onChange={set('fieldId')}
              aria-invalid={bad('fieldId')}
              data-testid="request-field"
            >
              <option value="">Somewhere else (say where below)</option>
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.acres === null ? f.name : `${f.name} (${Math.round(f.acres)} ac)`}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={css.label}>
          {fields.length > 0 ? 'Where (if not one of your fields), or anything about it' : 'Where?'}
          <input
            className={css.input}
            name="where"
            maxLength={200}
            value={values.where}
            onChange={set('where')}
            aria-invalid={bad('where')}
            autoComplete="off"
            data-testid="request-where"
          />
        </label>
        <div className={own.dates}>
          <label className={css.label}>
            From (optional)
            <input
              className={css.input}
              type="date"
              name="from"
              value={values.from}
              onChange={set('from')}
              aria-invalid={bad('from')}
              data-testid="request-from"
            />
          </label>
          <label className={css.label}>
            Done by (optional)
            <input
              className={css.input}
              type="date"
              name="by"
              value={values.by}
              onChange={set('by')}
              aria-invalid={bad('by')}
              data-testid="request-by"
            />
          </label>
        </div>
        <label className={css.label}>
          Anything else (products, gate codes, timing)
          <textarea
            className={`${css.input} ${own.notes}`}
            name="notes"
            maxLength={2000}
            value={values.notes}
            onChange={set('notes')}
            aria-invalid={bad('notes')}
            data-testid="request-notes"
          />
        </label>
        <label className={css.label}>
          Your name
          <input
            className={css.input}
            name="name"
            required
            maxLength={120}
            autoComplete="name"
            value={values.name}
            onChange={set('name')}
            aria-invalid={bad('name')}
            data-testid="request-name"
          />
        </label>
        <label className={css.label}>
          A phone number we can call back
          <input
            className={css.input}
            type="tel"
            name="phone"
            required
            maxLength={40}
            autoComplete="tel"
            value={values.phone}
            onChange={set('phone')}
            aria-invalid={bad('phone')}
            data-testid="request-phone"
          />
        </label>
        <label className={own.trap} aria-hidden="true">
          Leave this empty
          <input name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
        <Submit />
        <p className={css.muted}>
          This link takes up to {maxPerDay} requests a day. Nothing is booked until we call you.
        </p>
      </form>
    </section>
  );
}
