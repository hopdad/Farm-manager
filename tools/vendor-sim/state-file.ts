/**
 * File-backed state for the stand-in: .data/vendor-sim/state.json (gitignored).
 * Written atomically (temp file + rename) on every change, so a hard kill (Windows
 * TerminateProcess, Ctrl+C in a parent) never leaves a torn file and loses nothing.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StateStore, VendorSimState } from '../../src/sim/vendors/state';

export const STATE_FILE = path.join('.data', 'vendor-sim', 'state.json');

export function fileStateStore(file: string, warn: (msg: string) => void = () => {}): StateStore {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return null;
      }
      try {
        return JSON.parse(text) as VendorSimState;
      } catch {
        warn(`ignoring unreadable ${file} (starting fresh)`);
        return null;
      }
    },
    save(state) {
      mkdirSync(path.dirname(file), { recursive: true });
      const text = `${JSON.stringify(state, null, 2)}\n`;
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, text, 'utf8');
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(tmp, file);
          return;
        } catch (e) {
          // Windows: an editor or virus scanner holding state.json open makes the rename fail
          // (EPERM/EBUSY/EACCES). Retry briefly, then write in place rather than lose the state.
          const code = (e as NodeJS.ErrnoException).code;
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) {
            rmSync(tmp, { force: true });
            throw e;
          }
          if (attempt >= 3) {
            rmSync(tmp, { force: true });
            writeFileSync(file, text, 'utf8');
            warn(`could not replace ${file} atomically (${code}); wrote it in place`);
            return;
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
        }
      }
    },
  };
}
