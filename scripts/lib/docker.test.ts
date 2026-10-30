import { describe, expect, test } from 'vitest';
import {
  type ComposeUpFacts,
  type ComposeUpProbes,
  composeUpFacts,
  explainComposeUpFailure,
} from './docker';

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

describe('composeUpFacts', () => {
  /** Probes that answer as given and record which ran. */
  function probes(answers: {
    docker?: boolean;
    images?: string[] | null;
    present?: Record<string, boolean | null>;
    port?: ComposeUpFacts['dbPortState'];
    own?: boolean | null;
  }) {
    const calls: string[] = [];
    const p: ComposeUpProbes = {
      dockerAnswers: async () => {
        calls.push('docker');
        return answers.docker ?? true;
      },
      images: async () => {
        calls.push('images');
        return answers.images === undefined ? [] : answers.images;
      },
      imagePresent: async (image) => {
        calls.push(`image ${image}`);
        const present = answers.present ?? {};
        return image in present ? (present[image] as boolean | null) : true;
      },
      portState: async () => {
        calls.push('port');
        return answers.port ?? 'free';
      },
      ownDbRunning: async () => {
        calls.push('own');
        return answers.own === undefined ? false : answers.own;
      },
    };
    return { p, calls };
  }

  test('Docker not answering: no other docker call is made', async () => {
    const { p, calls } = probes({ docker: false });
    expect(await composeUpFacts(15432, p)).toMatchObject({ dockerAnswers: false });
    expect(calls).toEqual(['docker']);
  });

  test('a check that times out counts as Docker not answering, and stops the checks', async () => {
    const hung = probes({ images: ['a', 'b'], present: { a: null } });
    expect(await composeUpFacts(15432, hung.p)).toMatchObject({ dockerAnswers: false });
    expect(hung.calls).toEqual(['docker', 'images', 'image a']);
    const listHung = probes({ images: null });
    expect(await composeUpFacts(15432, listHung.p)).toMatchObject({ dockerAnswers: false });
    expect(listHung.calls).toEqual(['docker', 'images']);
    const ownHung = probes({ port: 'in_use', own: null });
    expect(await composeUpFacts(15432, ownHung.p)).toMatchObject({ dockerAnswers: false });
  });

  test('missing images are listed; our own container is asked about only for a busy port', async () => {
    const missing = probes({ images: ['a', 'b'], present: { b: false } });
    expect(await composeUpFacts(15432, missing.p)).toMatchObject({
      dockerAnswers: true,
      missingImages: ['b'],
      dbPortState: 'free',
      ownDbRunning: false,
    });
    expect(missing.calls).not.toContain('own');
    const ours = probes({ port: 'in_use', own: true });
    const facts = await composeUpFacts(15432, ours.p);
    expect(facts).toMatchObject({ dbPortState: 'in_use', ownDbRunning: true });
    expect(explainComposeUpFailure(facts)).toBe(
      "docker compose up failed: see Docker's message above.",
    );
  });
});
