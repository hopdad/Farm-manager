import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FIXTURE_DIR, parseSoilsArgs, resolveRun } from './soils';
import { writeFixtureRun } from './soils-fixture';
import { rawRoot } from './soils-raw';

describe('parseSoilsArgs', () => {
  test('defaults: download both counties', () => {
    expect(parseSoilsArgs([])).toEqual({
      mode: 'download',
      refresh: false,
      run: null,
      areas: ['MI091', 'MI115'],
      downloadOnly: false,
      force: false,
      help: false,
    });
  });

  test('modes and options', () => {
    expect(parseSoilsArgs(['--offline', '--run=2026-10-29.2'])).toMatchObject({
      mode: 'offline',
      run: '2026-10-29.2',
    });
    expect(parseSoilsArgs(['--fixture', '--force'])).toMatchObject({
      mode: 'fixture',
      force: true,
    });
    expect(parseSoilsArgs(['--refresh', '--areas=mi115'])).toMatchObject({
      mode: 'download',
      refresh: true,
      areas: ['MI115'],
    });
    expect(parseSoilsArgs(['--download-only'])).toMatchObject({ downloadOnly: true });
  });

  test.each([
    [['--offline', '--fixture'], /exclude each other/],
    [['--refresh', '--offline'], /exclude each other/],
    [['--run=2026-10-29'], /--run needs --offline/],
    [['--offline', '--run=../x'], /run name/],
    [['--fixture', '--download-only'], /--download-only/],
    [['--force'], /--force only applies/],
    [['--areas=MI9'], /survey area symbol/],
    [['--bogus'], /Unknown option/],
  ])('%j is refused', (argv, msg) => {
    expect(() => parseSoilsArgs(argv)).toThrow(msg);
  });
});

describe('resolveRun', () => {
  let project: string;
  beforeEach(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'farm-soils-cli-'));
  });
  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  test('--fixture opens the committed fixture', async () => {
    const run = await resolveRun(
      parseSoilsArgs(['--fixture']),
      path.resolve(import.meta.dirname, '..', '..'),
    );
    expect(run.dir).toBe(path.resolve(import.meta.dirname, '..', '..', FIXTURE_DIR));
    expect(run.index.fixture).toBeTruthy();
  });

  test('--offline: the newest complete cached run, never the network', async () => {
    await expect(resolveRun(parseSoilsArgs(['--offline']), project)).rejects.toThrow(
      /no complete soils download/,
    );
    const dir = await writeFixtureRun(rawRoot(project));
    const run = await resolveRun(parseSoilsArgs(['--offline']), project);
    expect(run.dir).toBe(dir);
    await expect(
      resolveRun(parseSoilsArgs(['--offline', '--run=2020-01-01']), project),
    ).rejects.toThrow(/no complete soils download named 2020-01-01/);
  });
});
