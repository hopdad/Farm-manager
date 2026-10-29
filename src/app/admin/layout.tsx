import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import css from './admin.module.css';

export const metadata: Metadata = {
  title: 'Admin · Farm Ops',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className={css.topbar}>
        <Link href="/board" className={css.brand}>
          Farm Ops
        </Link>
        <nav className={css.nav} aria-label="Admin">
          <Link href="/admin/connectors" className={css.navLink}>
            Connectors
          </Link>
          <Link href="/admin/realtime" className={css.navLink}>
            Realtime
          </Link>
          <Link href="/board" className={css.navLink}>
            Board
          </Link>
        </nav>
      </header>
      <div className={css.shell}>{children}</div>
    </>
  );
}
