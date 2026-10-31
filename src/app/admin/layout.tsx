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
          <Link href="/admin/fields" className={css.navLink}>
            Fields
          </Link>
          <Link href="/admin/parties" className={css.navLink}>
            Parties
          </Link>
          <Link href="/admin/spray" className={css.navLink}>
            Spray
          </Link>
          <Link href="/admin/people" className={css.navLink}>
            People
          </Link>
          <Link href="/admin/devices" className={css.navLink}>
            Devices
          </Link>
          <Link href="/admin/connectors" className={css.navLink}>
            Connectors
          </Link>
          <Link href="/admin/vehicles" className={css.navLink}>
            Vehicles
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
