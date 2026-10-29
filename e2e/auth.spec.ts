/**
 * Sign-in (plan 1a, D8; src/platform/auth): enrollment, the operator PIN layer, lockout, roles,
 * and sign-in over the LAN address against the production build `pnpm test:e2e` starts.
 *
 *  - a browser with no session sees the sign-in / enrollment screen, never an error, and API
 *    calls get 401 JSON (never a redirect);
 *  - a manager adds a wall on /admin/devices, the wall opens the one-time link and shows the
 *    board; revoking signs it out at once and the code never works twice;
 *  - on a shared device people pick their name, enter their PIN, and "switch user";
 *  - five wrong PINs lock that person for 15 minutes, even with the right PIN after;
 *  - a viewer can't change anything: refused pages, and a server action posted from a page a
 *    manager loaded is refused once the browser's session is a viewer's;
 *  - over http://<lan-ip> (the production build, plain http): sign in, cookie not Secure,
 *    SameSite=Lax, httpOnly, and the board opens.
 *
 * Throwaway people and devices come from e2e/support/auth.ts (removed by the next run).
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { AUTH_COOKIE } from '../src/platform/auth/cookies';
import { PIN_RULES } from '../src/platform/auth/types';
import {
  applyIdentity,
  createTmpDevice,
  createTmpPerson,
  e2eIdentity,
  e2eName,
  e2ePin,
  e2ePool,
  e2eUserId,
  lanOrigin,
  signInAs,
} from './support/auth';

const SIGNED_OUT = { cookies: [], origins: [] };
const onlyWall = () => test.skip(test.info().project.name !== 'wall', 'one browser is enough');
const home = () => (test.info().project.name === 'phone' ? '/m' : '/board');

async function pickAndEnterPin(page: Page, personId: string, pin: string): Promise<void> {
  await page.locator(`[data-testid="pin-name"][data-person-id="${personId}"]`).click();
  await page.getByTestId('pin-input').fill(pin);
  await page.getByTestId('pin-submit').click();
}

async function authCookie(context: BrowserContext, origin: string) {
  return (await context.cookies(origin)).find((c) => c.name === AUTH_COOKIE);
}

test.describe('signed out', () => {
  test.use({ storageState: SIGNED_OUT });

  test('the board and /m show the sign-in screen, not an error; the API answers 401', async ({
    page,
  }) => {
    for (const path of ['/board', '/m', '/']) {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page).toHaveURL(/\/login(\?|$)/);
      await expect(page.getByTestId('login-signed-out')).toBeVisible();
      await expect(page.getByTestId('enroll-card')).toBeVisible();
      await expect(page.getByTestId('person-card')).toBeVisible();
    }
    expect(new URL(page.url()).pathname).toBe('/login');
    await page.goto('/board');
    expect(new URL(page.url()).searchParams.get('next')).toBe('/board');

    const api = await page.request.get('/api/fleet', { maxRedirects: 0 });
    expect(api.status()).toBe(401);
    expect(await api.json()).toMatchObject({ status: 401 });
  });

  test('a typed enrollment code that does not exist is explained', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('enroll-code-input').fill('zzzzz-zzzzz');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('enroll-error')).toContainText('no device has it');
  });
});

test('a manager enrolls a wall; the wall opens the board; revoking signs it out', async ({
  browser,
  baseURL,
}) => {
  onlyWall();
  test.setTimeout(120_000);
  const name = `E2E wall ${Date.now().toString(36)}`;
  const manager = await browser.newContext();
  const wall = await browser.newContext({ storageState: SIGNED_OUT });
  try {
    await signInAs(manager, 'manager');
    const admin = await manager.newPage();
    await admin.goto('/admin/devices');
    await admin.getByTestId('add-device-name').fill(name);
    await admin.getByTestId('add-device-kind').selectOption('wall');
    await admin.getByTestId('add-device-submit').click();
    const panel = admin.getByTestId('enroll-code-panel');
    await expect(panel).toContainText(name);
    await expect(panel.getByTestId('enroll-qr')).toBeVisible();
    const shown = new URL((await panel.getByTestId('enroll-link').getAttribute('href')) as string);
    const code = (await panel.getByTestId('enroll-code').textContent()) as string;
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(shown.pathname).toBe('/enroll');
    // On the PC itself the QR link carries the PC's LAN address (a scanned localhost opens the
    // iPad itself); the localhost link is listed as "on this PC".
    if (await panel.getByTestId('enroll-lan-links').isVisible()) {
      expect(shown.hostname).not.toMatch(/^(localhost|127\.)/);
    }
    // This test's wall browser uses the base URL (its cookies are checked there).
    const link = new URL(`${shown.pathname}${shown.search}`, baseURL).toString();

    // On the wall: opening the link shows what it enrolls; the button spends the code.
    const screen = await wall.newPage();
    await screen.goto(link);
    await expect(screen.getByTestId('enroll-device-name')).toContainText(name);
    await screen.getByTestId('enroll-submit').click();
    await expect(screen).toHaveURL(/\/board$/);
    await expect(screen.getByTestId('board')).toBeVisible();
    await expect(screen.getByTestId('session-chip')).toContainText(name);
    const cookie = await authCookie(wall, baseURL as string);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: false });
    expect((await screen.request.get('/api/fleet')).status()).toBe(200);

    // The code works once.
    const again = await browser.newContext({ storageState: SIGNED_OUT });
    const p2 = await again.newPage();
    await p2.goto(link);
    await expect(p2.getByTestId('enroll-error')).toContainText('already used');
    await again.close();

    // Revoke: the wall is signed out on its next request.
    await admin.reload();
    const row = admin.locator(`[data-testid="device-row"][data-device-name="${name}"]`);
    await row.getByTestId('device-revoke').click();
    await expect(admin.getByTestId('admin-notice')).toContainText('Revoked');
    expect((await screen.request.get('/api/fleet')).status()).toBe(401);
    await screen.goto('/login');
    await expect(screen.getByTestId('login-stale')).toBeVisible();
  } finally {
    await manager.close();
    await wall.close();
  }
});

test('on a shared device people sign in with their PIN and switch user', async ({ context }) => {
  const kind = test.info().project.name === 'phone' ? 'cab_ipad' : 'wall';
  const device = await createTmpDevice(kind, 'viewer', kind === 'wall' ? 'Shop wall' : 'Cab');
  const dana = await createTmpPerson('operator', 'Dana');
  const eli = await createTmpPerson('driver', 'Eli', '2580');
  await applyIdentity(context, device.identity);
  const page = await context.newPage();

  await page.goto(home());
  const chip = page.getByTestId('session-chip');
  await expect(chip).toContainText(device.name);
  await expect(chip).toContainText('Sign in');
  await chip.click();
  await expect(page.getByTestId('login-shared')).toBeVisible({ timeout: 15_000 });

  await pickAndEnterPin(page, dana.id, dana.pin);
  await expect(page).toHaveURL(new RegExp(`${home()}$`));
  await expect(chip).toContainText(`${dana.name} (${device.name})`);
  await expect(chip).toHaveAttribute('data-role', 'operator');
  await expect(chip).toContainText('Switch user');

  await chip.click();
  await expect(page.getByTestId('operator-current')).toContainText(dana.name, { timeout: 15_000 });
  await page.getByTestId('switch-user').click();
  // Back on the device's own screen (the wall shows the board, not the PIN pad).
  await expect(page).toHaveURL(new RegExp(`${home()}$`));
  await expect(chip).toContainText('Sign in');
  await chip.click();
  await expect(page.getByTestId('pin-names')).toBeVisible({ timeout: 15_000 });
  await pickAndEnterPin(page, eli.id, eli.pin);
  await expect(page).toHaveURL(new RegExp(`${home()}$`));
  await expect(chip).toContainText(eli.name);
  await expect(chip).toHaveAttribute('data-role', 'driver');
});

test(`${PIN_RULES.maxFailures} wrong PINs lock a person out for ${PIN_RULES.lockoutMinutes} minutes`, async ({
  context,
}) => {
  onlyWall();
  const device = await createTmpDevice('wall', 'viewer', 'Lockout wall');
  const sam = await createTmpPerson('operator', 'Sam');
  await applyIdentity(context, device.identity);
  const page = await context.newPage();
  await page.goto('/login');
  await page.locator(`[data-testid="pin-name"][data-person-id="${sam.id}"]`).click();
  for (let i = 1; i < PIN_RULES.maxFailures; i++) {
    await page.getByTestId('pin-input').fill('9024');
    await page.getByTestId('pin-submit').click();
    await expect(page.getByTestId('pin-message')).toContainText(
      `${PIN_RULES.maxFailures - i} ${PIN_RULES.maxFailures - i === 1 ? 'try' : 'tries'} left`,
    );
  }
  await page.getByTestId('pin-input').fill('9024');
  await page.getByTestId('pin-submit').click();
  await expect(page.getByTestId('pin-message')).toContainText(
    `locked for ${PIN_RULES.lockoutMinutes} minutes`,
  );
  // Even the right PIN is refused while locked.
  await page.getByTestId('pin-input').fill(sam.pin);
  await page.getByTestId('pin-submit').click();
  await expect(page.getByTestId('pin-message')).toContainText('Too many wrong PINs');
  await expect(page).toHaveURL(/\/login$/);
  const r = await e2ePool().query<{ minutes: number }>(
    `select extract(epoch from locked_until - now()) / 60 as minutes from farm.app_users where id = $1`,
    [sam.id],
  );
  expect(Number(r.rows[0]?.minutes)).toBeGreaterThan(PIN_RULES.lockoutMinutes - 1);
  expect(Number(r.rows[0]?.minutes)).toBeLessThanOrEqual(PIN_RULES.lockoutMinutes);
});

test('a viewer cannot change anything', async ({ context, page }) => {
  onlyWall();
  // The suite's default session is the viewer kiosk.
  for (const path of ['/admin/people', '/admin/devices']) {
    await page.goto(path);
    await expect(page.getByTestId('auth-refused')).toHaveAttribute('data-required', 'manager');
    await expect(page.getByTestId('people-table')).toHaveCount(0);
    await expect(page.getByTestId('devices-table')).toHaveCount(0);
  }

  // A form a manager loaded, submitted after the browser became a viewer: the server refuses.
  await signInAs(context, 'manager');
  await page.goto('/admin/people');
  await expect(page.getByTestId('people-actor')).toContainText(e2eName('manager'));
  await applyIdentity(context, await e2eIdentity('viewer'));
  const name = `E2E Never ${Date.now().toString(36)}`;
  await page.getByTestId('add-person-name').fill(name);
  await page.getByTestId('add-person-submit').click();
  await expect(page.getByTestId('admin-notice')).toContainText('needs the manager role');
  const r = await e2ePool().query(`select 1 from farm.parties where display_name = $1`, [name]);
  expect(r.rowCount).toBe(0);
});

test('sign-in works over http://<lan-ip> on the production build', async ({ browser, baseURL }) => {
  onlyWall();
  const origin = lanOrigin(baseURL);
  test.skip(!origin, 'this machine has no LAN address');
  await e2eIdentity('manager'); // the E2E Manager exists, is switched on and has a PIN
  const context = await browser.newContext({ storageState: SIGNED_OUT });
  try {
    const page = await context.newPage();
    const res = await page.goto(`${origin}/admin/people`);
    const html = (await res?.text()) ?? '';
    test.info().annotations.push({
      type: 'build',
      description: /\\"b\\":\\"development\\"/.test(html) ? 'next dev' : 'production build',
    });
    await expect(page).toHaveURL(`${origin}/login?next=%2Fadmin%2Fpeople`);
    await pickAndEnterPin(page, e2eUserId('manager'), e2ePin('manager'));
    await expect(page).toHaveURL(`${origin}/admin/people`);
    await expect(page.getByTestId('people-actor')).toContainText(e2eName('manager'));
    const cookie = await authCookie(context, origin as string);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: false });
    expect(cookie?.domain).toBe(new URL(origin as string).hostname);
    await page.goto(`${origin}/board`);
    await expect(page).toHaveURL(`${origin}/board`);
    await expect(page.getByTestId('board')).toBeVisible();
    expect((await page.request.get(`${origin}/api/fleet`)).status()).toBe(200);
  } finally {
    await context.close();
  }
});
