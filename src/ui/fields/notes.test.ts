import { describe, expect, test } from 'vitest';
import { NOTES_MAX_CHARS, normalizeNotes, parseSaveNotesBody } from './notes';

const VERSION = '2026-10-29T13:55:00.123456Z';

describe('normalizeNotes', () => {
  test('CRLF becomes LF, blank space around is trimmed, empty is null', () => {
    expect(normalizeNotes('  Gate code 1234\r\nWet NW corner \r\n')).toBe(
      'Gate code 1234\nWet NW corner',
    );
    expect(normalizeNotes('a\rb')).toBe('a\nb');
    expect(normalizeNotes(' \n\t ')).toBeNull();
    expect(normalizeNotes('')).toBeNull();
    expect(normalizeNotes(null)).toBeNull();
    expect(normalizeNotes(undefined)).toBeNull();
  });

  test('is idempotent', () => {
    const once = normalizeNotes(' x \r\n y ');
    expect(normalizeNotes(once)).toBe(once);
  });
});

describe('parseSaveNotesBody', () => {
  test('accepts text (or null) with the edited version', () => {
    expect(parseSaveNotesBody({ text: ' hello ', version: VERSION })).toEqual({
      ok: true,
      text: 'hello',
      version: VERSION,
    });
    expect(parseSaveNotesBody({ text: null, version: '2026-10-29T13:55:00Z' })).toEqual({
      ok: true,
      text: null,
      version: '2026-10-29T13:55:00Z',
    });
  });

  test('refuses a missing or malformed version and non-string text', () => {
    expect(parseSaveNotesBody({ text: 'x' })).toMatchObject({ ok: false });
    expect(parseSaveNotesBody({ text: 'x', version: 'yesterday' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^version: /),
    });
    expect(parseSaveNotesBody({ text: 'x', version: '2026-10-29 13:55:00+00' })).toMatchObject({
      ok: false,
    });
    expect(parseSaveNotesBody({ text: 42, version: VERSION })).toMatchObject({ ok: false });
    expect(parseSaveNotesBody(null)).toMatchObject({ ok: false });
    expect(parseSaveNotesBody('text')).toMatchObject({ ok: false });
  });

  test('limits the stored length (after trimming)', () => {
    const max = 'x'.repeat(NOTES_MAX_CHARS);
    expect(parseSaveNotesBody({ text: `  ${max}  `, version: VERSION })).toMatchObject({
      ok: true,
    });
    expect(parseSaveNotesBody({ text: `${max}y`, version: VERSION })).toEqual({
      ok: false,
      error: `notes are limited to ${NOTES_MAX_CHARS} characters`,
    });
  });
});
