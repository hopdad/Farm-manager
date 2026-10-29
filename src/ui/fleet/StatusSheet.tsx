'use client';
/**
 * The "mark down" / "back up" sheet: a modal over the board (phone and wall alike). Going down
 * needs a reason: a one-tap reason or a few words typed in. The server checks the role again
 * (ROLE_FOR.markMachineDown) and answers in plain words when it refuses.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { postMachineStatus } from './actions';
import {
  MAX_DOWN_REASON_CHARS,
  type MachineStatusResult,
  type PanelMachine,
  QUICK_DOWN_REASONS,
} from './contract';
import css from './fleet-panel.module.css';

export const reasonSlug = (r: string) => r.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function StatusSheet(props: {
  machine: PanelMachine;
  variant: 'wall' | 'phone';
  onDone(result: MachineStatusResult): void;
  onCancel(): void;
}) {
  const { machine } = props;
  const goingDown = machine.status !== 'down';
  const [quick, setQuick] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef(props.onCancel);
  cancel.current = props.onCancel;

  const reason = [quick, text.trim()].filter(Boolean).join(': ');
  const canSubmit =
    !busy && (!goingDown || (reason.length > 0 && reason.length <= MAX_DOWN_REASON_CHARS));

  // Focus the dialog once (not on every parent render: that would steal the text box's focus).
  useEffect(() => {
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const r = await postMachineStatus(
      machine.id,
      goingDown ? { status: 'down', reason } : { status: 'active' },
    );
    setBusy(false);
    if (r.ok) props.onDone(r.result);
    else setError(r.error);
  }

  return (
    <div className={css.backdrop} data-variant={props.variant}>
      <div
        ref={dialog}
        className={css.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="fleet-status-sheet"
      >
        <h2 id={titleId} className={css.sheetTitle}>
          {goingDown ? `Mark ${machine.unitNo} down` : `Mark ${machine.unitNo} back up`}
        </h2>
        {goingDown ? (
          <>
            <p className={css.sheetHint}>Why is it down? The wall shows it at once.</p>
            <fieldset className={css.chips}>
              <legend className={css.srOnly}>Reason</legend>
              {QUICK_DOWN_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={css.chip}
                  aria-pressed={quick === r}
                  data-testid={`fleet-reason-${reasonSlug(r)}`}
                  onClick={() => setQuick((q) => (q === r ? null : r))}
                >
                  {r}
                </button>
              ))}
            </fieldset>
            <label className={css.reasonLabel}>
              {quick ? 'Details (optional)' : 'Or say what happened'}
              <textarea
                className={css.reasonText}
                value={text}
                maxLength={MAX_DOWN_REASON_CHARS}
                rows={2}
                placeholder="e.g. hydraulic hose on the header"
                data-testid="fleet-reason-text"
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <div className={css.counter}>
              {reason.length}/{MAX_DOWN_REASON_CHARS}
            </div>
          </>
        ) : (
          <p className={css.sheetHint}>
            {machine.downReason ? `Down: ${machine.downReason}. ` : ''}Back in service?
          </p>
        )}
        {error && (
          <p className={css.error} role="alert" data-testid="fleet-status-error">
            {error}
          </p>
        )}
        <div className={css.sheetActions}>
          <button type="button" className={css.secondary} onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={goingDown ? css.danger : css.primary}
            disabled={!canSubmit}
            onClick={() => void submit()}
            data-testid="fleet-status-submit"
          >
            {busy ? 'Saving…' : goingDown ? 'Mark down' : 'Back up'}
          </button>
        </div>
      </div>
    </div>
  );
}
