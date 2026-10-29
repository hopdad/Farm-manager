/**
 * /login: where every browser without a session lands (src/proxy.ts), and the PIN pad.
 *
 *  - an enrolled SHARED device (wall, cab/truck iPad): its name, who is signed in, "switch
 *    user", and the PIN pad with everyone who has a PIN (D8 operator layer);
 *  - a person signed in on their own browser: who, and sign out;
 *  - nobody (or a revoked / expired credential): "enroll this screen" (type the code from
 *    /admin/devices, or open its link or QR code) and the managers' name + PIN sign-in; on a
 *    farm with no owner yet, a pointer to the first-run link `pnpm dev` printed.
 *
 * Never redirected by the proxy, never an error page.
 */
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { getPool } from '@/db/client';
import { DEVICE_KIND_LABELS, PERSON_SIGN_IN_MIN_ROLE, safeNextPath } from '@/platform/auth/policy';
import { getBrowserAuth } from '@/platform/auth/server';
import { listPickablePeople, realOwnerExists } from '@/platform/auth/store';
import { ROLE_FOR, roleAtLeast } from '@/platform/auth/types';
import { IdleReturn } from './_components/IdleReturn';
import { PinPad, type PinPerson } from './_components/PinPad';
import {
  operatorSignInAction,
  personSignInAction,
  signOutAction,
  switchUserAction,
} from './actions';
import css from './login.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign in · Farm Ops', robots: { index: false } };
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0b1210',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function pinPeople(minRole: Parameters<typeof listPickablePeople>[1]): Promise<PinPerson[]> {
  const now = Date.now();
  return (await listPickablePeople(getPool(), minRole)).map((p) => ({
    id: p.id,
    displayName: p.displayName,
    role: p.role,
    lockedUntil:
      p.lockedUntil && p.lockedUntil.getTime() > now ? p.lockedUntil.toISOString() : null,
  }));
}

function Links({ admin }: { admin: boolean }) {
  return (
    <div className={css.row}>
      <Link className={`${css.button} ${css.primary}`} href="/board">
        Board
      </Link>
      <Link className={css.button} href="/m">
        Phone view
      </Link>
      {admin && (
        <>
          <Link className={css.button} href="/admin/people">
            People
          </Link>
          <Link className={css.button} href="/admin/devices">
            Devices
          </Link>
        </>
      )}
    </div>
  );
}

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const next = safeNextPath(first(sp.next));
  const personId = first(sp.person) ?? null;
  const auth = await getBrowserAuth();
  const session = auth.session;

  // --- an enrolled shared device: the operator PIN pad ---------------------------------------
  if (auth.sharedDevice && session) {
    const device = auth.sharedDevice;
    const deviceHome = next ?? (device.kind === 'wall' ? '/board' : '/m');
    return (
      <main
        className={`${css.page} ${device.kind === 'wall' ? css.wall : ''}`}
        data-testid="login-shared"
      >
        <IdleReturn href={deviceHome} />
        <span className={css.brand}>Farm Ops</span>
        <h1 className={css.title}>{device.name}</h1>
        <p className={css.lead}>
          {DEVICE_KIND_LABELS[device.kind]} · on its own it can{' '}
          {device.role === 'viewer' ? 'view' : `act as ${device.role}`}. Pick your name and enter
          your PIN to sign in on this screen.
        </p>
        {auth.operatorSignedIn ? (
          <section className={`${css.card} ${css.narrow}`} data-testid="operator-current">
            <h2>Signed in: {session.displayName}</h2>
            <p className={css.muted}>
              Role: {session.role}. You are signed out after 12 hours without use, or tap Switch
              user when you leave.
            </p>
            <Links admin={roleAtLeast(session.role, ROLE_FOR.admin)} />
            <form action={switchUserAction}>
              <button
                type="submit"
                className={`${css.button} ${css.wide}`}
                data-testid="switch-user"
              >
                Switch user
              </button>
            </form>
          </section>
        ) : (
          <section className={`${css.card} ${css.full}`}>
            <h2>Who is at the screen?</h2>
            <PinPad
              people={await pinPeople('viewer')}
              action={operatorSignInAction}
              next={next}
              initialPersonId={personId}
              emptyText="Nobody has a PIN yet: a manager sets PINs on /admin/people."
            />
            <div className={css.row}>
              <Link className={css.button} href={deviceHome}>
                Continue without signing in
              </Link>
            </div>
          </section>
        )}
      </main>
    );
  }

  // --- a person (or the PC's admin key) ------------------------------------------------------
  if (session) {
    return (
      <main className={css.page} data-testid="login-signed-in">
        <span className={css.brand}>Farm Ops</span>
        <h1 className={css.title}>Signed in as {session.displayName}</h1>
        <p className={css.lead}>
          {auth.adminKey
            ? 'This browser holds the admin key `pnpm dev` printed on the PC (owner rights, this PC only).'
            : `Role: ${session.role}${session.deviceKind === 'phone' ? ' · on your enrolled phone' : ''}.`}
        </p>
        <section className={`${css.card} ${css.narrow}`}>
          <Links admin={roleAtLeast(session.role, ROLE_FOR.admin)} />
          {!auth.adminKey && (
            <form action={signOutAction}>
              <button
                type="submit"
                className={`${css.button} ${css.danger} ${css.wide}`}
                data-testid="sign-out"
              >
                Sign out of this browser
              </button>
            </form>
          )}
        </section>
      </main>
    );
  }

  // --- nobody: enroll this screen, or a manager signs in -------------------------------------
  const [managers, ownerExists] = await Promise.all([
    pinPeople(PERSON_SIGN_IN_MIN_ROLE),
    realOwnerExists(getPool()),
  ]);
  return (
    <main className={css.page} data-testid="login-signed-out">
      <span className={css.brand}>Farm Ops</span>
      <h1 className={css.title}>Sign in</h1>
      <p className={css.lead}>
        The board and the phone view need an enrolled screen or a signed-in person.
      </p>
      {auth.stale && (
        <div className={css.banner} role="status" data-testid="login-stale">
          This browser&apos;s sign-in has ended: the device was revoked or enrolled again somewhere
          else, or the person was signed out. Enroll it again with a new code, or sign in.
        </div>
      )}
      <div className={css.cards}>
        <section className={css.card} data-testid="enroll-card">
          <h2>Enroll this screen</h2>
          <p className={css.muted}>
            For the wall display, a cab or truck iPad, or a crew phone. A manager adds the device on
            Devices and gets a one-time code, link and QR code; scan it, or type the code here.
          </p>
          <form action="/enroll" method="get" className={css.form}>
            <label className={css.label}>
              Enrollment code
              <input
                className={css.input}
                name="code"
                placeholder="K7QD2-M9XPA"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                data-testid="enroll-code-input"
              />
            </label>
            <button type="submit" className={`${css.button} ${css.primary} ${css.wide}`}>
              Continue
            </button>
          </form>
        </section>
        <section className={css.card} data-testid="person-card">
          <h2>Managers: sign in</h2>
          <p className={css.muted}>
            On your own phone or computer: pick your name, enter your PIN.
          </p>
          <p className={css.muted} data-testid="crew-hint">
            Crew: ask a manager to add your phone on Devices, then open the code here.
          </p>
          <PinPad
            people={managers}
            action={personSignInAction}
            next={next}
            initialPersonId={personId}
            emptyText={
              ownerExists
                ? 'No manager has a PIN yet: the owner sets PINs on People.'
                : 'First run: open the owner setup link that `pnpm dev` printed on the PC.'
            }
          />
        </section>
      </div>
    </main>
  );
}
