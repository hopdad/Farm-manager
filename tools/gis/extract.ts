/**
 * `pmtiles extract` in Docker (protomaps/go-pmtiles, pinned) into the `gis_work` volume, then
 * `pmtiles verify`, then `docker cp` of the result to the host (plan §2: GIS work files live in
 * the gis_work volume, not on an NTFS bind mount; only the final file is copied to .data).
 *
 * The image is a scratch image with only the go-pmtiles binary (no shell), so every step is a
 * plain `docker run`/`create`/`cp`. Containers are named, so Ctrl+C (also on Windows) removes
 * the one that is running. `docker` is spawned directly, never through a shell.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { COMPOSE_PROJECT, dockerAvailable } from '../../scripts/lib/docker';
import { type RunOptions, type RunResult, run as runProcess } from '../../src/lib/proc';

export const PMTILES_IMAGE = 'protomaps/go-pmtiles:v1.31.2';
/** The compose volume `gis_work` (docker-compose.yml), created with compose's labels if missing. */
export const GIS_WORK_VOLUME = `${COMPOSE_PROJECT}_gis_work`;
const WORK = '/work';
export const VOLUME_SOURCE = `${WORK}/basemap-source.pmtiles`;
export const VOLUME_OUTPUT = `${WORK}/basemap-extract.pmtiles`;

export type Runner = (command: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export type ExtractInput = { kind: 'url'; url: string } | { kind: 'file'; path: string };

export interface ExtractOptions {
  input: ExtractInput;
  /** Host path the verified archive is copied to. */
  hostOut: string;
  bbox: readonly [number, number, number, number];
  maxzoom: number;
  run?: Runner;
  log?: (msg: string) => void;
}

/** `docker run` arguments of the extract step (exported for tests). */
export function extractArgs(
  name: string,
  input: string,
  bbox: readonly number[],
  maxzoom: number,
): string[] {
  return [
    'run',
    '--rm',
    '--name',
    name,
    '-v',
    `${GIS_WORK_VOLUME}:${WORK}`,
    PMTILES_IMAGE,
    'extract',
    input,
    VOLUME_OUTPUT,
    `--bbox=${bbox.join(',')}`,
    `--maxzoom=${maxzoom}`,
  ];
}

const running = new Set<string>();
let handlersInstalled = false;

function installInterruptCleanup(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const cleanup = () => {
    for (const name of running) {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', windowsHide: true });
    }
    running.clear();
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.once(sig, () => {
      cleanup();
      process.exit(130);
    });
  }
  process.once('exit', cleanup);
}

async function must(r: Promise<RunResult>, what: string): Promise<RunResult> {
  const res = await r;
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim().split('\n').slice(-5).join('\n    ');
    throw new Error(`${what} failed (exit ${res.code})${detail ? `:\n    ${detail}` : ''}`);
  }
  return res;
}

const containerName = (step: string) => `farm-gis-${step}-${randomBytes(3).toString('hex')}`;

export async function ensureGisWorkVolume(run: Runner = runProcess): Promise<void> {
  const inspect = await run('docker', ['volume', 'inspect', GIS_WORK_VOLUME]);
  if (inspect.code === 0) return;
  await must(
    run('docker', [
      'volume',
      'create',
      '--label',
      `com.docker.compose.project=${COMPOSE_PROJECT}`,
      '--label',
      'com.docker.compose.volume=gis_work',
      GIS_WORK_VOLUME,
    ]),
    `docker volume create ${GIS_WORK_VOLUME}`,
  );
}

/** Run `fn` with a created (not started) container that mounts the work volume. */
async function withVolumeContainer<T>(run: Runner, fn: (id: string) => Promise<T>): Promise<T> {
  const name = containerName('cp');
  running.add(name);
  const created = await must(
    run('docker', [
      'create',
      '--name',
      name,
      '-v',
      `${GIS_WORK_VOLUME}:${WORK}`,
      PMTILES_IMAGE,
      'version',
    ]),
    'docker create',
  );
  const id = created.stdout.trim().split(/\s+/).pop() ?? name;
  try {
    return await fn(id);
  } finally {
    await run('docker', ['rm', '-f', id]);
    running.delete(name);
  }
}

/** Extract (and verify) into the volume, then copy the archive to opts.hostOut. */
export async function extractToHost(opts: ExtractOptions): Promise<void> {
  const run = opts.run ?? runProcess;
  const log = opts.log ?? (() => {});
  if (!opts.run) {
    installInterruptCleanup();
    const docker = await dockerAvailable();
    if (!docker.ok)
      throw new Error(`Docker is not available (${docker.why}); start Docker Desktop`);
  }
  await ensureGisWorkVolume(run);

  let input: string;
  if (opts.input.kind === 'file') {
    const file = opts.input.path;
    log(`copying ${file} into the ${GIS_WORK_VOLUME} volume`);
    await withVolumeContainer(run, (id) =>
      must(run('docker', ['cp', file, `${id}:${VOLUME_SOURCE}`]), 'docker cp (source in)'),
    );
    input = VOLUME_SOURCE;
  } else {
    input = opts.input.url;
  }

  log(`pmtiles extract ${input} --bbox=${opts.bbox.join(',')} --maxzoom=${opts.maxzoom}`);
  const name = containerName('extract');
  running.add(name);
  try {
    await must(
      run('docker', extractArgs(name, input, opts.bbox, opts.maxzoom), { stdio: 'inherit' }),
      'pmtiles extract',
    );
  } finally {
    running.delete(name);
  }

  const verifyName = containerName('verify');
  running.add(verifyName);
  try {
    await must(
      run('docker', [
        'run',
        '--rm',
        '--name',
        verifyName,
        '-v',
        `${GIS_WORK_VOLUME}:${WORK}`,
        PMTILES_IMAGE,
        'verify',
        VOLUME_OUTPUT,
      ]),
      'pmtiles verify',
    );
  } finally {
    running.delete(verifyName);
  }

  await withVolumeContainer(run, (id) =>
    must(run('docker', ['cp', `${id}:${VOLUME_OUTPUT}`, opts.hostOut]), 'docker cp (extract out)'),
  );
}
