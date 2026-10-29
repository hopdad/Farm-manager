/**
 * The browser side of a notes save (framework-free; unit-tested with a fake fetch), plus the
 * per-tab draft store that keeps unsaved text when the panel closes by accident (a tap on the
 * map, a switch to another field) and restores it the next time that field opens.
 */
import type { FieldNotes } from '../../domain/fields';
import {
  type FieldApiError,
  fieldNotesUrl,
  type SaveNotesConflict,
  type SaveNotesOk,
} from './protocol';

export type SaveNotesOutcome =
  | { kind: 'saved'; notes: FieldNotes }
  /** Someone saved first; `notes` is theirs (nothing of ours was written). */
  | { kind: 'conflict'; notes: FieldNotes }
  | { kind: 'denied'; message: string }
  | { kind: 'failed'; message: string };

export async function saveNotesRequest(
  fetchImpl: typeof fetch,
  fieldId: string,
  text: string,
  version: string,
): Promise<SaveNotesOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(fieldNotesUrl(fieldId), {
      method: 'PUT',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ text, version }),
    });
  } catch {
    return {
      kind: 'failed',
      message: 'Couldn’t reach the server. Check the connection and save again.',
    };
  }
  const body = (await res.json().catch(() => null)) as
    | SaveNotesOk
    | SaveNotesConflict
    | FieldApiError
    | null;
  if (res.ok && body && 'notes' in body) return { kind: 'saved', notes: body.notes };
  if (res.status === 409 && body && 'notes' in body) return { kind: 'conflict', notes: body.notes };
  if (res.status === 401) return { kind: 'denied', message: 'Sign in again to save notes.' };
  if (res.status === 403) {
    return { kind: 'denied', message: 'Only managers and owners can edit field notes.' };
  }
  if (res.status === 404) return { kind: 'failed', message: 'This field no longer exists.' };
  const detail = body && 'error' in body ? body.error : `the server answered ${res.status}`;
  return { kind: 'failed', message: `Not saved: ${detail}.` };
}

export interface NotesDraft {
  text: string;
  /** The FieldNotes.version the draft started from. */
  baseVersion: string;
}

/** Unsaved notes per field, for this tab only (never persisted, never shared). */
export class NotesDrafts {
  private readonly drafts = new Map<string, NotesDraft>();
  get(fieldId: string): NotesDraft | undefined {
    return this.drafts.get(fieldId);
  }
  set(fieldId: string, draft: NotesDraft): void {
    this.drafts.set(fieldId, draft);
  }
  clear(fieldId: string): void {
    this.drafts.delete(fieldId);
  }
}

export const notesDrafts = new NotesDrafts();
