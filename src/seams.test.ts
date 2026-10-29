/**
 * Seam rules from plan §1, checked by grepping the source (belt and braces next to Biome's
 * noProcessEnv / noRestrictedImports, which can't see every form):
 *  - nothing outside src/config.ts reads process.env
 *  - no named prepared statements (`.prepare(`) anywhere in app code
 *  - postgres.js is never imported
 *  - only src/platform/** imports @supabase/*
 *  - src/jobs/** imports no child_process and nothing from tools/gis
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const SCAN = ['src', 'scripts', 'tools', 'db', 'e2e'];
const SELF = path.join('src', 'seams.test.ts');

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(e)) out.push(p);
  }
  return out;
}

/** Remove comments (roughly) so documentation may mention the banned things. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const files = SCAN.flatMap((d) => walk(path.join(root, d)))
  .map((abs) => ({ rel: path.relative(root, abs), text: code(readFileSync(abs, 'utf8')) }))
  .filter((f) => f.rel !== SELF);

const posix = (p: string) => p.split(path.sep).join('/');
const offenders = (pred: (f: { rel: string; text: string }) => boolean) =>
  files.filter(pred).map((f) => posix(f.rel));

describe('seam rules', () => {
  test('scans something', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test('only src/config.ts reads process.env', () => {
    const envRead =
      /process\s*\.\s*env\b|process\s*\[\s*['"`]env['"`]\s*\]|\{[^}]*\benv\b[^}]*\}\s*=\s*process\b|from\s+['"](node:)?process['"]/;
    expect(offenders((f) => posix(f.rel) !== 'src/config.ts' && envRead.test(f.text))).toEqual([]);
  });

  test('no named prepared statements', () => {
    expect(offenders((f) => /\.prepare\s*\(/.test(f.text))).toEqual([]);
  });

  test('postgres.js is never imported', () => {
    expect(
      offenders((f) => /from\s+['"]postgres['"]|require\(\s*['"]postgres['"]\s*\)/.test(f.text)),
    ).toEqual([]);
  });

  test('only src/platform/** imports @supabase/*', () => {
    expect(
      offenders((f) => !posix(f.rel).startsWith('src/platform/') && /['"]@supabase\//.test(f.text)),
    ).toEqual([]);
  });

  test('src/jobs/** uses no child_process and nothing from tools/gis', () => {
    expect(
      offenders(
        (f) =>
          posix(f.rel).startsWith('src/jobs/') &&
          /['"](node:)?child_process['"]|tools\/gis/.test(f.text),
      ),
    ).toEqual([]);
  });
});
