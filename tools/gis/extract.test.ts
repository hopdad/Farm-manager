/** The Docker sequence of extractToHost, with a fake runner (no Docker needed). */
import { describe, expect, test } from 'vitest';
import type { RunOptions, RunResult } from '../../src/lib/proc';
import {
  extractArgs,
  extractToHost,
  GIS_WORK_VOLUME,
  PMTILES_IMAGE,
  VOLUME_OUTPUT,
  VOLUME_SOURCE,
} from './extract';

function fakeRunner(fail?: (args: string[]) => boolean) {
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> => {
    calls.push([cmd, ...args]);
    if (fail?.(args)) return { code: 1, stdout: '', stderr: 'boom' };
    if (args[0] === 'volume' && args[1] === 'inspect')
      return { code: 1, stdout: '', stderr: 'no such volume' };
    if (args[0] === 'create') return { code: 0, stdout: 'abc123\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

const bbox = [-84.45, 41.65, -83.1, 42.15] as const;

describe('extract', () => {
  test('extractArgs', () => {
    expect(extractArgs('n1', 'https://build.protomaps.com/20261028.pmtiles', bbox, 15)).toEqual([
      'run',
      '--rm',
      '--name',
      'n1',
      '-v',
      `${GIS_WORK_VOLUME}:/work`,
      PMTILES_IMAGE,
      'extract',
      'https://build.protomaps.com/20261028.pmtiles',
      VOLUME_OUTPUT,
      '--bbox=-84.45,41.65,-83.1,42.15',
      '--maxzoom=15',
    ]);
    expect(PMTILES_IMAGE).toBe('protomaps/go-pmtiles:v1.31.2');
    expect(GIS_WORK_VOLUME).toBe('farm-manager_gis_work');
  });

  test('a remote build: create volume, extract, verify, copy out, clean up', async () => {
    const { run, calls } = fakeRunner();
    await extractToHost({
      input: { kind: 'url', url: 'https://build.protomaps.com/20261028.pmtiles' },
      hostOut: '/tmp/out.pmtiles',
      bbox,
      maxzoom: 15,
      run,
    });
    const steps = calls.map((c) => c.slice(1, 3).join(' '));
    expect(steps).toEqual([
      'volume inspect',
      'volume create',
      'run --rm',
      'run --rm',
      'create --name',
      'cp abc123:/work/basemap-extract.pmtiles',
      'rm -f',
    ]);
    expect(calls[2]).toContain('extract');
    expect(calls[3]).toContain('verify');
    expect(calls[5]).toEqual(['docker', 'cp', `abc123:${VOLUME_OUTPUT}`, '/tmp/out.pmtiles']);
  });

  test('a local file is copied into the volume first', async () => {
    const { run, calls } = fakeRunner();
    await extractToHost({
      input: { kind: 'file', path: 'C:\\data\\planet.pmtiles' },
      hostOut: 'out.pmtiles',
      bbox,
      maxzoom: 15,
      run,
    });
    expect(calls).toContainEqual([
      'docker',
      'cp',
      'C:\\data\\planet.pmtiles',
      `abc123:${VOLUME_SOURCE}`,
    ]);
    const extract = calls.find((c) => c.includes('extract'));
    expect(extract).toContain(VOLUME_SOURCE);
  });

  test('a failing extract throws with the tool output and never copies', async () => {
    const { run, calls } = fakeRunner((args) => args.includes('extract'));
    await expect(
      extractToHost({
        input: { kind: 'url', url: 'https://x/y.pmtiles' },
        hostOut: 'o',
        bbox,
        maxzoom: 15,
        run,
      }),
    ).rejects.toThrow(/pmtiles extract failed \(exit 1\):\s+boom/);
    expect(calls.some((c) => c[1] === 'cp')).toBe(false);
  });
});
