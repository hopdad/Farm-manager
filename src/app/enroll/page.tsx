/**
 * /enroll?code=K7QD2-M9XPA: make this browser the device a manager added on /admin/devices
 * (the wall PC's kiosk profile, a cab or truck iPad, a crew phone). Opening the link only shows
 * what the code would enroll; the button spends it. Without a code: type one.
 * Never redirected by the proxy.
 */
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { getConfig } from '@/config';
import { getPool } from '@/db/client';
import { formatEnrollCode, normalizeEnrollCode } from '@/platform/auth/codes';
import { DEVICE_KIND_LABELS } from '@/platform/auth/policy';
import { previewEnrollment } from '@/platform/auth/store';
import css from '../login/login.module.css';
import { enrollAction } from './actions';
import { EnrollButton } from './EnrollButton';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Enroll this screen · Farm Ops',
  robots: { index: false },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0b1210',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function CodeForm({ value, error }: { value?: string; error?: string }) {
  return (
    <section className={`${css.card} ${css.narrow}`}>
      {error && (
        <p className={css.message} role="alert" data-testid="enroll-error">
          {error}
        </p>
      )}
      <form action="/enroll" method="get" className={css.form}>
        <label className={css.label}>
          Enrollment code
          <input
            className={css.input}
            name="code"
            defaultValue={value}
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
      <Link className={css.link} href="/login">
        Back to sign-in
      </Link>
    </section>
  );
}

export default async function EnrollPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = first((await searchParams).code);
  const code = normalizeEnrollCode(raw);
  if (!raw || !code) {
    return (
      <main className={css.page} data-testid="enroll-page">
        <span className={css.brand}>Farm Ops</span>
        <h1 className={css.title}>Enroll this screen</h1>
        <p className={css.lead}>
          Type the code from Devices (a manager adds the device there), or open its link or QR code
          on this device.
        </p>
        <CodeForm
          value={raw}
          error={raw ? 'That is not an enrollment code (10 letters and digits).' : undefined}
        />
      </main>
    );
  }
  const preview = await previewEnrollment(getPool(), getConfig().SESSION_SECRET, code, new Date());
  if (preview.status !== 'ok') {
    const why = {
      expired:
        'This code has expired or was already used. Ask a manager for a new one (Devices, "New code").',
      unknown:
        'This code was already used, or no device has it. Check it, or ask a manager for a new one.',
      revoked: 'This device was revoked. A manager can add it again as a new device.',
    }[preview.status];
    return (
      <main className={css.page} data-testid="enroll-page">
        <span className={css.brand}>Farm Ops</span>
        <h1 className={css.title}>Enroll this screen</h1>
        <CodeForm value={formatEnrollCode(code)} error={why} />
      </main>
    );
  }
  const d = preview.device;
  const what =
    d.kind === 'phone' && d.personName
      ? `${d.personName}'s phone: it will sign in as ${d.personName}.`
      : `${DEVICE_KIND_LABELS[d.kind]}: on its own it can ${d.role === 'viewer' ? 'view' : `act as ${d.role}`}; people sign in on it with their PIN.`;
  return (
    <main className={css.page} data-testid="enroll-page">
      <span className={css.brand}>Farm Ops</span>
      <h1 className={css.title} data-testid="enroll-device-name">
        Make this the “{d.name}”
      </h1>
      <p className={css.lead}>{what}</p>
      <section className={`${css.card} ${css.narrow}`}>
        <p className={css.muted}>
          Do this once, on the device itself (for the wall: in the kiosk browser profile). A device
          enrolled before under this name is signed out.
        </p>
        <EnrollButton action={enrollAction} code={code} label={`Enroll as ${d.name}`} />
      </section>
    </main>
  );
}
