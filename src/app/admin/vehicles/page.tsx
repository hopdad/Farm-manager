/**
 * /admin/vehicles (slice 1f.2, terminal-pickups; docs/contracts-1f.md §B.4.5): what each
 * telematics vehicle is. A vehicle's kind (semi, pickup, service truck) comes from its vendor's
 * tags through VEHICLE_KIND_TAGS (fleet.vehicles for Samsara; Motive and Geotab groups; Terminal
 * group names) until someone sets it here: a kind set here always wins, and "Let tags decide"
 * hands it back. Each row shows the kind badge, the route the data takes (telematics_via and the
 * latest fix's vendor) and the stats that route doesn't report. Manager or owner only
 * (ROLE_FOR.admin), checked here and in every action; anyone else gets the 403 page and the
 * JSON route (./kind) answers 403.
 */
import Link from 'next/link';
import { getConfig } from '@/config';
import { statsNotReported, vendorLabel } from '@/connectors/vendors';
import { getPool } from '@/db/client';
import { listAdminVehicles } from '@/db/queries/vehicles';
import { requireRole } from '@/platform/auth/server';
import { AuthError, ROLE_FOR } from '@/platform/auth/types';
import { KIND_LABELS } from '@/ui/map/fleet/style';
import { VehicleKindBadge } from '@/ui/vehicles/KindBadge';
import { NOT_REPORTED } from '@/ui/vehicles/stats';
import { ActionForm, NoticeProvider, SubmitButton } from '../_components/controls';
import css from '../admin.module.css';
import { KIND_CHOICES } from './_lib/set-kind';
import { releaseVehicleKindAction, setVehicleKindAction } from './actions';
import vc from './vehicles.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Vehicles · Farm Ops' };

const STAT_WORDS = {
  engineHours: 'engine hours',
  odometerMi: 'odometer',
  fuelPct: 'fuel',
  defPct: 'DEF',
  engineOn: 'engine state',
} as const;

function NoAccess({ status }: { status: 401 | 403 }) {
  return (
    <main className={css.banner} data-testid="vehicles-no-access" data-status={status}>
      <h1>{status === 401 ? 'Sign in first' : 'This page needs a manager'}</h1>
      <p>
        {status === 401 ? (
          <>
            <Link href="/login?next=%2Fadmin%2Fvehicles">Sign in</Link> with a manager or owner
            account.
          </>
        ) : (
          <>
            You are signed in, but setting what a vehicle is needs the manager role or above. Ask
            the owner to change your role on /admin/people.
          </>
        )}
      </p>
    </main>
  );
}

export default async function VehiclesAdminPage() {
  try {
    await requireRole(ROLE_FOR.admin);
  } catch (e) {
    if (e instanceof AuthError) return <NoAccess status={e.status} />;
    throw e;
  }
  const cfg = getConfig();
  const rows = await listAdminVehicles(getPool(), KIND_CHOICES);

  return (
    <NoticeProvider>
      <div className={css.pageHead}>
        <h1>Vehicles</h1>
        <span className={css.muted}>{rows.length} vehicles</span>
      </div>
      <section className={css.card} data-testid="vehicle-kind-rules">
        <h2>Where a vehicle&apos;s kind comes from</h2>
        <p className={css.muted}>
          From its tags in the vendor&apos;s dashboard (Samsara tags; Motive and Geotab groups;
          Terminal group names), through <code>VEHICLE_KIND_TAGS</code>, unless you set it below. A
          kind set here always wins; vendor tags never change it again until you let them.
        </p>
        <ul className={vc.rules}>
          {cfg.VEHICLE_KIND_TAGS.map((r) => (
            <li key={`${r.tag}:${r.kind}`}>
              tag <strong>{r.tag}</strong> → {KIND_LABELS[r.kind].toLowerCase()}
            </li>
          ))}
        </ul>
      </section>
      <section className={css.card}>
        <div className={css.tableWrap}>
          <table className={css.table} data-testid="vehicles-table">
            <thead>
              <tr>
                <th>Unit</th>
                <th>Vehicle</th>
                <th>Kind</th>
                <th>Route</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const missing = statsNotReported(v.positionVendor, v.telematicsVia);
                return (
                  <tr key={v.id} data-testid="vehicle-row" data-unit={v.unitNo} data-id={v.id}>
                    <td>
                      <strong>{v.unitNo}</strong>
                    </td>
                    <td>
                      {[v.year, v.make, v.model].filter(Boolean).join(' ') || '—'}
                      {v.status === 'down' && <span className={css.muted}> · down</span>}
                    </td>
                    <td>
                      <VehicleKindBadge
                        kind={v.kind}
                        kindSetBy={v.kindSetBy}
                        via={v.telematicsVia}
                        compact
                      />
                    </td>
                    <td>
                      <span data-testid="vehicle-route">
                        {v.telematicsVia ? vendorLabel(v.telematicsVia) : 'its own device'}
                        {v.positionVendor ? ` · ${vendorLabel(v.positionVendor)}` : ''}
                      </span>
                      {v.sources.length > 0 && (
                        <div className={css.muted}>refs: {v.sources.join(', ')}</div>
                      )}
                      {missing.length > 0 && (
                        <div className={vc.notReported} data-testid="vehicle-not-reported">
                          {missing.map((f) => STAT_WORDS[f]).join(', ')}: {NOT_REPORTED}
                        </div>
                      )}
                    </td>
                    <td>
                      <ActionForm action={setVehicleKindAction} className={vc.kindForm}>
                        <input type="hidden" name="machineId" value={v.id} />
                        <input type="hidden" name="unitNo" value={v.unitNo} />
                        <select
                          name="kind"
                          className={css.select}
                          defaultValue={KIND_CHOICES.includes(v.kind as never) ? v.kind : ''}
                          aria-label={`Kind of ${v.unitNo}`}
                          data-testid="vehicle-kind-select"
                          required
                        >
                          <option value="" disabled>
                            Choose…
                          </option>
                          {KIND_CHOICES.map((k) => (
                            <option key={k} value={k}>
                              {KIND_LABELS[k]}
                            </option>
                          ))}
                        </select>
                        <SubmitButton
                          className={`${css.button} ${css.primary}`}
                          testId="vehicle-kind-save"
                        >
                          Set by hand
                        </SubmitButton>
                      </ActionForm>
                      {v.kindSetBy === 'admin' && (
                        <ActionForm action={releaseVehicleKindAction}>
                          <input type="hidden" name="machineId" value={v.id} />
                          <input type="hidden" name="unitNo" value={v.unitNo} />
                          <SubmitButton className={css.button} testId="vehicle-kind-release">
                            Let tags decide
                          </SubmitButton>
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </NoticeProvider>
  );
}
