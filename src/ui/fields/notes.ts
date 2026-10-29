/**
 * Field notes: the rules both sides share (pure; the panel's editor and PUT
 * /api/fields/<id>/notes use the same ones). Saving is optimistic: the client sends back the
 * `FieldNotes.version` it edited (farm.fields.updated_at with microseconds); a different stored
 * version means someone else saved first, and the server answers 409 with their notes.
 */
import { z } from 'zod';

/** Longest notes the panel accepts (a page or two of text; the column itself is unbounded). */
export const NOTES_MAX_CHARS = 10_000;

/** FieldNotes.version: an ISO instant in UTC with up to microseconds ('…T12:00:00.123456Z'). */
export const NOTES_VERSION_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/**
 * What is stored for `text`: Windows line endings become \n, surrounding blank space goes, and
 * nothing left means no notes (null).
 */
export function normalizeNotes(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const t = text.replace(/\r\n?/g, '\n').trim();
  return t === '' ? null : t;
}

/** Body of PUT /api/fields/<id>/notes. */
export const saveNotesBodySchema = z.object({
  text: z.string().nullable(),
  version: z.string().regex(NOTES_VERSION_RE, 'version must be the FieldNotes.version you edited'),
});
export type SaveNotesBody = z.infer<typeof saveNotesBodySchema>;

export type ParsedNotesBody =
  | { ok: true; text: string | null; version: string }
  | { ok: false; error: string };

/** Validate and normalize a request body (already JSON-parsed). */
export function parseSaveNotesBody(body: unknown): ParsedNotesBody {
  const r = saveNotesBodySchema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0];
    return {
      ok: false,
      error: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid body',
    };
  }
  const text = normalizeNotes(r.data.text);
  if (text !== null && text.length > NOTES_MAX_CHARS) {
    return { ok: false, error: `notes are limited to ${NOTES_MAX_CHARS} characters` };
  }
  return { ok: true, text, version: r.data.version };
}
