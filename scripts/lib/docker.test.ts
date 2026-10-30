import { describe, expect, test } from 'vitest';
import { type ComposeUpFacts, explainComposeUpFailure } from './docker';

const ok: ComposeUpFacts = {
  dockerAnswers: true,
  missingImages: [],
  dbPort: 15432,
  dbPortState: 'free',
};

describe('explainComposeUpFailure', () => {
  test('a pull cut off by Docker Desktop updating is a download to retry, not a busy port', () => {
    const image = 'supabase/postgres:17.11.0.008';
    expect(explainComposeUpFailure({ ...ok, missingImages: [image] })).toMatch(
      /supabase\/postgres:17\.11\.0\.008\) did not finish downloading.*run the same command again/i,
    );
    expect(explainComposeUpFailure({ ...ok, dockerAnswers: false })).toMatch(
      /Docker stopped answering.*Engine running/,
    );
    // Docker gone is said first: the image check can't be trusted then.
    expect(
      explainComposeUpFailure({ ...ok, dockerAnswers: false, missingImages: [image] }),
    ).toMatch(/Docker stopped answering/);
  });

  test('the port is blamed only when it is taken or reserved', () => {
    expect(explainComposeUpFailure({ ...ok, dbPortState: 'in_use' })).toMatch(
      /Port 15432 \(DB_PORT in \.env\) is in use/,
    );
    expect(explainComposeUpFailure({ ...ok, dbPortState: 'reserved' })).toMatch(/15432/);
    expect(explainComposeUpFailure(ok)).toBe(
      "docker compose up failed: see Docker's message above.",
    );
  });
});
