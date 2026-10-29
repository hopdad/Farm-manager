/**
 * /login/setup?code=…   first run: make yourself the owner (the link `pnpm run bootstrap` and
 *                       `pnpm dev` print until the owner exists).
 * /login/setup?reset=…  recovery: a link from `pnpm auth:reset-owner` (30 minutes, once) sets
 *                       a new owner PIN, unlocks the owner and ends their other sessions.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getConfig } from '@/config';
import { getPool } from '@/db/client';
import { isOwnerSetupCode, looksLikeResetCode } from '@/platform/auth/codes';
import { listOwners, ownerResetValid, realOwnerExists } from '@/platform/auth/store';
import { OwnerResetForm, OwnerSetupForm } from '../_components/OwnerForm';
import css from '../login.module.css';
import { resetOwnerAction, setupOwnerAction } from './actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Owner setup · Farm Ops', robots: { index: false } };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className={css.page} data-testid="owner-setup">
      <span className={css.brand}>Farm Ops</span>
      <h1 className={css.title}>{title}</h1>
      <section className={`${css.card} ${css.narrow}`}>{children}</section>
    </main>
  );
}

function Dead({ text }: { text: string }) {
  return (
    <Shell title="This link does not work">
      <p className={css.muted} data-testid="owner-link-dead">
        {text}
      </p>
      <Link className={`${css.button} ${css.primary}`} href="/login">
        Go to sign-in
      </Link>
    </Shell>
  );
}

export default async function OwnerSetupPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const cfg = getConfig();
  const pool = getPool();
  const reset = first(sp.reset);
  if (reset !== undefined) {
    if (
      !looksLikeResetCode(reset) ||
      !(await ownerResetValid(pool, cfg.SESSION_SECRET, reset, new Date()))
    ) {
      return (
        <Dead text="This reset link was already used or has expired (they last 30 minutes). Run `pnpm auth:reset-owner` on the PC again." />
      );
    }
    return (
      <Shell title="Set a new owner PIN">
        <p className={css.muted}>This also unlocks the owner and signs them out everywhere else.</p>
        <OwnerResetForm action={resetOwnerAction} reset={reset} owners={await listOwners(pool)} />
      </Shell>
    );
  }
  const code = first(sp.code);
  if (!isOwnerSetupCode(cfg.SESSION_SECRET, code)) {
    return (
      <Dead text="Use the owner setup link that `pnpm dev` (or `pnpm run bootstrap`) printed on the PC." />
    );
  }
  if (await realOwnerExists(pool)) {
    return (
      <Dead text="The owner is already set up: sign in with your name and PIN. Forgot the PIN? Run `pnpm auth:reset-owner` on the PC." />
    );
  }
  return (
    <Shell title="Welcome: set up the owner">
      <p className={css.muted}>
        You become the farm&apos;s owner: you add managers and crew, set their PINs and enroll the
        wall and the cab iPads. Pick a PIN only you know; you sign in with your name and it.
      </p>
      <OwnerSetupForm action={setupOwnerAction} code={code as string} />
    </Shell>
  );
}
