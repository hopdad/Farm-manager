import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { childEnv } from '../src/config';
import {
  appPort,
  descendantsOf,
  originsDrift,
  parseLaunchArgs,
  phoneUrls,
  portInUse,
  Supervisor,
  UsageError,
  usage,
  waitUntil,
  withPort,
} from './dev';

const ENV = childEnv();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const posixOnly = process.platform === 'win32' ? test.skip : test;

/** Alive and not a zombie (an orphan may wait for a non-reaping init). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
    } catch {
      return false;
    }
  }
  return true;
}

/** A child that starts a grandchild, writes the grandchild's pid to a file, and idles. */
function parentScript(opts: { ignoreTerm?: boolean } = {}): string {
  return [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'fs.writeFileSync(process.argv[1], String(g.pid));',
    opts.ignoreTerm ? "process.on('SIGTERM', () => {});" : '',
    'setInterval(() => {}, 1000);',
  ].join('\n');
}

describe('parseLaunchArgs', () => {
  test('dev flags', () => {
    expect(parseLaunchArgs(['--scenario=spray-windy', '--speed=30', '--no-clock'], 'dev')).toEqual({
      scenario: 'spray-windy',
      speed: 30,
      clock: false,
      skipBuild: false,
      help: false,
    });
    expect(parseLaunchArgs(['--port=3001'], 'dev').port).toBe(3001);
  });

  test('pilot accepts --skip-build; dev does not', () => {
    expect(parseLaunchArgs(['--skip-build'], 'pilot').skipBuild).toBe(true);
    expect(() => parseLaunchArgs(['--skip-build'], 'dev')).toThrow(UsageError);
  });

  test.each([
    ['--scenario=nope'],
    ['--speed=0'],
    ['--speed=abc'],
    ['--speed=5000'],
    ['--port=70000'],
    ['--x'],
  ])('rejects %s', (arg) => {
    expect(() => parseLaunchArgs([arg], 'dev')).toThrow(UsageError);
  });

  test('usage names the flags', () => {
    expect(usage('dev')).toMatch(/--scenario=<harvest-day\|/);
    expect(usage('pilot')).toMatch(/--skip-build/);
  });
});

describe('URLs', () => {
  test('appPort and withPort', () => {
    expect(appPort('http://localhost:3104')).toBe(3104);
    expect(appPort('http://localhost')).toBe(3000);
    expect(appPort('http://localhost:3104', 3001)).toBe(3001);
    expect(withPort('http://localhost:3000/', 3001)).toBe('http://localhost:3001');
  });

  test('phoneUrls lists each origin with the port and /m', () => {
    const urls = phoneUrls(['192.168.1.20', 'farm-pc.local'], 3000);
    expect(urls.map((u) => u.url)).toEqual([
      'http://192.168.1.20:3000/m',
      'http://farm-pc.local:3000/m',
    ]);
    expect(urls[1]?.note).toBe('mDNS name');
  });

  test('originsDrift warns only when the address set changed', () => {
    expect(originsDrift(['a', 'b'], ['b', 'a'])).toBeNull();
    expect(originsDrift(['192.168.1.20'], ['192.168.1.21'])).toMatch(/--refresh-origins/);
  });
});

describe('descendantsOf (Windows process snapshot)', () => {
  test('walks children of children, including those of an exited parent', () => {
    const rows: [number, number][] = [
      [10, 1],
      [11, 10],
      [12, 11],
      [13, 99], // 99 exited; its child still points at it
      [14, 2],
      [15, 15],
    ];
    expect(descendantsOf(rows, [10, 99]).sort()).toEqual([11, 12, 13]);
    expect(descendantsOf(rows, [15])).toEqual([]);
  });
});

describe('portInUse and waitUntil', () => {
  test('detects a listening port', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await portInUse(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await portInUse(port)).toBe(false);
  });

  test('waitUntil returns the first non-null value, or null on timeout / cancel', async () => {
    let n = 0;
    expect(
      await waitUntil(async () => (++n >= 3 ? n : null), { timeoutMs: 2_000, intervalMs: 10 }),
    ).toBe(3);
    expect(await waitUntil(async () => null, { timeoutMs: 50, intervalMs: 10 })).toBeNull();
    expect(
      await waitUntil(async () => null, {
        timeoutMs: 5_000,
        intervalMs: 10,
        cancelled: () => true,
      }),
    ).toBeNull();
  });
});

describe('Supervisor', () => {
  posixOnly('shutdown kills each child and its descendants (no orphans)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'farm-sup-'));
    const sup = new Supervisor({ log: () => {}, prefixOutput: false, graceMs: 2_000 });
    const files = ['a', 'b'].map((n) => path.join(dir, n));
    const kids = files.map((f, i) =>
      sup.start({
        name: `kid${i}`,
        command: process.execPath,
        args: ['-e', parentScript(), f],
        cwd: dir,
        env: ENV,
        critical: false,
      }),
    );
    await waitUntil(
      async () => (files.every((f) => existsSync(f) && readFileSync(f, 'utf8')) ? true : null),
      {
        timeoutMs: 5_000,
        intervalMs: 20,
      },
    );
    const grandkids = files.map((f) => Number(readFileSync(f, 'utf8')));
    for (const pid of [...kids.map((k) => k.pid), ...grandkids]) expect(alive(pid)).toBe(true);
    await sup.shutdown('test');
    expect(await sup.done).toBe(0);
    await sleep(100);
    for (const pid of [...kids.map((k) => k.pid), ...grandkids]) expect(alive(pid)).toBe(false);
  });

  posixOnly('a child that ignores SIGTERM is killed after the grace period', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'farm-sup-'));
    const file = path.join(dir, 'g');
    const sup = new Supervisor({ log: () => {}, prefixOutput: false, graceMs: 300 });
    const kid = sup.start({
      name: 'stubborn',
      command: process.execPath,
      args: ['-e', parentScript({ ignoreTerm: true }), file],
      cwd: dir,
      env: ENV,
      critical: false,
    });
    await waitUntil(async () => (existsSync(file) && readFileSync(file, 'utf8') ? true : null), {
      timeoutMs: 5_000,
      intervalMs: 20,
    });
    const grandkid = Number(readFileSync(file, 'utf8'));
    const started = Date.now();
    await sup.shutdown('test');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await sleep(100);
    expect(alive(kid.pid)).toBe(false);
    expect(alive(grandkid)).toBe(false);
  });

  test('a critical child exiting stops everything with its exit code', async () => {
    const sup = new Supervisor({ log: () => {}, prefixOutput: false, graceMs: 1_000 });
    const idle = sup.start({
      name: 'idle',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: ENV,
      critical: false,
    });
    sup.start({
      name: 'next',
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      cwd: process.cwd(),
      env: ENV,
      critical: true,
    });
    expect(await sup.done).toBe(3);
    await sleep(100);
    expect(alive(idle.pid)).toBe(false);
  });

  test('a non-critical exit is reported and the rest keeps running; run() returns the code', async () => {
    const exits: [string, number | null][] = [];
    const sup = new Supervisor({
      log: () => {},
      prefixOutput: false,
      onChildExit: (name, code) => exits.push([name, code]),
    });
    sup.start({
      name: 'sim',
      command: process.execPath,
      args: ['-e', 'process.exit(2)'],
      cwd: process.cwd(),
      env: ENV,
      critical: false,
    });
    expect(
      await sup.run({
        name: 'build',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: process.cwd(),
        env: ENV,
      }),
    ).toBe(0);
    await waitUntil(async () => (exits.length ? true : null), { timeoutMs: 3_000, intervalMs: 10 });
    expect(exits).toEqual([['sim', 2]]); // the foreground build is not reported
    expect(sup.stopping).toBe(false);
    await sup.shutdown('done');
  });

  test('a child that cannot start is reported, not thrown', async () => {
    const exits: string[] = [];
    const sup = new Supervisor({
      log: () => {},
      prefixOutput: false,
      onChildExit: (n) => exits.push(n),
    });
    sup.start({
      name: 'ghost',
      command: path.join(tmpdir(), 'no-such-binary-farm'),
      args: [],
      cwd: process.cwd(),
      env: ENV,
      critical: false,
    });
    await waitUntil(async () => (exits.length ? true : null), { timeoutMs: 3_000, intervalMs: 10 });
    expect(exits).toEqual(['ghost']);
    await sup.shutdown('done');
  });
});
