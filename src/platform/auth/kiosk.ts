/**
 * The wall kiosk's PowerShell commands (README "First run", docs/kiosk.md), shown by the
 * /admin/devices code panel for a wall display. The kiosk is Chrome on the farm PC with its own
 * profile (`--user-data-dir`), so the flags aren't swallowed by a Chrome that is already running.
 * Cookies belong to one host AND one profile: the enrollment link must be opened in that profile,
 * on the host the kiosk later opens (localhost), or the kiosk lands on /login.
 */

/** Chrome's usual install path on Windows. */
export const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/**
 * The kiosk's own Chrome profile. Double quotes: PowerShell expands $env:LOCALAPPDATA inside them
 * and passes the flag as one argument even when the Windows user name has a space.
 */
export const KIOSK_PROFILE_FLAG = '"--user-data-dir=$env:LOCALAPPDATA\\farm-kiosk"';

export interface KioskCommands {
  /** Once: the kiosk profile, not in kiosk mode, on the localhost enrollment link. */
  enroll: string;
  /** Every start afterwards: kiosk mode on the board, same profile. */
  start: string;
}

/**
 * PowerShell one-liners for the wall kiosk on this PC. `kioskEnrollUrl` is the localhost
 * enrollment link (lan.ts `kioskUrl`); the board is on the same origin. `scale` pins the board's
 * 1920 x 1080 CSS px layout: 2 for a 4K panel, 1 for a 1080p one.
 */
export function kioskCommands(kioskEnrollUrl: string, scale = 2): KioskCommands {
  const board = new URL('/board', kioskEnrollUrl).toString();
  const chrome = `& "${CHROME_EXE}"`;
  return {
    enroll: `${chrome} --no-first-run ${KIOSK_PROFILE_FLAG} "${kioskEnrollUrl}"`,
    start: `${chrome} --kiosk --no-first-run --force-device-scale-factor=${scale} ${KIOSK_PROFILE_FLAG} ${board}`,
  };
}
