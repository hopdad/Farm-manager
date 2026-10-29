/**
 * The field panel's HTTP protocol, shared by the route handlers (src/app/api/fields/**) and the
 * browser (pure; no imports beyond types).
 *
 *   GET /api/fields/<id>        → 200 FieldDetail, header X-Farm-Role: <the session's role>
 *   PUT /api/fields/<id>/notes  ← { text, version } → 200 { notes } | 409 { error, notes }
 */
import type { FieldNotes } from '../../domain/fields';

/** The session's effective role, on GET /api/fields/<id> (UI hints only; the server re-checks). */
export const FIELD_ROLE_HEADER = 'x-farm-role';

export function fieldDetailUrl(fieldId: string): string {
  return `/api/fields/${encodeURIComponent(fieldId)}`;
}

export function fieldNotesUrl(fieldId: string): string {
  return `${fieldDetailUrl(fieldId)}/notes`;
}

/** 200 from PUT /api/fields/<id>/notes. */
export interface SaveNotesOk {
  notes: FieldNotes;
}

/** 409 from PUT /api/fields/<id>/notes: nothing was written; `notes` is what is stored now. */
export interface SaveNotesConflict {
  error: string;
  notes: FieldNotes;
}

/** Any other error answer of the field routes. */
export interface FieldApiError {
  error: string;
}
