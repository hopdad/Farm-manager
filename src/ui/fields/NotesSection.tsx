'use client';
/**
 * The field's notes: read by everyone, edited by managers and owners (ROLE_FOR.editFieldNotes;
 * the server re-checks). Saves are optimistic on the version the edit started from: if someone
 * saved in between, the server refuses (409) and the editor shows their text next to ours, so
 * nothing is overwritten unseen. Unsaved text survives closing the panel (per tab, in memory).
 *
 * Keys: Ctrl/⌘+Enter saves; Escape leaves an unchanged editor (and never closes the panel while
 * editing).
 */
import { useEffect, useId, useState } from 'react';
import type { FieldNotes, FieldPart } from '../../domain/fields';
import css from './field-panel.module.css';
import { NOTES_MAX_CHARS, normalizeNotes } from './notes';
import { notesDrafts, saveNotesRequest } from './notes-client';
import type { NotesView } from './view-model';

type Message = { tone: 'ok' | 'warn' | 'bad'; text: string };

export function NotesSection(props: {
  fieldId: string;
  notes: NotesView;
  onChanged(parts: FieldPart[]): void;
}) {
  const { fieldId, notes, onChanged } = props;
  const restored = notes.canEdit ? notesDrafts.get(fieldId) : undefined;
  const [editing, setEditing] = useState(restored !== undefined);
  const [draft, setDraft] = useState(restored?.text ?? notes.text ?? '');
  const [base, setBase] = useState(restored?.baseVersion ?? notes.version);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | null>(
    restored ? { tone: 'warn', text: 'Unsaved changes from before: save or cancel them.' } : null,
  );
  const [theirs, setTheirs] = useState<FieldNotes | null>(null);
  // What we saved, until the refetched detail catches up (versions are fixed-width UTC ISO
  // strings, so they compare as text): no flash of the old notes after Save.
  const [saved, setSaved] = useState<FieldNotes | null>(null);
  const inputId = useId();
  const local = saved && saved.version > notes.version ? saved : null;
  const current = {
    text: local ? local.text : notes.text,
    version: local?.version ?? notes.version,
  };

  // A "Saved" note fades after a while.
  useEffect(() => {
    if (message?.tone !== 'ok') return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  const changedElsewhere = editing && !theirs && current.version !== base;
  const tooLong = (normalizeNotes(draft)?.length ?? 0) > NOTES_MAX_CHARS;
  const unchanged = normalizeNotes(draft) === current.text && base === current.version;

  const startEdit = () => {
    setDraft(current.text ?? '');
    setBase(current.version);
    setTheirs(null);
    setMessage(null);
    setEditing(true);
  };
  const cancel = () => {
    notesDrafts.clear(fieldId);
    setEditing(false);
    setTheirs(null);
    setMessage(null);
  };
  const change = (text: string) => {
    setDraft(text);
    notesDrafts.set(fieldId, { text, baseVersion: base });
  };
  const save = async () => {
    if (saving || tooLong) return;
    setSaving(true);
    setMessage(null);
    const r = await saveNotesRequest((i, init) => fetch(i, init), fieldId, draft, base);
    setSaving(false);
    switch (r.kind) {
      case 'saved':
        notesDrafts.clear(fieldId);
        setSaved(r.notes);
        setEditing(false);
        setTheirs(null);
        setMessage({ tone: 'ok', text: 'Saved.' });
        onChanged(['notes']);
        return;
      case 'conflict': {
        const who = r.notes.updatedByName ?? 'Someone';
        setBase(r.notes.version);
        setTheirs(r.notes);
        notesDrafts.set(fieldId, { text: draft, baseVersion: r.notes.version });
        setMessage({
          tone: 'warn',
          text: `${who} changed these notes while you were editing. Their text is below; yours is still in the box. Save again to replace theirs.`,
        });
        onChanged(['notes']);
        return;
      }
      case 'denied':
      case 'failed':
        setMessage({ tone: 'bad', text: r.message });
        return;
    }
  };

  return (
    <section className={css.section} data-testid="field-notes" aria-labelledby={`${inputId}-h`}>
      <h3 className={css.sectionTitle} id={`${inputId}-h`}>
        Notes
      </h3>
      {editing ? (
        <>
          <textarea
            id={inputId}
            aria-label="Field notes"
            className={css.textarea}
            value={draft}
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              } else if (e.key === 'Escape') {
                // Never let Escape close the panel over an open editor.
                e.preventDefault();
                if (unchanged) cancel();
              }
            }}
            // biome-ignore lint/a11y/noAutofocus: the person just asked to edit; focus the box.
            autoFocus
            rows={6}
            aria-describedby={`${inputId}-count`}
            data-testid="field-notes-input"
          />
          <div className={css.actions}>
            <button
              type="button"
              className={`${css.button} ${css.primary}`}
              onClick={() => void save()}
              disabled={saving || tooLong || unchanged}
              data-testid="field-notes-save"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className={css.button}
              onClick={cancel}
              disabled={saving}
              data-testid="field-notes-cancel"
            >
              Cancel
            </button>
            <span
              id={`${inputId}-count`}
              className={`${css.counter} ${tooLong ? css.bad : ''}`}
              aria-live="polite"
            >
              {draft.length >= NOTES_MAX_CHARS * 0.8
                ? `${draft.length.toLocaleString('en-US')} / ${NOTES_MAX_CHARS.toLocaleString('en-US')}`
                : ''}
            </span>
          </div>
          {changedElsewhere && (
            <p className={`${css.status} ${css.warn}`} role="status">
              These notes changed on another screen since you started. Saving will tell you before
              anything is replaced.
            </p>
          )}
          {theirs && (
            <div className={css.theirs} data-testid="field-notes-theirs">
              {theirs.text ?? '(they cleared the notes)'}
            </div>
          )}
        </>
      ) : (
        <>
          {current.text ? (
            <p className={css.notesText} data-testid="field-notes-text">
              {current.text}
            </p>
          ) : (
            <p className={css.empty} data-testid="field-notes-text">
              No notes yet.
            </p>
          )}
          {(local || notes.edited) && (
            <p className={`${css.status} ${css.muted}`}>
              {local ? 'Edited just now' : notes.edited}
            </p>
          )}
          {notes.canEdit && (
            <div className={css.actions}>
              <button
                type="button"
                className={css.button}
                onClick={startEdit}
                data-testid="field-notes-edit"
              >
                {current.text ? 'Edit notes' : 'Add notes'}
              </button>
            </div>
          )}
        </>
      )}
      {message && (
        <p
          className={`${css.status} ${css[message.tone]}`}
          role={message.tone === 'bad' ? 'alert' : 'status'}
          data-testid="field-notes-status"
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
