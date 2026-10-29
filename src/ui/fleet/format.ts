/** What a fleet panel row says (pure; times in America/Detroit like the rest of the board). */
import { ACTIVITY_LABELS, formatAge, formatClock } from '../board/format';
import type { PanelMachine } from './contract';
import type { PanelRow } from './model';

const PLACE_PREFIX: Record<NonNullable<PanelMachine['place']>['kind'], string> = {
  elevator: 'At',
  shop: 'At',
  bin_site: 'At',
  fuel: 'Fueling at',
  field_entrance: 'At',
};

/** Main line: what the machine is doing (or why it is down). */
export function rowHeadline(row: PanelRow): string {
  const m = row.machine;
  if (m.status === 'down') return m.downReason ? `Down: ${m.downReason}` : 'Down';
  if (!m.position) return 'No position yet';
  if (row.stale) return 'No recent position';
  const speed = m.position.speedMph >= 1 ? ` · ${Math.round(m.position.speedMph)} mph` : '';
  return `${ACTIVITY_LABELS[m.position.activity]}${speed}`;
}

/** Second line: where it is (a geofence, a field), or since when and by whom it is down. */
export function rowDetail(row: PanelRow): string | null {
  const m = row.machine;
  if (m.status === 'down') {
    const since = m.downAt ? `since ${formatClock(new Date(m.downAt)).time}` : null;
    return [since, m.downBy ? `by ${m.downBy}` : null].filter(Boolean).join(' · ') || null;
  }
  if (m.place) {
    return `${PLACE_PREFIX[m.place.kind]} ${m.place.name} since ${formatClock(new Date(m.place.since)).time}`;
  }
  if (m.position?.fieldName) return `In ${m.position.fieldName}`;
  return null;
}

/** "Seen 12 s ago" / "Never seen". */
export function rowAge(row: PanelRow, now: number): string {
  const ts = row.machine.position?.ts;
  return ts ? `Seen ${formatAge(ts, now)}` : 'Never seen';
}
