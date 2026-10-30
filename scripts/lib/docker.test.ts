import { describe, expect, test } from 'vitest';
import { type ComposeUpFacts, explainComposeUpFailure } from './docker';

const ok: ComposeUpFacts = {
  dockerAnswers: true,
  missingImages: [],
  dbPort: 15432,
  dbPortState: 'free',
  ownDbRunning: false,
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
    const busy = explainComposeUpFailure({ ...ok, dbPortState: 'in_use' });
    expect(busy).toMatch(/Port 15432 \(DB_PORT\) is in use by another program/);
    // Moving the database means the URLs in .env.local too (env:init doesn't rewrite them).
    expect(busy).toMatch(/DB_PORT in \.env and the port in both database URLs in \.env\.local/);
    expect(explainComposeUpFailure({ ...ok, dbPortState: 'reserved' })).toMatch(
      /15432.*both database URLs in \.env\.local/,
    );
    // This project's own running container holds the port: not "another program".
    expect(explainComposeUpFailure({ ...ok, dbPortState: 'in_use', ownDbRunning: true })).toBe(
      "docker compose up failed: see Docker's message above.",
    );
    expect(explainComposeUpFailure(ok)).toBe(
      "docker compose up failed: see Docker's message above.",
    );
  });
});
