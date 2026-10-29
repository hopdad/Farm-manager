import { describe, expect, test } from 'vitest';
import { validateRegistry } from '../src/jobs/schedule';
import type { JobRegistry } from '../src/jobs/types';
import { cronJobs, emitCronSql, jobCommand, parseEmitArgs } from './jobs-emit-cron';

const run = async () => ({ items: 0 });
const reg: JobRegistry = {
  'fleet.trucks': { every: '30 seconds', run },
  'weather.nws': { cron: '*/30 * * * *', run },
  'gis.derived': { cron: '40 8 * * *', host: 'pc', run },
};

describe('jobs:emit-cron', () => {
  test('one named cron.schedule per app job; pc jobs skipped; no secret in the file', () => {
    const sql = emitCronSql(validateRegistry(reg));
    expect(sql.match(/select cron\.schedule\(/g)).toHaveLength(2);
    expect(sql).toContain("  'fleet.trucks',\n  '30 seconds',");
    expect(sql).toContain("  'weather.nws',\n  '*/30 * * * *',");
    expect(sql).not.toMatch(/cron\.schedule\(\s*'gis\.derived'/);
    expect(sql).toMatch(/Not scheduled here \(host 'pc'.*\): gis\.derived\./);
    expect(sql).toContain('timeout_milliseconds := 5000');
    expect(sql).toContain("|| '/api/jobs/fleet.trucks'");
    expect(sql).not.toMatch(/Bearer [0-9a-f]{16,}/);
    expect(sql).toContain("jobname <> all (array['fleet.trucks', 'weather.nws']::text[])");
    expect(sql.endsWith('\n')).toBe(true);
    expect(sql).not.toContain('\r');
  });

  test('deterministic output', () => {
    expect(emitCronSql(validateRegistry(reg))).toBe(emitCronSql(validateRegistry(reg)));
  });

  test('an empty registry still unschedules stale jobs', () => {
    const sql = emitCronSql([]);
    expect(sql).toContain('(no app jobs registered yet)');
    expect(sql).toContain('jobname <> all (array[]::text[])');
  });

  test('the command reads the base URL and the secret from Vault', () => {
    const cmd = jobCommand('fleet.trucks');
    expect(cmd).toMatch(/vault\.decrypted_secrets where name = 'farm_jobs_base_url'/);
    expect(cmd).toMatch(
      /'Bearer ' \|\| \(select decrypted_secret from vault\.decrypted_secrets where name = 'farm_jobs_secret'\)/,
    );
    expect(cmd).not.toContain('$job$');
  });

  test('cronJobs and args', () => {
    expect(cronJobs(validateRegistry(reg)).map((j) => j.name)).toEqual([
      'fleet.trucks',
      'weather.nws',
    ]);
    expect(parseEmitArgs(['--check'])).toEqual({ check: true, stdout: false });
    expect(() => parseEmitArgs(['--write'])).toThrow(/unknown argument/);
  });
});
