/**
 * Decision 2a-8 (docs/contracts-2a.md §6): only the database triggers publish the `jobs` topic
 * from a job write; no app code under src/ calls publish('jobs', …) (data:import's one
 * invalidate lives in tools/import). And no job write publishes `fleet` or `fields`: the job
 * board's write modules import no publisher at all.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe('the jobs topic', () => {
  test("no app code publishes 'jobs' (the triggers do)", () => {
    const offenders = files(ROOT).filter((f) =>
      /\bpublish\s*\(\s*['"]jobs['"]/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  test('the job write path imports no publisher (never fleet or fields from a job write)', () => {
    const write = [
      'db/queries/work-jobs.ts',
      'db/queries/work-jobs-tx.ts',
      'db/queries/work-jobs-view.ts',
      'app/api/v1/jobs/handler.ts',
    ];
    for (const rel of write) {
      const text = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(text, rel).not.toMatch(/realtime\/publish/);
    }
  });
});
