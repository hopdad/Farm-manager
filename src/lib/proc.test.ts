import { describe, expect, test } from 'vitest';
import { run } from './proc';

describe('run', () => {
  test('timeoutMs kills the process and says so', async () => {
    const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 100000)'], {
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
  });

  test('a process that ends in time is not timed out', async () => {
    const r = await run(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      timeoutMs: 20_000,
    });
    expect(r).toMatchObject({ code: 0, stdout: 'ok', timedOut: false });
  });
});
