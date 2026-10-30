/**
 * Docker / Docker Compose helpers for scripts. `docker` is a real executable (docker.exe on
 * Windows), so it is spawned directly without a shell.
 */
import { type PortState, reservedPortHint } from '../../src/lib/ports';
import { run } from '../../src/lib/proc';

export const COMPOSE_PROJECT = 'farm-manager';
export const DB_SERVICE = 'db';

export async function dockerAvailable(): Promise<
  { ok: true; version: string } | { ok: false; why: string }
> {
  try {
    const r = await run('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 20_000,
    });
    if (r.code === 0 && r.stdout.trim()) return { ok: true, version: r.stdout.trim() };
    return { ok: false, why: (r.stderr || r.stdout).trim() || 'docker returned no server version' };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}

/** `docker compose <args>` in the project directory, streaming output. */
export async function compose(projectDir: string, args: string[]): Promise<number> {
  const r = await run('docker', ['compose', ...args], { cwd: projectDir, stdio: 'inherit' });
  return r.code;
}

/** How long a diagnostic docker call may take before Docker counts as not answering. */
const PROBE_TIMEOUT_MS = 15_000;

/** The images the compose services use (null: Docker didn't answer in time). */
export async function composeImages(projectDir: string): Promise<string[] | null> {
  const r = await run('docker', ['compose', 'config', '--images'], {
    cwd: projectDir,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (r.timedOut) return null;
  return r.code === 0 ? r.stdout.split(/\s+/).filter(Boolean) : [];
}

/** Whether an image is in the local image store (null: Docker didn't answer in time). */
export async function imagePresent(image: string): Promise<boolean | null> {
  const r = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (r.timedOut) return null;
  return r.code === 0;
}

/** Whether this project's db container is up (null: Docker didn't answer in time). */
export async function ownDbRunning(projectDir: string): Promise<boolean | null> {
  const ps = await run('docker', ['compose', 'ps', '-q', DB_SERVICE], {
    cwd: projectDir,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (ps.timedOut) return null;
  const id = ps.code === 0 ? (ps.stdout.trim().split(/\s+/)[0] ?? '') : '';
  if (!id) return false;
  const r = await run('docker', ['inspect', '--format', '{{.State.Status}}', id], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (r.timedOut) return null;
  return r.code === 0 && r.stdout.trim() === 'running';
}

/** The checks behind `composeUpFacts` (the real ones in scripts/db.ts; fakes in tests). */
export interface ComposeUpProbes {
  dockerAnswers(): Promise<boolean>;
  /** null: Docker didn't answer in time. */
  images(): Promise<string[] | null>;
  imagePresent(image: string): Promise<boolean | null>;
  portState(port: number): Promise<PortState>;
  ownDbRunning(): Promise<boolean | null>;
}

/**
 * Gather `ComposeUpFacts` after `docker compose up` failed. Docker first: once it doesn't answer
 * (or a check times out), no further docker call is made, so a hung daemon can't stall `db:up`.
 */
export async function composeUpFacts(
  dbPort: number,
  probes: ComposeUpProbes,
): Promise<ComposeUpFacts> {
  const facts: ComposeUpFacts = {
    dockerAnswers: await probes.dockerAnswers(),
    missingImages: [],
    dbPort,
    dbPortState: 'free',
    ownDbRunning: false,
  };
  if (!facts.dockerAnswers) return facts;
  const images = await probes.images();
  if (images === null) return { ...facts, dockerAnswers: false };
  for (const image of images) {
    const present = await probes.imagePresent(image);
    if (present === null) return { ...facts, dockerAnswers: false };
    if (!present) facts.missingImages.push(image);
  }
  facts.dbPortState = await probes.portState(dbPort);
  if (facts.dbPortState === 'in_use') {
    const own = await probes.ownDbRunning();
    if (own === null) return { ...facts, dockerAnswers: false };
    facts.ownDbRunning = own;
  }
  return facts;
}

/** What can be checked after `docker compose up` failed (its own output streamed above). */
export interface ComposeUpFacts {
  dockerAnswers: boolean;
  /** Service images not in the local store. */
  missingImages: string[];
  dbPort: number;
  dbPortState: PortState;
  /** This project's database container is running (it holds DB_PORT itself). */
  ownDbRunning: boolean;
}

/**
 * Why `docker compose up -d db` failed, most likely cause first. Docker Desktop restarting to
 * update itself mid-download ends the pull with "unexpected EOF": that is a download to retry, not
 * a port to free.
 */
export function explainComposeUpFailure(f: ComposeUpFacts): string {
  if (!f.dockerAnswers) {
    return (
      'Docker stopped answering during `docker compose up` (Docker Desktop restarting or updating ' +
      'itself?). When Docker Desktop shows "Engine running", run the same command again.'
    );
  }
  if (f.missingImages.length) {
    return (
      `The database image (${f.missingImages.join(', ')}) did not finish downloading: see ` +
      'Docker\'s message above ("unexpected EOF" or a timeout means the download was cut off, e.g. ' +
      'by a network drop or Docker Desktop restarting). Run the same command again: Docker keeps ' +
      'the layers it already has.'
    );
  }
  if (f.dbPortState === 'in_use' && !f.ownDbRunning) {
    return (
      `Port ${f.dbPort} (DB_PORT) is in use by another program (another Postgres?). Stop it, or ` +
      'set DB_PORT in .env and the port in both database URLs in .env.local, then run the same ' +
      'command again.'
    );
  }
  if (f.dbPortState === 'reserved') {
    return reservedPortHint(f.dbPort, 'DB_PORT in .env and both database URLs in .env.local');
  }
  return "docker compose up failed: see Docker's message above.";
}

/** Container id of the db service ('' when it doesn't exist). */
export async function dbContainerId(projectDir: string): Promise<string> {
  const r = await run('docker', ['compose', 'ps', '-a', '-q', DB_SERVICE], { cwd: projectDir });
  return r.code === 0 ? (r.stdout.trim().split(/\s+/)[0] ?? '') : '';
}

/** Health status of a container: 'starting' | 'healthy' | 'unhealthy' | 'none' | state name. */
export async function containerHealth(id: string): Promise<string> {
  const r = await run('docker', [
    'inspect',
    '--format',
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
    id,
  ]);
  return r.code === 0 ? r.stdout.trim() : 'missing';
}

/** Names of this project's volumes with the given compose volume key (e.g. 'pgdata'). */
export async function projectVolumes(volumeKey: string): Promise<string[]> {
  const r = await run('docker', [
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
    '--filter',
    `label=com.docker.compose.volume=${volumeKey}`,
  ]);
  return r.code === 0 ? r.stdout.split(/\s+/).filter(Boolean) : [];
}

export async function removeVolume(name: string): Promise<boolean> {
  const r = await run('docker', ['volume', 'rm', name], { stdio: 'inherit' });
  return r.code === 0;
}
