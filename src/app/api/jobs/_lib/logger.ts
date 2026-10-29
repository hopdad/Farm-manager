/**
 * JobLogger for jobs run by /api/jobs/<name>: one line per call, prefixed with the job name,
 * filtered by LOG_LEVEL. `data` is printed as compact JSON.
 */
import type { JobLogger } from '../../../../jobs/types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  log(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

function render(data?: Record<string, unknown>): string {
  if (!data || !Object.keys(data).length) return '';
  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ' [unserializable data]';
  }
}

export function createJobLogger(
  name: string,
  level: LogLevel = 'info',
  sink: LogSink = console,
): JobLogger {
  const at = (l: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (RANK[l] < RANK[level]) return;
    const line = `[job ${name}] ${msg}${render(data)}`;
    if (l === 'error') sink.error(line);
    else if (l === 'warn') sink.warn(line);
    else sink.log(line);
  };
  return {
    debug: (m, d) => at('debug', m, d),
    info: (m, d) => at('info', m, d),
    warn: (m, d) => at('warn', m, d),
    error: (m, d) => at('error', m, d),
  };
}
