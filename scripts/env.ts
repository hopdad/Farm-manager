/**
 * pnpm env:init — write .env and .env.local (plan §2 step 2). Safe to re-run.
 *
 *   .env        DB_PASSWORD (32 hex) and DB_PORT (15432); Docker Compose reads it automatically.
 *   .env.local  app secrets, database URLs, PUBLIC_URL, VENDOR_SIM_URL and DEV_ORIGINS.
 *
 * Idempotent: an existing key is never rewritten and an existing secret is never regenerated.
 * Missing keys are appended. When .env is missing but .env.local still has the database URLs,
 * the passwords are recovered from those URLs instead of being regenerated.
 *
 * Flags: --refresh-origins (recompute DEV_ORIGINS), --dry-run (print, write nothing).
 * The later full bootstrap (scripts/bootstrap.ts) imports `initEnvFiles` from here.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { isMainModule } from '../src/lib/proc';

export const DEFAULT_DB_PORT = 15432;
export const DEFAULT_PUBLIC_URL = 'http://localhost:3000';
export const DEFAULT_VENDOR_SIM_URL = 'http://127.0.0.1:4010';

export type EnvValues = Record<string, string>;

export interface InitEnvOptions {
  /** Recompute DEV_ORIGINS even when present. */
  refreshOrigins?: boolean;
  dryRun?: boolean;
  /** Injected for tests. */
  randomHex?: (bytes: number) => string;
  devOrigins?: string[];
}

export interface InitEnvReport {
  envFile: string;
  envLocalFile: string;
  /** Keys written this run, per file. */
  added: { env: string[]; envLocal: string[] };
  /** Keys filled in place (they existed but were empty) or refreshed (DEV_ORIGINS). */
  updated: string[];
  /** Final values of both files (secrets included; don't print them). */
  env: EnvValues;
  envLocal: EnvValues;
  warnings: string[];
}

/** `bytes` random bytes as lower-case hex (32 hex chars for 16 bytes). */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export interface Ipv4Candidate {
  address: string;
  iface: string;
}

/** RFC 1918 private ranges (what a phone on shop Wi-Fi can reach). */
export function isPrivateIPv4(address: string): boolean {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = 0, b = 0] = p;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Every private IPv4 on this machine, with its adapter name (Docker/WSL add virtual ones). */
export function privateIPv4Candidates(): Ipv4Candidate[] {
  const out: Ipv4Candidate[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateIPv4(a.address)) {
        out.push({ address: a.address, iface });
      }
    }
  }
  return out;
}

/** DEV_ORIGINS: every private IPv4 plus `<hostname>.local`. */
export function devOriginCandidates(): string[] {
  const host = hostname()
    .toLowerCase()
    .replace(/\.local$/, '');
  const ips = privateIPv4Candidates().map((c) => c.address);
  return [...new Set([...ips, `${host}.local`])];
}

/** Read an env file; missing file = empty. */
export function readEnvFile(file: string): { exists: boolean; text: string; values: EnvValues } {
  if (!existsSync(file)) return { exists: false, text: '', values: {} };
  const text = readFileSync(file, 'utf8');
  return { exists: true, text, values: parseEnv(text) as EnvValues };
}

function passwordFromUrl(url: string | undefined, user: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (decodeURIComponent(u.username) !== user || !u.password) return undefined;
    return decodeURIComponent(u.password);
  } catch {
    return undefined;
  }
}

export function databaseUrl(user: string, password: string, port: number | string): string {
  return `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;
}

/**
 * Demo values written into a new .env.local (docs/contracts.md §3). Delete the lines to get the
 * plan defaults (fleet.trucks every 30 s, stale after 10 min).
 */
export const DEMO_TUNING = {
  JOBS_DEMO_CADENCE: 'on',
  FLEET_STALE_SECONDS: '60',
  FLEET_STALE_SECONDS_DEERE: '900',
} as const;

interface Planned {
  env: EnvValues;
  envLocal: EnvValues;
  addedEnv: string[];
  addedLocal: string[];
  /** .env keys that existed empty and were filled in place. */
  updatedEnv: string[];
  /** .env.local keys filled in place (empty before) or refreshed (DEV_ORIGINS). */
  updated: string[];
  warnings: string[];
}

/** Pure planning step: what both files should contain, given what they contain now. */
export function planEnvFiles(
  existingEnv: EnvValues,
  existingLocal: EnvValues,
  opts: Required<Pick<InitEnvOptions, 'randomHex' | 'devOrigins'>> & { refreshOrigins?: boolean },
): Planned {
  const env: EnvValues = { ...existingEnv };
  const envLocal: EnvValues = { ...existingLocal };
  const addedEnv: string[] = [];
  const addedLocal: string[] = [];
  const updated: string[] = [];
  const warnings: string[] = [];
  const updatedEnv: string[] = [];
  // Missing key: append. Present but empty (`KEY=`): fill in place. Present: keep.
  const setEnv = (k: string, v: () => string) => {
    if (env[k] === undefined) addedEnv.push(k);
    else if (env[k] === '') updatedEnv.push(k);
    else return;
    env[k] = v();
  };
  const setLocal = (k: string, v: () => string) => {
    if (envLocal[k] === undefined) addedLocal.push(k);
    else if (envLocal[k] === '') updated.push(k);
    else return;
    envLocal[k] = v();
  };

  // .env (Docker Compose)
  setEnv(
    'DB_PASSWORD',
    () => passwordFromUrl(envLocal.DATABASE_URL_MIGRATE, 'postgres') ?? opts.randomHex(16),
  );
  setEnv('DB_PORT', () => String(DEFAULT_DB_PORT));
  const dbPassword = env.DB_PASSWORD as string;
  const dbPort = env.DB_PORT as string;

  // .env.local (everything else)
  setLocal('APP_ENV', () => 'development');
  setLocal('PUBLIC_URL', () => DEFAULT_PUBLIC_URL);
  setLocal(
    'FARM_APP_PASSWORD',
    () => passwordFromUrl(envLocal.DATABASE_URL, 'farm_app') ?? opts.randomHex(16),
  );
  setLocal('DATABASE_URL', () =>
    databaseUrl('farm_app', envLocal.FARM_APP_PASSWORD as string, dbPort),
  );
  setLocal('DATABASE_URL_MIGRATE', () => databaseUrl('postgres', dbPassword, dbPort));
  setLocal('JOBS_SECRET', () => opts.randomHex(32));
  setLocal('SESSION_SECRET', () => opts.randomHex(32));
  setLocal('TOKEN_ENC_KEY', () => opts.randomHex(32));
  setLocal('VENDOR_SIM_URL', () => DEFAULT_VENDOR_SIM_URL);
  // M0 demo tuning for the PC (sim connectors): jobs every few seconds and trucks stale after a
  // minute without a fix, so pausing the simulation or "trucks API down" shows within a minute.
  // The demo cadence is refused once a connector is sandbox/live, so it isn't added then.
  // Every mode key (1f.2: one per vendor; src/config.ts CONNECTOR_MODE_KEYS) and the deprecated
  // CONNECTOR_ELD alias. Listed here, not imported: env:init runs before a config exists.
  const realConnector = [
    'CONNECTOR_DEERE',
    'CONNECTOR_SAMSARA',
    'CONNECTOR_MOTIVE',
    'CONNECTOR_GEOTAB',
    'CONNECTOR_AEMP',
    'CONNECTOR_CNH',
    'CONNECTOR_TERMINAL',
    'CONNECTOR_WEATHER',
    'CONNECTOR_ELD',
  ].some((k) => ['sandbox', 'live'].includes(envLocal[k] ?? ''));
  if (!realConnector) setLocal('JOBS_DEMO_CADENCE', () => DEMO_TUNING.JOBS_DEMO_CADENCE);
  setLocal('FLEET_STALE_SECONDS', () => DEMO_TUNING.FLEET_STALE_SECONDS);
  setLocal('FLEET_STALE_SECONDS_DEERE', () => DEMO_TUNING.FLEET_STALE_SECONDS_DEERE);
  const origins = opts.devOrigins.join(',');
  if (envLocal.DEV_ORIGINS === undefined) {
    envLocal.DEV_ORIGINS = origins;
    addedLocal.push('DEV_ORIGINS');
  } else if (opts.refreshOrigins && envLocal.DEV_ORIGINS !== origins) {
    envLocal.DEV_ORIGINS = origins;
    updated.push('DEV_ORIGINS');
  } else if (envLocal.DEV_ORIGINS !== origins) {
    warnings.push(
      `DEV_ORIGINS differs from this machine's current addresses (${origins}); ` +
        'run `pnpm env:init --refresh-origins` if your LAN address changed.',
    );
  }

  // Consistency between the files (both are kept as they are; this only warns).
  const migratePw = passwordFromUrl(envLocal.DATABASE_URL_MIGRATE, 'postgres');
  if (migratePw !== undefined && migratePw !== dbPassword) {
    warnings.push('DATABASE_URL_MIGRATE in .env.local does not use DB_PASSWORD from .env.');
  }
  const appPw = passwordFromUrl(envLocal.DATABASE_URL, 'farm_app');
  if (appPw !== undefined && appPw !== envLocal.FARM_APP_PASSWORD) {
    warnings.push('DATABASE_URL in .env.local does not use FARM_APP_PASSWORD.');
  }
  return { env, envLocal, addedEnv, addedLocal, updatedEnv, updated, warnings };
}

const ENV_HEADER = `# .env: read by Docker Compose (database container) and by the app.
# Written by \`pnpm env:init\`. Never commit this file.
`;
const ENV_LOCAL_HEADER = `# .env.local: app secrets and URLs, read by Next and by every script via src/config.ts.
# Written by \`pnpm env:init\`; existing values are never regenerated. Never commit this file.
# Connector modes default to sim (sim|replay|sandbox|live|off): CONNECTOR_DEERE, CONNECTOR_WEATHER and one
# key per telematics vendor: CONNECTOR_SAMSARA, CONNECTOR_MOTIVE, CONNECTOR_GEOTAB, CONNECTOR_AEMP,
# CONNECTOR_CNH, CONNECTOR_TERMINAL (CONNECTOR_ELD / ELD_VENDOR still work but are deprecated).
# JOBS_DEMO_CADENCE / FLEET_STALE_SECONDS(_DEERE) below are M0 demo tuning: delete them for the plan
# defaults (trucks every 30 s, stale after 10 min); turn JOBS_DEMO_CADENCE off before going live.
`;

function quote(value: string): string {
  return /^[A-Za-z0-9_.:/@%+,=-]*$/.test(value) ? value : JSON.stringify(value);
}

/** Append missing keys (and apply updates) without touching any other line. */
function render(
  existingText: string,
  header: string,
  values: EnvValues,
  keys: string[],
  updated: string[],
): string {
  let text = existingText || header;
  for (const key of updated) {
    const re = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=).*$`, 'm');
    text = text.replace(re, `$1${quote(values[key] ?? '')}`);
  }
  const additions = keys.map((k) => `${k}=${quote(values[k] ?? '')}`);
  if (additions.length) {
    if (!text.endsWith('\n')) text += '\n';
    if (existingText)
      text += `\n# added by pnpm env:init on ${new Date().toISOString().slice(0, 10)}\n`;
    text += `${additions.join('\n')}\n`;
  }
  return text;
}

/** Create or complete .env and .env.local in `projectDir`. */
export function initEnvFiles(projectDir: string, opts: InitEnvOptions = {}): InitEnvReport {
  const envFile = path.join(projectDir, '.env');
  const envLocalFile = path.join(projectDir, '.env.local');
  const cur = readEnvFile(envFile);
  const curLocal = readEnvFile(envLocalFile);
  const plan = planEnvFiles(cur.values, curLocal.values, {
    randomHex: opts.randomHex ?? randomHex,
    devOrigins: opts.devOrigins ?? devOriginCandidates(),
    refreshOrigins: opts.refreshOrigins,
  });
  if (!opts.dryRun) {
    if (plan.addedEnv.length || plan.updatedEnv.length) {
      writeFileSync(
        envFile,
        render(cur.text, ENV_HEADER, plan.env, plan.addedEnv, plan.updatedEnv),
      );
    }
    if (plan.addedLocal.length || plan.updated.length) {
      writeFileSync(
        envLocalFile,
        render(curLocal.text, ENV_LOCAL_HEADER, plan.envLocal, plan.addedLocal, plan.updated),
        { mode: 0o600 },
      );
    }
  }
  return {
    envFile,
    envLocalFile,
    added: { env: plan.addedEnv, envLocal: plan.addedLocal },
    updated: [...plan.updatedEnv, ...plan.updated],
    env: plan.env,
    envLocal: plan.envLocal,
    warnings: plan.warnings,
  };
}

/** Human summary (no secret values). */
export function describeReport(r: InitEnvReport): string {
  const lines: string[] = [];
  const list = (keys: string[]) => (keys.length ? keys.join(', ') : 'nothing new');
  lines.push(`.env        ${list(r.added.env)}`);
  lines.push(
    `.env.local  ${list(r.added.envLocal)}${r.updated.length ? `; updated ${r.updated.join(', ')}` : ''}`,
  );
  const port = new URL(r.envLocal.PUBLIC_URL ?? DEFAULT_PUBLIC_URL).port || '3000';
  const cands = privateIPv4Candidates();
  if (cands.length) {
    lines.push('Phone URLs on the same Wi-Fi (pick the adapter of your shop network):');
    for (const c of cands) lines.push(`  http://${c.address}:${port}/m    (${c.iface})`);
  }
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

function main(argv: string[]): void {
  const report = initEnvFiles(process.cwd(), {
    refreshOrigins: argv.includes('--refresh-origins'),
    dryRun: argv.includes('--dry-run'),
  });
  console.log(describeReport(report));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
