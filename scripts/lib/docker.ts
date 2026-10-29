/**
 * Docker / Docker Compose helpers for scripts. `docker` is a real executable (docker.exe on
 * Windows), so it is spawned directly without a shell.
 */
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
