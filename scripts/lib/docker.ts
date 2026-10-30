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

/** The images the compose services use. */
export async function composeImages(projectDir: string): Promise<string[]> {
  const r = await run('docker', ['compose', 'config', '--images'], { cwd: projectDir });
  return r.code === 0 ? r.stdout.split(/\s+/).filter(Boolean) : [];
}

/** Whether an image is in the local image store. */
export async function imagePresent(image: string): Promise<boolean> {
  const r = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
  return r.code === 0;
}

/** What can be checked after `docker compose up` failed (its own output streamed above). */
export interface ComposeUpFacts {
  dockerAnswers: boolean;
  /** Service images not in the local store. */
  missingImages: string[];
  dbPort: number;
  dbPortState: PortState;
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
  if (f.dbPortState === 'in_use') {
    return (
      `Port ${f.dbPort} (DB_PORT in .env) is in use by another program. Stop that program, or set ` +
      'DB_PORT in .env to a free port, then run the same command again.'
    );
  }
  if (f.dbPortState === 'reserved') return reservedPortHint(f.dbPort, 'DB_PORT in .env');
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
