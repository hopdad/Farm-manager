/**
 * Seam rules from plan §1, checked by grepping the source (belt and braces next to Biome's
 * noProcessEnv / noRestrictedImports, which can't see every form):
 *  - nothing outside src/config.ts reads process.env
 *  - no named prepared statements (`.prepare(`) anywhere in app code
 *  - postgres.js is never imported
 *  - only src/platform/** imports @supabase/*
 *  - src/jobs/** imports no child_process and nothing from tools/gis, directly OR transitively
 *    (following relative and @/ imports through src/), and no CLI-only module
 *  - no named pg statements (`query({ name: … })`), which the transaction pooler can't keep
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

/** Root-level TS files too (next/drizzle/vitest/playwright configs): they read config, not env. */
const rootFiles = readdirSync(root)
  .filter((e) => /\.(ts|mts|cts)$/.test(e) && !e.endsWith('.d.ts'))
  .map((e) => path.join(root, e))
  .filter((p) => statSync(p).isFile());

const files = [...SCAN.flatMap((d) => walk(path.join(root, d))), ...rootFiles]
  .map((abs) => ({ rel: path.relative(root, abs), text: code(readFileSync(abs, 'utf8')) }))
  .filter((f) => f.rel !== SELF);

const posix = (p: string) => p.split(path.sep).join('/');
const offenders = (pred: (f: { rel: string; text: string }) => boolean) =>
  files.filter(pred).map((f) => posix(f.rel));

describe('seam rules', () => {
  test('scans something', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => posix(f.rel))).toContain('playwright.config.ts');
  });

  test('only src/config.ts reads process.env', () => {
    const envRead =
      /process\s*\.\s*env\b|process\s*\[\s*['"`]env['"`]\s*\]|\{[^}]*\benv\b[^}]*\}\s*=\s*process\b|from\s+['"](node:)?process['"]/;
    expect(offenders((f) => posix(f.rel) !== 'src/config.ts' && envRead.test(f.text))).toEqual([]);
  });

  test('no named prepared statements', () => {
    expect(offenders((f) => /\.prepare\s*\(/.test(f.text))).toEqual([]);
  });

  test('no named pg statements (query({ name: … }))', () => {
    expect(offenders((f) => /\.query\s*\(\s*\{[^}]*\bname\s*:/.test(f.text))).toEqual([]);
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

  test('nothing src/jobs/** imports, however indirectly, spawns processes or loads CLI code', () => {
    const bad: string[] = [];
    for (const start of files.filter((f) => posix(f.rel).startsWith('src/jobs/'))) {
      if (/\.test\.ts$/.test(start.rel)) continue;
      for (const [rel, via] of reachable(start.rel)) {
        const p = posix(rel);
        const text = byRel.get(rel) ?? '';
        if (/['"](node:)?child_process['"]/.test(text)) bad.push(`${via} -> ${p} (child_process)`);
        if (/^(tools|scripts)\//.test(p) || /^src\/(test|lib\/proc|db\/admin)\b/.test(p)) {
          bad.push(`${via} -> ${p} (CLI/test-only module)`);
        }
        if (/['"](gdal|gdal-async)['"]/.test(text)) bad.push(`${via} -> ${p} (GDAL)`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  test('the import walker follows relative and @/ imports (self-check)', () => {
    const graph = [...reachable(path.join('src', 'db', 'leases.ts')).keys()].map(posix);
    expect(graph).toContain('src/db/exec.ts');
    expect(graph).toContain('src/connectors/types.ts');
  });
});

// ---------------------------------------------------------------------------------------------
// A tiny import-graph walker (enough for this repo's TS: relative and '@/' specifiers).
// ---------------------------------------------------------------------------------------------

const byRel = new Map(files.map((f) => [f.rel, f.text]));
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function resolveImport(fromRel: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join('src', spec.slice(2));
  else if (spec.startsWith('.')) base = path.join(path.dirname(fromRel), spec);
  else return null; // a package: checked by name above
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    const norm = path.normalize(cand);
    if (byRel.has(norm)) return norm;
    if (existsSync(path.join(root, norm)) && statSync(path.join(root, norm)).isFile()) {
      if (/\.(ts|tsx)$/.test(norm)) {
        byRel.set(norm, code(readFileSync(path.join(root, norm), 'utf8')));
        return norm;
      }
    }
  }
  return null;
}

/** Every file reachable from `startRel` through value or type imports -> the importing chain. */
function reachable(startRel: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue: [string, string][] = [[startRel, posix(startRel)]];
  while (queue.length) {
    const [rel, via] = queue.shift() as [string, string];
    const text = byRel.get(rel) ?? '';
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = resolveImport(rel, m[1] as string);
      if (target && !seen.has(target) && target !== startRel) {
        seen.set(target, via);
        queue.push([target, `${via} -> ${posix(target)}`]);
      }
    }
  }
  return seen;
}
