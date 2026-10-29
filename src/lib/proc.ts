/**
 * Child processes that work the same on Windows, macOS and Linux:
 *  - Node tools run as `process.execPath <package's JS entry point>`, never through `.cmd`
 *    shims (Node refuses to spawn those without a shell on Windows, CVE-2024-27980).
 *  - Real executables (docker) are spawned directly, without a shell.
 * CLI-only: never import this from src/jobs/** or from app code.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** Absolute path of drizzle-kit's CLI entry (its exports map hides bin.cjs). */
export function drizzleKitBin(): string {
  return path.join(path.dirname(require.resolve('drizzle-kit')), 'bin.cjs');
}

/** Absolute path of tsx's CLI entry. */
export function tsxBin(): string {
  return require.resolve('tsx/cli');
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 'inherit' streams to this terminal; 'pipe' captures (default). */
  stdio?: 'inherit' | 'pipe';
  /** Kill after this many ms (default: none). */
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run an executable (no shell). Resolves with the exit code; never rejects on non-zero. */
export function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        stderr += `\n[timed out after ${opts.timeoutMs} ms]`;
      }, opts.timeoutMs);
    }
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Run a Node entry point with the current Node binary. */
export function runNode(entry: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(process.execPath, [entry, ...args], opts);
}

/**
 * True when the module at `importMetaUrl` is the script Node was started with (tsx included).
 * Compares real paths case-insensitively on Windows (drive-letter case, junctions).
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p: string) => {
    let real = p;
    try {
      real = realpathSync(p);
    } catch {
      // keep p
    }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return norm(fileURLToPath(importMetaUrl)) === norm(path.resolve(entry));
}
