/** The doc-derived list /admin/connectors shows: every entry complete, its basis known, no repeats. */
import { expect, test } from 'vitest';
import { DOC_DERIVED } from './doc-derived';
import { CONNECTOR_SOURCES } from './types';

test('every entry names its source, what, what to confirm, where, and a known basis', () => {
  expect(DOC_DERIVED.length).toBeGreaterThan(10);
  for (const d of DOC_DERIVED) {
    expect(CONNECTOR_SOURCES).toContain(d.source);
    expect(d.what.trim().length, d.what).toBeGreaterThan(0);
    expect(d.confirm.trim().length, d.what).toBeGreaterThan(0);
    expect(d.file.trim().length, d.what).toBeGreaterThan(0);
    expect([undefined, 'spec', 'doc']).toContain(d.basis);
  }
  const keys = DOC_DERIVED.map((d) => `${d.source}|${d.what}`);
  expect(new Set(keys).size).toBe(keys.length);
  // Both kinds are present (the page tells them apart).
  expect(DOC_DERIVED.some((d) => d.basis === 'spec')).toBe(true);
  expect(DOC_DERIVED.some((d) => (d.basis ?? 'doc') === 'doc')).toBe(true);
});
