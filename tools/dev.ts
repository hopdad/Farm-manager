/**
 * pnpm dev: the whole local stack in one terminal (plan §2 "Daily commands").
 *
 *   1. the vendor stand-in (tools/vendor-sim, VENDOR_SIM_URL). A stand-in this launcher starts
 *      begins the scenario day afresh (POST /_control/scenario; faults cleared; Deere grants
 *      kept) and, for harvest-day and breakdown, jumps to 08:30 when every machine is busy
 *      (LAUNCH_OFFSET_MINUTES), so every `pnpm dev` opens on a moving harvest whatever ran
 *      yesterday; --from-start begins at the scenario's start, --resume keeps the saved sim day.
 *      --speed goes through POST /_control/clock;
 *   2. `next dev -H 0.0.0.0 --port <PUBLIC_URL's port>` (phones on the LAN can reach it);
 *   3. once GET /api/health answers 200, the job clock (tools/clock) unless --no-clock or
 *      CLOCK=pgcron;
 *   4. prints the board URL and the phone URLs (DEV_ORIGINS).
 *
 *   pnpm dev --scenario=spray-windy --speed=30      a farm day in about 30 minutes
 *   pnpm dev --no-clock                             the app (and stand-in) without scheduled jobs
 *   pnpm dev --port=3001                            another port (PUBLIC_URL follows for children)
 *   pnpm dev --resume                               continue the saved sim day (.data/vendor-sim)
 *   pnpm dev --from-start                           harvest-day from 07:00 instead of 08:30
 *
 * Ctrl+C stops every child and its descendants on Windows and POSIX, without orphans:
 *  - POSIX: each child runs in its own process group (detached), and the group gets SIGTERM, then
 *    SIGKILL after a grace period.
 *  - Windows: children share this console, so Ctrl+C reaches them directly; whatever is still
 *    running after the grace period is killed as a tree with taskkill /T /F, using a process
 *    snapshot taken at shutdown (so descendants of an already-exited parent are found too).
 * Children are Node entry points run with process.execPath (never .cmd shims).
 *
 * `pnpm pilot` (tools/pilot.ts) reuses this launcher with `next build` + `next start`.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { devOriginCandidates, privateIPv4Candidates } from '../scripts/env';
import { type Config, childEnv, getConfig } from '../src/config';
import { isMainModule, tsxBin } from '../src/lib/proc';
import {
  type ClockControlRequest,
  SCENARIO_NAMES,
  type ScenarioName,
  type SimStatus,
} from '../src/sim/types';

const require = createRequire(import.meta.url);

/** The stand-in's documented entry (package.json `vendor-sim`; built by the vendors stage). */
export const VENDOR_SIM_ENTRY = path.join('tools', 'vendor-sim', 'index.ts');
export const CLOCK_ENTRY = path.join('tools', 'clock', 'index.ts');

/** Absolute path of Next's CLI entry (run with process.execPath). */
export function nextBin(): string {
  return require.resolve('next/dist/bin/next');
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

export type LaunchMode = 'dev' | 'pilot';

export interface LaunchArgs {
  scenario?: ScenarioName;
  speed?: number;
  clock: boolean;
  /** Keep the stand-in's saved sim day instead of restarting the scenario. */
  resume: boolean;
  /** Restart at the scenario's start, not at LAUNCH_OFFSET_MINUTES into it. */
  fromStart: boolean;
  port?: number;
  /** pilot only: reuse the existing production build. */
  skipBuild: boolean;
  help: boolean;
}

export class UsageError extends Error {}

export function usage(mode: LaunchMode): string {
  const extra = mode === 'pilot' ? ' [--skip-build]' : '';
  return (
    `usage: pnpm ${mode} [--scenario=<${SCENARIO_NAMES.join('|')}>] [--speed=<sim seconds per second>]` +
    ` [--resume | --from-start] [--no-clock] [--port=<n>]${extra}`
  );
}

export function parseLaunchArgs(argv: string[], mode: LaunchMode): LaunchArgs {
  const out: LaunchArgs = {
    clock: true,
    resume: false,
    fromStart: false,
    skipBuild: false,
    help: false,
  };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? undefined : arg.slice(eq + 1);
    switch (flag) {
      case '--scenario':
        if (!value || !(SCENARIO_NAMES as readonly string[]).includes(value)) {
          throw new UsageError(`--scenario must be one of ${SCENARIO_NAMES.join(', ')}`);
        }
        out.scenario = value as ScenarioName;
        break;
      case '--speed': {
        const n = Number(value);
        if (!value || !Number.isFinite(n) || n <= 0 || n > 3600) {
          throw new UsageError('--speed must be a number above 0 and at most 3600');
        }
        out.speed = n;
        break;
      }
      case '--no-clock':
        out.clock = false;
        break;
      case '--resume':
        out.resume = true;
        break;
      case '--from-start':
        out.fromStart = true;
        break;
      case '--port': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 65535)
          throw new UsageError('--port must be 1-65535');
        out.port = n;
        break;
      }
      case '--skip-build':
        if (mode !== 'pilot') throw new UsageError(`unknown argument '${arg}'\n${usage(mode)}`);
        out.skipBuild = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new UsageError(`unknown argument '${arg}'\n${usage(mode)}`);
    }
  }
  if (out.resume && out.fromStart)
    throw new UsageError('--resume and --from-start exclude each other');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Process supervision
// ---------------------------------------------------------------------------------------------

export interface ChildSpec {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** When it exits on its own, everything stops (with its exit code). */
  critical: boolean;
  /** A foreground step (next build): its exit is expected, not reported. */
  foreground?: boolean;
}

export interface Managed {
  spec: ChildSpec;
  child: ChildProcess;
  pid: number;
  exited: boolean;
  exitCode: number | null;
  done: Promise<void>;
}

export interface SupervisorOptions {
  log?: (msg: string) => void;
  platform?: NodeJS.Platform;
  /** How long children get to exit after SIGTERM / Ctrl+C before they are killed. */
  graceMs?: number;
  /** Prefix child output lines with `[name]`. */
  prefixOutput?: boolean;
  /** Called when a non-critical child exits on its own. */
  onChildExit?: (name: string, code: number | null) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Is any process of this POSIX process group (or this Windows pid) still alive? */
export function isAlive(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  // Never probe 0/negative ids: -(-1) is pid 1 and kill(-0) is our own group.
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** All descendants of `roots` in a (pid, parent pid) table (Windows keeps dead parents' ids). */
export function descendantsOf(
  rows: readonly [pid: number, ppid: number][],
  roots: number[],
): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of rows) {
    if (pid === ppid) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out = new Set<number>();
  const queue = [...roots];
  while (queue.length) {
    const p = queue.shift() as number;
    for (const c of children.get(p) ?? []) {
      if (!out.has(c) && !roots.includes(c)) {
        out.add(c);
        queue.push(c);
      }
    }
  }
  return [...out];
}

/** Windows: (pid, parent pid) of every process, via PowerShell's CIM (wmic is gone in 24H2). */
function windowsProcessTable(timeoutMs = 5_000): Promise<[number, number][]> {
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    let out = '';
    ps.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    const timer = setTimeout(() => ps.kill(), timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      const rows: [number, number][] = [];
      for (const line of out.split(/\r?\n/)) {
        const [a, b] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(a) && Number.isInteger(b)) rows.push([a as number, b as number]);
      }
      resolve(rows);
    };
    ps.on('error', finish);
    ps.on('close', finish);
  });
}

/**
 * Kill a child's whole tree. POSIX: signal its process group. Windows: taskkill /T /F (a real
 * executable, no shell); `graceful` has no meaning there (console apps only stop on Ctrl+C or
 * TerminateProcess), so Windows always forces. Synchronous, so it also works in 'exit' handlers.
 */
export function killTree(pid: number, opts: { force: boolean; platform?: NodeJS.Platform }): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  const sig = opts.force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  }
}

function pipeLines(
  stream: NodeJS.ReadableStream | null,
  out: NodeJS.WriteStream,
  prefix: string,
): void {
  if (!stream) return;
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
      out.write(`${prefix}${buf.slice(0, i + 1)}`);
      buf = buf.slice(i + 1);
    }
  });
  stream.on('end', () => {
    if (buf) out.write(`${prefix}${buf}\n`);
    buf = '';
  });
}

const COLORS: Record<string, string> = { next: '36', sim: '35', clock: '33', build: '34' };

export class Supervisor {
  private readonly log: (msg: string) => void;
  private readonly platform: NodeJS.Platform;
  private readonly graceMs: number;
  private readonly prefixOutput: boolean;
  private readonly onChildExit?: (name: string, code: number | null) => void;
  private readonly children: Managed[] = [];
  private stoppingFlag = false;
  private finished!: (code: number) => void;
  /** Resolves with the exit code once everything has stopped. */
  readonly done: Promise<number>;

  constructor(opts: SupervisorOptions = {}) {
    this.log = opts.log ?? ((m) => console.log(m));
    this.platform = opts.platform ?? process.platform;
    this.graceMs = opts.graceMs ?? 5_000;
    this.prefixOutput = opts.prefixOutput ?? true;
    this.onChildExit = opts.onChildExit;
    this.done = new Promise((r) => {
      this.finished = r;
    });
  }

  get stopping(): boolean {
    return this.stoppingFlag;
  }

  start(spec: ChildSpec): Managed {
    if (this.stoppingFlag) throw new Error('supervisor is stopping');
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: [
        'ignore',
        this.prefixOutput ? 'pipe' : 'inherit',
        this.prefixOutput ? 'pipe' : 'inherit',
      ],
      // POSIX: own process group, so the whole tree can be signalled. Windows: stay attached to
      // this console (detached would open a new window) so Ctrl+C reaches the child.
      detached: this.platform !== 'win32',
      windowsHide: false,
    });
    const tty = process.stdout.isTTY;
    const label = `[${spec.name}]`.padEnd(8);
    const prefix = tty ? `\x1b[${COLORS[spec.name] ?? '37'}m${label}\x1b[0m ` : `${label} `;
    if (this.prefixOutput) {
      pipeLines(child.stdout, process.stdout, prefix);
      pipeLines(child.stderr, process.stderr, prefix);
    }
    let resolveDone!: () => void;
    const m: Managed = {
      spec,
      child,
      pid: child.pid ?? -1,
      exited: false,
      exitCode: null,
      done: new Promise<void>((r) => {
        resolveDone = r;
      }),
    };
    const onGone = (code: number | null) => {
      if (m.exited) return;
      m.exited = true;
      m.exitCode = code;
      resolveDone();
      if (this.stoppingFlag || spec.foreground) return;
      if (spec.critical) {
        void this.shutdown(`${spec.name} exited (code ${code ?? 'signal'})`, code || 1);
      } else {
        this.onChildExit?.(spec.name, code);
      }
    };
    child.on('exit', (code) => onGone(code));
    child.on('error', (err) => {
      this.log(`${spec.name}: could not start (${err.message})`);
      onGone(1);
    });
    this.children.push(m);
    return m;
  }

  /** Run a child to completion in the foreground (e.g. `next build`); resolves its exit code. */
  async run(spec: Omit<ChildSpec, 'critical'>): Promise<number> {
    const m = this.start({ ...spec, critical: false, foreground: true });
    await m.done;
    return m.exitCode ?? 1;
  }

  /**
   * Stop every child (newest first) and its descendants, then resolve `done` with `code`.
   * `fromCtrlC`: the children got the console's Ctrl+C too (Windows), so give them the grace
   * period before forcing.
   */
  async shutdown(reason: string, code = 0, opts: { fromCtrlC?: boolean } = {}): Promise<void> {
    if (this.stoppingFlag) return;
    this.stoppingFlag = true;
    this.log(`stopping (${reason})...`);
    const live = this.children.filter((m) => !m.exited).reverse();
    if (this.platform === 'win32') await this.stopWindows(live, opts.fromCtrlC === true);
    else await this.stopPosix(live);
    this.finished(code);
  }

  /** Last resort from a process 'exit' handler: force-kill every tree synchronously. */
  killAllSync(): void {
    for (const m of this.children) {
      if (
        m.pid > 0 &&
        (!m.exited || (this.platform !== 'win32' && isAlive(m.pid, this.platform)))
      ) {
        killTree(m.pid, { force: true, platform: this.platform });
      }
    }
  }

  private async stopPosix(live: Managed[]): Promise<void> {
    // Signal whole groups: a leader that already exited may have left children behind.
    const groups = this.children.filter((m) => m.pid > 0 && isAlive(m.pid, this.platform));
    for (const m of groups) killTree(m.pid, { force: false, platform: this.platform });
    const deadline = Date.now() + this.graceMs;
    while (Date.now() < deadline && groups.some((m) => isAlive(m.pid, this.platform))) {
      await sleep(100);
    }
    for (const m of groups) {
      if (isAlive(m.pid, this.platform)) {
        this.log(`${m.spec.name} did not stop in ${this.graceMs / 1000} s; killing it`);
        killTree(m.pid, { force: true, platform: this.platform });
      }
    }
    await Promise.race([Promise.all(live.map((m) => m.done)), sleep(2_000)]);
  }

  private async stopWindows(live: Managed[], fromCtrlC: boolean): Promise<void> {
    // Only children alive now: an id of a child that exited earlier may belong to someone else.
    const roots = live.map((m) => m.pid).filter((p) => p > 0);
    // Snapshot the tree first: once a parent exits, taskkill /T can no longer find its children.
    const tablePromise = windowsProcessTable();
    if (fromCtrlC) {
      await Promise.race([Promise.all(live.map((m) => m.done)), sleep(this.graceMs)]);
    }
    const descendants = descendantsOf(await tablePromise, roots);
    for (const m of live) {
      if (!m.exited) killTree(m.pid, { force: true, platform: 'win32' });
    }
    const leftovers = descendants.filter((pid) => isAlive(pid, 'win32'));
    if (leftovers.length) {
      spawnSync('taskkill', ['/F', ...leftovers.flatMap((p) => ['/PID', String(p)])], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    await Promise.race([Promise.all(live.map((m) => m.done)), sleep(2_000)]);
  }

  /** Ctrl+C / terminal close / kill: stop everything. A second Ctrl+C forces it. */
  installSignalHandlers(): void {
    let signals = 0;
    const onSignal = (sig: NodeJS.Signals) => {
      signals++;
      if (signals > 1) {
        this.log('forcing shutdown');
        this.killAllSync();
        process.exit(130);
      }
      void this.shutdown(sig === 'SIGINT' ? 'Ctrl+C' : sig, 0, {
        fromCtrlC: sig === 'SIGINT' || sig === 'SIGBREAK',
      });
    };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const)
      process.on(sig, onSignal);
    process.on('exit', () => this.killAllSync());
  }
}

// ---------------------------------------------------------------------------------------------
// Readiness and the stand-in
// ---------------------------------------------------------------------------------------------

/** Is something accepting connections on host:port? */
export function portInUse(port: number, host = '127.0.0.1', timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Poll until `probe` returns non-null; null after timeoutMs or when `cancelled()` turns true. */
export async function waitUntil<T>(
  probe: () => Promise<T | null>,
  opts: {
    timeoutMs: number;
    intervalMs?: number;
    cancelled?: () => boolean;
    onWait?: (ms: number) => void;
  },
): Promise<T | null> {
  const started = Date.now();
  let lastNote = started;
  while (Date.now() - started < opts.timeoutMs) {
    if (opts.cancelled?.()) return null;
    const v = await probe().catch(() => null);
    if (v !== null) return v;
    if (opts.onWait && Date.now() - lastNote >= 10_000) {
      lastNote = Date.now();
      opts.onWait(Date.now() - started);
    }
    await sleep(opts.intervalMs ?? 500);
  }
  return null;
}

export interface HealthBody {
  ok: boolean;
  db: boolean;
  error?: string;
}

/** GET /api/health: the body when it answers JSON (200 or 503), else null. */
export async function getHealth(
  baseUrl: string,
  timeoutMs = 30_000,
): Promise<{ status: number; body: HealthBody } | null> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json()) as HealthBody;
    if (typeof body?.ok !== 'boolean') return null;
    return { status: res.status, body };
  } catch {
    return null;
  }
}

function isSimStatus(v: unknown): v is SimStatus {
  const s = v as SimStatus | null;
  return (
    !!s && typeof s === 'object' && !!s.clock && !!s.scenario && typeof s.clock.speed === 'number'
  );
}

/** GET /_control/status of the stand-in, or null when it isn't answering like one. */
export async function standInStatus(baseUrl: string, timeoutMs = 2_000): Promise<SimStatus | null> {
  try {
    const res = await fetch(`${baseUrl}/_control/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isSimStatus(body) ? body : null;
  } catch {
    return null;
  }
}

async function postControl(baseUrl: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Minutes into a scenario a launch opens on, so the board is busy at once: at harvest-day's
 * 07:00 start the combines are still driving out (Deere reports only working machines) and the
 * semis are parked until 07:20-07:41; by 08:30 every machine is at work. Scenarios whose point
 * is their start (bad-morning's 6 a.m. outage, planting, spraying, winter) open at the start.
 */
export const LAUNCH_OFFSET_MINUTES: Partial<Record<ScenarioName, number>> = {
  'harvest-day': 90,
  breakdown: 90,
};

const detroitClock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/Detroit',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * Apply --scenario / --speed through the stand-in's control API. `restart` (a stand-in this
 * launcher started, without --resume): begin `restart.scenario` afresh, `offsetMinutes` into
 * its day, and clear manual faults, so a launch never opens on yesterday's night or a
 * forgotten "trucks API down".
 */
export async function applySimFlags(
  baseUrl: string,
  args: Pick<LaunchArgs, 'scenario' | 'speed'>,
  log: (m: string) => void,
  restart?: { scenario: ScenarioName; offsetMinutes?: number },
): Promise<void> {
  const scenario = args.scenario ?? restart?.scenario;
  if (scenario) {
    const st = (await postControl(baseUrl, '/_control/scenario', { scenario })) as {
      startsAt?: string;
    } | null;
    const offset = restart?.offsetMinutes ?? 0;
    if (offset > 0 && st?.startsAt) {
      const simTime = new Date(Date.parse(st.startsAt) + offset * 60_000).toISOString();
      await postControl(baseUrl, '/_control/clock', { action: 'jump', simTime });
      log(
        `stand-in: ${scenario} from ${detroitClock(simTime)} (${offset} min into the day; --from-start for ${detroitClock(st.startsAt)})`,
      );
    } else {
      log(`stand-in: ${scenario} from its start (clock re-anchored now)`);
    }
  }
  if (restart) {
    await postControl(baseUrl, '/_control/faults', { action: 'clear' });
  }
  if (args.speed !== undefined) {
    const req: ClockControlRequest = { action: 'speed', speed: args.speed };
    await postControl(baseUrl, '/_control/clock', req);
    log(`stand-in: speed ${args.speed}x`);
  }
}

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

/** The port Next listens on: --port, else PUBLIC_URL's, else 3000. */
export function appPort(publicUrl: string, override?: number): number {
  if (override) return override;
  return Number(new URL(publicUrl).port) || 3000;
}

/** PUBLIC_URL with another port (children must agree with the port we actually use). */
export function withPort(publicUrl: string, port: number): string {
  const u = new URL(publicUrl);
  u.port = String(port);
  return u.origin;
}

export interface PhoneUrl {
  url: string;
  note: string;
}

/** Phone URLs: DEV_ORIGINS (what next dev allows), annotated with adapter names. */
export function phoneUrls(origins: string[], port: number, pathName = '/m'): PhoneUrl[] {
  const adapters = new Map(privateIPv4Candidates().map((c) => [c.address, c.iface]));
  return origins.map((o) => ({
    url: `http://${o}:${port}${pathName}`,
    note: adapters.get(o) ?? (o.endsWith('.local') ? 'mDNS name' : 'not on this machine now'),
  }));
}

/** Warn when DEV_ORIGINS no longer matches this machine's LAN addresses (plan §2 step 2). */
export function originsDrift(configured: string[], current: string[]): string | null {
  const a = [...configured].sort().join(',');
  const b = [...current].sort().join(',');
  if (a === b) return null;
  return (
    `DEV_ORIGINS (${configured.join(', ') || 'empty'}) differs from this machine's addresses ` +
    `(${current.join(', ')}). Phones may be refused by next dev: run \`pnpm env:init --refresh-origins\` and restart.`
  );
}

function banner(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const rule = '-'.repeat(width);
  return [rule, ...lines.map((l) => ` ${l}`), rule].join('\n');
}

// ---------------------------------------------------------------------------------------------
// The launcher
// ---------------------------------------------------------------------------------------------

export async function launch(mode: LaunchMode, argv: string[]): Promise<number> {
  let args: LaunchArgs;
  try {
    args = parseLaunchArgs(argv, mode);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (args.help) {
    console.log(usage(mode));
    return 0;
  }
  const cfg: Config = getConfig();
  const say = (m: string) => console.log(`[${mode}] ${m}`);
  const dir = cfg.projectDir;
  const port = appPort(cfg.PUBLIC_URL, args.port);
  const publicUrl = withPort(cfg.PUBLIC_URL, port);
  const appBase = `http://127.0.0.1:${port}`;
  const simBase = new URL(cfg.VENDOR_SIM_URL).origin;
  const simPort = Number(new URL(simBase).port) || 80;
  const prod = mode === 'pilot';
  // Children read the same env files as the app (`next start` = production files) and agree on
  // the URLs this launcher uses, whatever their env files say.
  const env = childEnv({
    PUBLIC_URL: publicUrl,
    VENDOR_SIM_URL: simBase,
    // Offline by design (plan §6 M0 "unplug the WAN"): no anonymous usage pings from Next.
    NEXT_TELEMETRY_DISABLED: '1',
    ...(prod ? { NODE_ENV: 'production' } : {}),
    ...(process.stdout.isTTY ? { FORCE_COLOR: '1' } : {}),
  });

  if (await portInUse(port)) {
    const h = await getHealth(appBase, 3_000);
    say(
      h
        ? `Farm Ops is already running on port ${port} (another pnpm dev or pnpm pilot?). Stop it first.`
        : `port ${port} is in use by another program. Stop it, or use --port=<n>.`,
    );
    return 1;
  }

  const sup = new Supervisor({
    log: say,
    onChildExit: (name, code) =>
      say(
        name === 'sim'
          ? `the vendor stand-in exited (code ${code}); fleet data will go stale until you restart pnpm ${mode}`
          : `${name} exited (code ${code})`,
      ),
  });
  sup.installSignalHandlers();

  // 1. Vendor stand-in.
  let simNote = 'not started';
  let simChild: Managed | null = null;
  if (await portInUse(simPort, new URL(simBase).hostname)) {
    const st = await standInStatus(simBase);
    if (!st) {
      say(
        `port ${simPort} (VENDOR_SIM_URL) is in use by something that is not the vendor stand-in.`,
      );
      return 1;
    }
    say(`vendor stand-in already running at ${simBase}; reusing it`);
    simNote = 'reused';
  } else if (!existsSync(path.join(dir, VENDOR_SIM_ENTRY))) {
    say(
      `vendor stand-in not found (${VENDOR_SIM_ENTRY.split(path.sep).join('/')} arrives with the vendors stage); ` +
        'starting without it: sim-mode connectors will fail until it exists.',
    );
    simNote = 'missing';
  } else {
    // It boots the configured scenario (resuming its saved state, Deere grants included); a
    // --scenario is applied through the control API below, which keeps the grants.
    simChild = sup.start({
      name: 'sim',
      command: process.execPath,
      args: [tsxBin(), VENDOR_SIM_ENTRY],
      cwd: dir,
      env: childEnv({
        ...env,
        ...(args.speed !== undefined ? { SIM_SPEED: String(args.speed) } : {}),
      }),
      critical: false,
    });
    simNote = 'started';
  }
  if (simNote !== 'missing') {
    const st = await waitUntil(() => standInStatus(simBase), {
      timeoutMs: 60_000,
      cancelled: () => sup.stopping || simChild?.exited === true,
    });
    if (!st) {
      say(`the vendor stand-in did not answer ${simBase}/_control/status; continuing without it`);
    } else {
      // Restart the day unless --resume, or SIM_FROZEN_AT pinned the clock at boot.
      const restartScenario = args.scenario ?? cfg.SIM_SCENARIO;
      const restart =
        simNote === 'started' && !args.resume && !cfg.SIM_FROZEN_AT
          ? {
              scenario: restartScenario,
              offsetMinutes: args.fromStart ? 0 : (LAUNCH_OFFSET_MINUTES[restartScenario] ?? 0),
            }
          : undefined;
      try {
        await applySimFlags(simBase, args, say, restart);
      } catch (e) {
        say(`could not apply --scenario/--speed: ${(e as Error).message}`);
      }
    }
  } else if (args.scenario || args.speed !== undefined) {
    say('--scenario/--speed ignored: no vendor stand-in');
  }
  if (sup.stopping) return sup.done;

  // 2. Next.
  if (prod && !args.skipBuild) {
    say('building the production app (next build)...');
    const code = await sup.run({
      name: 'build',
      command: process.execPath,
      args: [nextBin(), 'build'],
      cwd: dir,
      env,
    });
    if (sup.stopping) return sup.done;
    if (code !== 0) {
      await sup.shutdown(`next build failed (code ${code})`, code || 1);
      return sup.done;
    }
  } else if (prod && !existsSync(path.join(dir, '.next', 'BUILD_ID'))) {
    say('--skip-build: no production build in .next; run without --skip-build');
    await sup.shutdown('no build', 1);
    return sup.done;
  }
  sup.start({
    name: 'next',
    command: process.execPath,
    args: [nextBin(), prod ? 'start' : 'dev', '-H', '0.0.0.0', '--port', String(port)],
    cwd: dir,
    env,
    critical: true,
  });

  // 3. Health, then the clock.
  let dbHinted = false;
  const health = await waitUntil(
    async () => {
      const h = await getHealth(appBase);
      if (h?.status === 503 && !dbHinted) {
        dbHinted = true;
        say(
          `the app is up but the database isn't (${h.body.error ?? 'no detail'}): run \`pnpm run bootstrap\``,
        );
      }
      return h?.status === 200 ? h : null;
    },
    {
      timeoutMs: 24 * 3600_000,
      intervalMs: 1_000,
      cancelled: () => sup.stopping,
      onWait: (ms) => {
        if (!dbHinted) say(`waiting for ${appBase}/api/health (${Math.round(ms / 1000)} s)...`);
      },
    },
  );
  if (!health || sup.stopping) return sup.done;

  let clockNote: string;
  if (!args.clock) clockNote = 'off (--no-clock)';
  else if (cfg.CLOCK === 'pgcron') clockNote = 'off here (CLOCK=pgcron: pg_cron fires the jobs)';
  else {
    sup.start({
      name: 'clock',
      command: process.execPath,
      args: [tsxBin(), CLOCK_ENTRY, `--url=${appBase}`, `--parent=${process.pid}`],
      cwd: dir,
      env,
      critical: false,
    });
    clockNote = `on (hosts ${cfg.CLOCK_HOSTS.join(',')}); pause it on /admin/connectors`;
  }

  // 4. URLs.
  const origins = prod
    ? devOriginCandidates()
    : cfg.DEV_ORIGINS.length
      ? cfg.DEV_ORIGINS
      : devOriginCandidates();
  const st = await standInStatus(simBase);
  const lines = [
    `Farm Ops is running (${prod ? 'production build, next start' : 'next dev'})`,
    `  Board     http://localhost:${port}/board`,
    `  Admin     http://localhost:${port}/admin/connectors`,
    '  Phones on the same Wi-Fi:',
    ...phoneUrls(origins, port).map((p) => `    ${p.url.padEnd(34)} (${p.note})`),
    `  Phone check  http://<pc-ip>:${port}/api/health`,
    `  Stand-in  ${simBase}  ${st ? `${st.scenario.scenario}, ${st.clock.speed}x${st.clock.paused ? ', paused' : ''}` : simNote}`,
    `  Clock     ${clockNote}`,
    'Ctrl+C stops everything.',
  ];
  console.log(`\n${banner(lines)}\n`);
  if (!prod) {
    const drift = originsDrift(cfg.DEV_ORIGINS, devOriginCandidates());
    if (drift) say(`warning: ${drift}`);
  }
  return sup.done;
}

if (isMainModule(import.meta.url)) {
  launch('dev', process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(`[dev] error: ${e.message}`);
      process.exit(1);
    },
  );
}
