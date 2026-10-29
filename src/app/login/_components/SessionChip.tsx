'use client';
/**
 * Who is signed in on this screen, in the status strip of the board and /m (BoardScreen). On a shared screen (the wall, a cab iPad) it is the way to the PIN
 * pad: "Sign in" when nobody is, "Switch user" when someone is. Elsewhere it links to /login
 * (sign out). Renders nothing until it knows, and nothing for a signed-out browser.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type WhoAmI, whoAmIAction } from '../actions';
import css from '../login.module.css';

export function SessionChip({
  variant,
  placement = 'floating',
}: {
  variant: 'wall' | 'phone';
  /** 'strip': inside the board's status strip; 'floating': over the page (top right). */
  placement?: 'floating' | 'strip';
}) {
  const [me, setMe] = useState<WhoAmI | null>(null);
  useEffect(() => {
    let live = true;
    whoAmIAction().then(
      (w) => {
        if (live) setMe(w);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  if (!me) return null;
  const action = me.shared
    ? me.operatorSignedIn
      ? 'Switch user'
      : 'Sign in'
    : variant === 'wall'
      ? 'Account'
      : '';
  return (
    <Link
      href="/login"
      className={`${css.chip} ${variant === 'phone' ? css.chipPhone : ''} ${placement === 'strip' ? css.chipStrip : ''}`}
      data-testid="session-chip"
      data-role={me.role}
      title={`Signed in as ${me.displayName} (${me.role})`}
    >
      <span className={css.chipName}>{me.displayName}</span>
      {action && <span className={css.chipAction}>{action}</span>}
    </Link>
  );
}
