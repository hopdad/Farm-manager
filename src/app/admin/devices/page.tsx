/**
 * /admin/devices: the screens that may show the board without a person signing in (D8; plan
 * 1a). A manager adds a device (the wall PC, a cab or truck iPad, a crew member's phone), gets
 * a one-time code with its link and QR code, and opens it on the device; lost or replaced
 * devices are revoked here. Shared devices then carry the operator PIN pad.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getPool } from '@/db/client';
import { DEVICE_KINDS, DEVICE_ROLES } from '@/domain/farm';
import { pageSession } from '@/platform/auth/page';
import {
  DEFAULT_DEVICE_ROLE,
  DEVICE_KIND_LABELS,
  roleNeededToManage,
} from '@/platform/auth/policy';
import { type DeviceRow, listDevices, listPeople } from '@/platform/auth/store';
import { ROLE_FOR, roleAtLeast } from '@/platform/auth/types';
import { Refused } from '../../login/_components/Refused';
import { ActionForm, SubmitButton } from '../_components/controls';
import css from '../admin.module.css';
import { ago, detroitTime } from '../format';
import own from '../people/people.module.css';
import { addDeviceAction, newCodeAction, revokeDeviceAction, setDeviceRoleAction } from './actions';
import { DeviceActions } from './EnrollCodes';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Devices · Farm Ops' };

const PATH = '/admin/devices';

function Badge({ kind, children }: { kind: 'ok' | 'bad' | 'warn' | 'idle'; children: ReactNode }) {
  return <span className={`${css.badge} ${css[kind]}`}>{children}</span>;
}

function status(d: DeviceRow, now: Date): ReactNode {
  if (d.revokedAt) return <Badge kind="idle">revoked {ago(d.revokedAt, now)}</Badge>;
  const waiting = d.codePending && d.enrollExpiresAt && d.enrollExpiresAt > now;
  if (d.enrolledAt) {
    return (
      <>
        <Badge kind="ok">enrolled</Badge>
        {waiting && (
          <div className={css.muted}>new code open until {detroitTime(d.enrollExpiresAt)}</div>
        )}
      </>
    );
  }
  return waiting ? (
    <Badge kind="warn">waiting for the code (until {detroitTime(d.enrollExpiresAt)})</Badge>
  ) : (
    <Badge kind="bad">code expired: issue a new one</Badge>
  );
}

function DeviceRowView({ d, now }: { d: DeviceRow; now: Date }) {
  return (
    <tr data-testid="device-row" data-device-id={d.id} data-device-name={d.name}>
      <td>
        <strong>{d.name}</strong>
        <div className={css.muted}>{DEVICE_KIND_LABELS[d.kind]}</div>
      </td>
      <td>
        {d.kind === 'phone' ? (
          d.personName ? (
            <>signs in as {d.personName}</>
          ) : (
            d.role
          )
        ) : d.revokedAt ? (
          d.role
        ) : (
          <ActionForm action={setDeviceRoleAction} className={css.row}>
            <input type="hidden" name="id" value={d.id} />
            <select
              name="role"
              defaultValue={d.role}
              className={css.select}
              aria-label={`What ${d.name} may do on its own`}
            >
              {DEVICE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <SubmitButton className={css.button}>Save</SubmitButton>
          </ActionForm>
        )}
      </td>
      <td>
        {status(d, now)}
        <div className={css.muted}>last seen {ago(d.lastSeenAt, now)}</div>
      </td>
      <td>
        {!d.revokedAt && (
          <div className={css.row}>
            <ActionForm action={newCodeAction}>
              <input type="hidden" name="id" value={d.id} />
              <SubmitButton className={css.button} testId="device-new-code">
                New code
              </SubmitButton>
            </ActionForm>
            <ActionForm action={revokeDeviceAction}>
              <input type="hidden" name="id" value={d.id} />
              <SubmitButton className={`${css.button} ${css.danger}`} testId="device-revoke">
                Revoke
              </SubmitButton>
            </ActionForm>
          </div>
        )}
      </td>
    </tr>
  );
}

export default async function DevicesPage() {
  const gate = await pageSession(ROLE_FOR.manageDevices, PATH);
  if (!gate.ok)
    return <Refused required={gate.required} session={gate.session} what="Devices" path={PATH} />;
  const actor = gate.session;
  const pool = getPool();
  const [devices, people] = await Promise.all([listDevices(pool), listPeople(pool)]);
  const phoneOwners = people.filter(
    (p) =>
      p.active && (p.id === actor.appUserId || roleAtLeast(actor.role, roleNeededToManage(p.role))),
  );
  const now = new Date();

  return (
    <DeviceActions
      header={
        <>
          <div className={css.pageHead}>
            <h1>Devices</h1>
            <span className={css.muted}>
              Signed in as {actor.displayName} ({actor.role})
            </span>
          </div>
          <nav className={`${css.row} ${own.subnav}`} aria-label="Sign-in admin">
            <Link className={css.navLink} href="/admin/people">
              People
            </Link>
            <Link
              className={`${css.navLink} ${css.active}`}
              href="/admin/devices"
              aria-current="page"
            >
              Devices
            </Link>
          </nav>
        </>
      }
    >
      <div className={css.grid}>
        <section className={css.card} data-testid="add-device">
          <h2>Add a device</h2>
          <ActionForm action={addDeviceAction} className={css.stack} testId="add-device-form">
            <label className={css.stack}>
              Name
              <input
                name="name"
                className={css.select}
                required
                maxLength={80}
                placeholder="Shop wall, Cab 2, Dale's phone"
                data-testid="add-device-name"
              />
            </label>
            <label className={css.stack}>
              Kind
              <select
                name="kind"
                className={css.select}
                defaultValue="wall"
                data-testid="add-device-kind"
              >
                {DEVICE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {DEVICE_KIND_LABELS[k]} (on its own: {DEFAULT_DEVICE_ROLE[k]})
                  </option>
                ))}
              </select>
            </label>
            <label className={css.stack}>
              On its own it may (shared screens; people sign in on top with their PIN)
              <select
                name="role"
                className={css.select}
                defaultValue=""
                data-testid="add-device-role"
              >
                <option value="">the default for its kind</option>
                {DEVICE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className={css.stack}>
              Phone owner (phones only: the phone signs in as this person)
              <select name="appUserId" className={css.select} defaultValue="">
                <option value="">(not a personal phone)</option>
                {phoneOwners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} ({p.role})
                  </option>
                ))}
              </select>
            </label>
            <SubmitButton className={`${css.button} ${css.primary}`} testId="add-device-submit">
              Add and show the code
            </SubmitButton>
          </ActionForm>
        </section>
        <section className={css.card}>
          <h2>Kiosk and iPads</h2>
          <ul className={css.events}>
            <li>
              The wall on this PC: add a Wall display; its code panel gives the PowerShell command
              that opens the code on localhost in the kiosk&apos;s own Chrome profile, then the one
              that starts kiosk mode.
            </li>
            <li>
              Cab and truck iPads: scan the QR code with the camera, tap Enroll, then Add to Home
              Screen.
            </li>
            <li>
              On shared screens people pick their name and enter their PIN; the screen falls back to
              its own role when they switch user.
            </li>
            <li>Lost or replaced: Revoke. The device is signed out on its next request.</li>
          </ul>
          <p className={css.muted}>Step by step: docs/kiosk.md.</p>
        </section>
      </div>

      <section className={css.card}>
        <h2>Devices ({devices.length})</h2>
        <div className={css.tableWrap}>
          <table className={css.table} data-testid="devices-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>On its own</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <DeviceRowView key={d.id} d={d} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </DeviceActions>
  );
}
