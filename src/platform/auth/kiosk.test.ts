/** The wall kiosk's PowerShell commands (README "First run", docs/kiosk.md, /admin/devices). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { kioskCommands } from './kiosk';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

describe('kioskCommands', () => {
  const c = kioskCommands('http://localhost:3000/enroll?code=K7QD2M9XPA');

  test('once: the kiosk profile, not in kiosk mode, on the localhost enrollment link', () => {
    expect(c.enroll).toBe(
      '& "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --no-first-run ' +
        '"--user-data-dir=$env:LOCALAPPDATA\\farm-kiosk" "http://localhost:3000/enroll?code=K7QD2M9XPA"',
    );
    expect(c.enroll).not.toContain('--kiosk');
  });

  test('afterwards: kiosk mode on the board, same profile and host', () => {
    expect(c.start).toBe(
      '& "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk --no-first-run ' +
        '--force-device-scale-factor=2 "--user-data-dir=$env:LOCALAPPDATA\\farm-kiosk" ' +
        'http://localhost:3000/board',
    );
    expect(kioskCommands('http://localhost:3001/enroll?code=X', 1).start).toMatch(
      /--force-device-scale-factor=1 .* http:\/\/localhost:3001\/board$/,
    );
  });

  test('README and docs/kiosk.md give the same commands as the panel', () => {
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    const kioskMd = readFileSync(path.join(root, 'docs', 'kiosk.md'), 'utf8');
    for (const doc of [readme, kioskMd]) {
      expect(doc).toContain(c.start);
      expect(doc).toContain(kioskCommands('http://localhost:3000/enroll?code=K7QD2M9XPA').enroll);
    }
  });
});
