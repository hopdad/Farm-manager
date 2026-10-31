/** What a fleet panel row says (pure; times in America/Detroit like the rest of the board). */
import type { VehicleStatField } from '../../connectors/types';
import { vendorLabel } from '../../connectors/vendors';
import { type ActiveFaultCode, sortFaultCodes } from '../../domain/fault-codes';
import { ACTIVITY_LABELS, formatAge, formatClock } from '../board/format';
import { formatVehicleStat } from '../vehicles/stats';
import type { PanelMachine } from './contract';
import type { PanelRow } from './model';

const PLACE_PREFIX: Record<NonNullable<PanelMachine['place']>['kind'], string> = {
  elevator: 'At',
  shop: 'At',
  bin_site: 'At',
  fuel: 'Fueling at',
  field_entrance: 'At',
};

/** "Last working position, 7 min ago" (a Deere-only machine that stopped working, 1f). */
export function lastWorkingText(ts: string, now: number): string {
  const minutes = Math.max(1, Math.round((now - Date.parse(ts)) / 60_000));
  if (minutes < 90) return `Last working position, ${minutes} min ago`;
  return `Last working position, ${formatAge(ts, now)}`;
}

/** "Last known position from Kubota (AEMP)" (a vendor snapshot, not a live tracker; 1f review). */
export function lastKnownText(vendor: string | null | undefined): string {
  return vendor ? `Last known position from ${vendorLabel(vendor)}` : 'Last known position';
}

/** Main line: what the machine is doing (or why it is down). */
export function rowHeadline(row: PanelRow, now: number = Date.now()): string {
  const m = row.machine;
  if (m.status === 'down') return m.downReason ? `Down: ${m.downReason}` : 'Down';
  if (!m.position) return 'No position yet';
  if (row.lastWorking) return lastWorkingText(m.position.ts, now);
  if (row.stale) return 'No recent position';
  // A vendor snapshot (AEMP, CNH's hourly fleet, Terminal's latest location) has no speed or
  // heading worth showing: say what it is (1f review), never "Idle · 0 mph".
  if (m.position.positionKind === 'last_known') return lastKnownText(m.position.vendor);
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

/** The stats a row shows, with the label each reads under ("4,312 h", "fuel 62 %"). */
const ROW_STATS: readonly { field: Exclude<VehicleStatField, 'engineOn'>; label: string }[] = [
  { field: 'engineHours', label: 'hours' },
  { field: 'odometerMi', label: 'odometer' },
  { field: 'fuelPct', label: 'fuel' },
  { field: 'defPct', label: 'DEF' },
];

/**
 * The row's stats line (1f, `formatVehicleStat`): engine hours, odometer and fuel always ("—"
 * when none is known yet, "not reported" when the machine's route doesn't report it, never 0);
 * DEF only when known. "4,312 h · 412,300 mi · fuel 62 %", "hours not reported · … · fuel 54 %".
 */
export function rowStats(
  m: Pick<PanelMachine, 'engineHours' | 'odometerMi' | 'fuelPct' | 'defPct' | 'notReported'>,
): string {
  const notReported = m.notReported ?? [];
  const parts: string[] = [];
  for (const { field, label } of ROW_STATS) {
    const value = m[field] ?? null;
    if (field === 'defPct' && value === null) continue;
    const text = formatVehicleStat(field, value, notReported);
    // A number reads with its unit alone where the unit says what it is (h, mi); levels and the
    // missing ones carry their label.
    const unitSays = value !== null && (field === 'engineHours' || field === 'odometerMi');
    parts.push(unitSays ? text : `${label} ${text}`);
  }
  return parts.join(' · ');
}

/** The fault badge text: "Critical: J1939 SPN 110 FMI 0" (+ "+2" for more codes). */
export function faultBadgeText(faults: readonly ActiveFaultCode[]): string | null {
  const sorted = sortFaultCodes(faults);
  const worst = sorted[0];
  if (!worst) return null;
  const level =
    worst.severity === 'critical' ? 'Critical' : worst.severity === 'warning' ? 'Warning' : 'Info';
  const more = sorted.length > 1 ? ` +${sorted.length - 1}` : '';
  return `${level}: ${worst.code}${more}`;
}

/** Longest description line under a fault badge (the full text stays in the title). */
export const FAULT_DESCRIPTION_CHARS = 70;

/**
 * The worst code's plain-language meaning, shortened, for the line under the badge (1f review:
 * a touch wall and a phone never show the title, so "J1939 SPN 110 FMI 0" alone says nothing):
 * "Engine coolant temperature: Data valid but above normal…". Null when the vendor sent none.
 */
export function faultDescriptionText(faults: readonly ActiveFaultCode[]): string | null {
  const d = sortFaultCodes(faults)[0]?.description?.replace(/\s+/g, ' ').trim();
  if (!d) return null;
  return d.length <= FAULT_DESCRIPTION_CHARS ? d : `${d.slice(0, FAULT_DESCRIPTION_CHARS - 1)}…`;
}

/** Every active code on its own line (the badge's title: hover on the wall, long-press on a phone). */
export function faultListText(faults: readonly ActiveFaultCode[], now: number): string {
  return sortFaultCodes(faults)
    .map(
      (f) =>
        `${f.severity.toUpperCase()} ${f.code}${f.description ? `: ${f.description}` : ''} (since ${formatAge(f.since, now)})`,
    )
    .join('\n');
}
