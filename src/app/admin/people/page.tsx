/**
 * /admin/people: who can sign in, with which role, and their PINs (D8; plan 1a). Managers add
 * crew (viewer, driver, operator) and set their PINs; only the owner adds or changes managers
 * and owners. Every action re-checks on the server (./actions.ts). PINs are never shown: a
 * manager types a new one with the person standing there.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getPool } from '@/db/client';
import { pageSession } from '@/platform/auth/page';
import { roleNeededToManage } from '@/platform/auth/policy';
import { listPeople, listPeopleWithoutSignIn, type PersonRow } from '@/platform/auth/store';
import {
  PIN_RULES,
  ROLE_FOR,
  ROLES,
  type Role,
  roleAtLeast,
  type Session,
} from '@/platform/auth/types';
import { Refused } from '../../login/_components/Refused';
import { SubmitButton } from '../_components/controls';
import css from '../admin.module.css';
import { ago, detroitTime } from '../format';
import {
  addPersonAction,
  deactivateDemoAction,
  setActiveAction,
  setPinAction,
  setRoleAction,
  signOutEverywhereAction,
  unlockAction,
} from './actions';
import { ResultForm, ResultProvider } from './forms';
import own from './people.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'People · Farm Ops' };

const PATH = '/admin/people';
const ROLE_HELP: Record<Role, string> = {
  viewer: 'sees the board, fields, fleet and weather',
  driver: '+ marks machines down, enters soil temperatures',
  operator: 'field crew; like a driver in Phase 1',
  manager: '+ edits fields and notes, admin pages, people and devices',
  owner: '+ manages managers and owners',
};

function Badge({ kind, children }: { kind: 'ok' | 'bad' | 'warn' | 'idle'; children: ReactNode }) {
  return <span className={`${css.badge} ${css[kind]}`}>{children}</span>;
}

function SubNav() {
  return (
    <nav className={`${css.row} ${own.subnav}`} aria-label="Sign-in admin">
      <Link className={`${css.navLink} ${css.active}`} href="/admin/people" aria-current="page">
        People
      </Link>
      <Link className={css.navLink} href="/admin/devices">
        Devices
      </Link>
    </nav>
  );
}

const assignable = (actor: Session): Role[] =>
  ROLES.filter((r) => roleAtLeast(actor.role, roleNeededToManage(r)));

const pinInput = {
  className: css.select,
  type: 'password',
  inputMode: 'numeric' as const,
  pattern: '[0-9]*',
  autoComplete: 'new-password',
  minLength: PIN_RULES.minLength,
  maxLength: PIN_RULES.maxLength,
  placeholder: `${PIN_RULES.minLength}-${PIN_RULES.maxLength} digits`,
};

function PersonRowView({ p, actor, now }: { p: PersonRow; actor: Session; now: Date }) {
  const mayManage = roleAtLeast(actor.role, roleNeededToManage(p.role));
  const self = p.id === actor.appUserId;
  const locked = p.lockedUntil && p.lockedUntil > now;
  return (
    <tr data-testid="person-row" data-person-id={p.id} data-person-name={p.displayName}>
      <td>
        <strong>{p.displayName}</strong>
        {self && <span className={css.muted}> (you)</span>}
        {p.source !== 'app' && <div className={css.muted}>{p.source}</div>}
      </td>
      <td>
        {mayManage && !self ? (
          <ResultForm action={setRoleAction} className={css.row}>
            <input type="hidden" name="id" value={p.id} />
            <select
              name="role"
              defaultValue={p.role}
              className={css.select}
              aria-label={`Role of ${p.displayName}`}
            >
              {assignable(actor).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <SubmitButton className={css.button}>Save</SubmitButton>
          </ResultForm>
        ) : (
          p.role
        )}
      </td>
      <td>
        {!p.active ? (
          <Badge kind="idle">switched off</Badge>
        ) : locked ? (
          <Badge kind="bad">locked until {detroitTime(p.lockedUntil)}</Badge>
        ) : p.hasPin ? (
          <Badge kind="ok">PIN set</Badge>
        ) : (
          <Badge kind="warn">no PIN</Badge>
        )}
        <div className={css.muted}>last sign-in {ago(p.lastSignInAt, now)}</div>
      </td>
      <td>
        {(mayManage || self) && (
          <div className={css.stack}>
            <ResultForm action={setPinAction} className={css.row}>
              <input type="hidden" name="id" value={p.id} />
              <input
                {...pinInput}
                name="pin"
                aria-label={`New PIN for ${p.displayName}`}
                data-testid="person-pin"
              />
              <SubmitButton className={css.button} testId="person-set-pin">
                Set PIN
              </SubmitButton>
            </ResultForm>
            {mayManage && (
              <div className={css.row}>
                {locked && (
                  <ResultForm action={unlockAction}>
                    <input type="hidden" name="id" value={p.id} />
                    <SubmitButton className={css.button} testId="person-unlock">
                      Unlock
                    </SubmitButton>
                  </ResultForm>
                )}
                <ResultForm action={signOutEverywhereAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <SubmitButton className={css.button}>Sign out everywhere</SubmitButton>
                </ResultForm>
                {!self && (
                  <ResultForm action={setActiveAction}>
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="active" value={p.active ? 'false' : 'true'} />
                    <SubmitButton
                      className={`${css.button} ${p.active ? css.danger : css.primary}`}
                    >
                      {p.active ? 'Switch off' : 'Switch on'}
                    </SubmitButton>
                  </ResultForm>
                )}
              </div>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

export default async function PeoplePage() {
  const gate = await pageSession(ROLE_FOR.managePeople, PATH);
  if (!gate.ok)
    return <Refused required={gate.required} session={gate.session} what="People" path={PATH} />;
  const actor = gate.session;
  const pool = getPool();
  const [people, candidates] = await Promise.all([listPeople(pool), listPeopleWithoutSignIn(pool)]);
  const now = new Date();
  const demoOn = people.filter((p) => p.source === 'demo' && p.active).length;
  const roles = assignable(actor);

  return (
    <ResultProvider>
      <div className={css.pageHead}>
        <h1>People</h1>
        <span className={css.muted} data-testid="people-actor">
          Signed in as {actor.displayName} ({actor.role})
        </span>
      </div>
      <SubNav />

      {demoOn > 0 && (
        <div className={css.banner} data-testid="demo-people-banner">
          {demoOn} demo {demoOn === 1 ? 'person is' : 'people are'} switched on. Their PINs are
          printed on the PC (`pnpm dev`), and one is a manager: switch them off before real use.
          {roleAtLeast(actor.role, ROLE_FOR.manageManagers) && (
            <ResultForm action={deactivateDemoAction} className={css.row}>
              <SubmitButton className={`${css.button} ${css.danger}`}>
                Switch off the demo people
              </SubmitButton>
            </ResultForm>
          )}
        </div>
      )}

      <div className={css.grid}>
        <section className={css.card} data-testid="add-person">
          <h2>Add a person</h2>
          <ResultForm action={addPersonAction} className={css.stack}>
            <label className={css.stack}>
              Name (someone new)
              <input
                name="name"
                className={css.select}
                autoComplete="off"
                maxLength={80}
                data-testid="add-person-name"
              />
            </label>
            {candidates.length > 0 && (
              <label className={css.stack}>
                …or someone already in the farm&apos;s contacts
                <select name="partyId" className={css.select} defaultValue="">
                  <option value="">(someone new)</option>
                  {candidates.map((c) => (
                    <option key={c.partyId} value={c.partyId}>
                      {c.displayName}
                      {c.crew ? ' (crew)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className={css.stack}>
              Role
              <select
                name="role"
                className={css.select}
                defaultValue="driver"
                data-testid="add-person-role"
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}: {ROLE_HELP[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className={css.stack}>
              First PIN (optional; they can be given one later)
              <input {...pinInput} name="pin" data-testid="add-person-pin" />
            </label>
            <SubmitButton className={`${css.button} ${css.primary}`} testId="add-person-submit">
              Add person
            </SubmitButton>
          </ResultForm>
        </section>
        <section className={css.card}>
          <h2>How sign-in works</h2>
          <ul className={css.events}>
            <li>
              Shared screens (the wall, cab and truck iPads): pick your name, enter your PIN.{' '}
              {PIN_RULES.maxFailures} wrong PINs lock that person for {PIN_RULES.lockoutMinutes}{' '}
              minutes; each further lockout in a row lasts twice as long, up to a day (or until a
              manager unlocks them).
            </li>
            <li>
              Managers and the owner can also sign in on their own phone or computer with name and
              PIN.
            </li>
            <li>
              Crew phones: add the phone on Devices for that person, then open its link on the
              phone.
            </li>
            <li>Roles: {ROLES.map((r) => `${r} (${ROLE_HELP[r]})`).join('; ')}.</li>
          </ul>
        </section>
      </div>

      <section className={css.card}>
        <h2>Everyone ({people.length})</h2>
        <div className={css.tableWrap}>
          <table className={css.table} data-testid="people-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Sign-in</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <PersonRowView key={p.id} p={p} actor={actor} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </ResultProvider>
  );
}
