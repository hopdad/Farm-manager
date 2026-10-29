/**
 * What the field panel shows, as plain strings (pure; unit-tested): the header (name, acres,
 * tenure, farm/client), who owns or rents it, the boundary line, the 5-season table, notes and
 * the open-jobs placeholder. Components only lay this out. Times show in America/Detroit;
 * calendar dates (planted, harvested) are shown as stored, never shifted by a time zone.
 */
import type { Tenure } from '../../domain/farm';
import { FARM_TIME_ZONE } from '../../domain/farm';
import type { FieldDetail, PartyRef, SeasonRow } from '../../domain/fields';
import { COUNTY_FIPS } from '../../domain/parcels';
import { ROLE_FOR, type Role, roleAtLeast } from '../../platform/auth/types';
import { TENURE_COLORS, TENURE_LABELS } from '../map/style';

export interface PartyView {
  /** 'Landlord', 'Customer' or 'Owner'. */
  role: 'Landlord' | 'Customer' | 'Owner';
  name: string;
  /** The party when there is one (contact details below); null for your own operation. */
  party: PartyRef | null;
  phone: string | null;
  email: string | null;
  /** True when the field's tenure needs a party the records don't have yet. */
  missing: boolean;
}

export interface SeasonView {
  cropYear: number;
  crop: string;
  variety: string;
  planted: string;
  harvested: string;
  yield: string;
  /** The yield without its unit ("197.9"; "—"), for a column headed bu/ac. */
  yieldValue: string;
  /** Where the row came from ('Demo', 'Import', 'Deere', 'App'). */
  source: string;
}

export interface NotesView {
  text: string | null;
  /** "Edited 5 min ago by Dana Ruiz", "Edited Oct 12, 2026"; null when never edited in the app. */
  edited: string | null;
  canEdit: boolean;
  version: string;
}

export interface BoundaryView {
  acres: string;
  /** "John Deere Operations Center", "Imported file", … */
  source: string;
  since: string;
  editable: boolean;
  readOnlyReason: string | null;
  /** "1 change request open in Operations Center", else null. */
  openRequests: string | null;
}

export interface FieldPanelView {
  title: string;
  acres: string | null;
  tenure: { key: Tenure; label: string; color: string };
  farm: string;
  /** The custom-work customer's name, when the farm is a client's. */
  client: string | null;
  county: string | null;
  party: PartyView;
  boundary: BoundaryView | null;
  seasons: SeasonView[];
  notes: NotesView;
  openJobs: string;
  inactive: boolean;
}

const COUNTY_NAMES: Record<string, string> = {
  [COUNTY_FIPS.lenawee]: 'Lenawee County',
  [COUNTY_FIPS.monroe]: 'Monroe County',
};

export const BOUNDARY_SOURCE_LABELS: Record<string, string> = {
  deere: 'John Deere Operations Center',
  import: 'Imported file',
  drawn: 'Drawn in the app',
  demo: 'Demo farm',
  sim: 'Simulator',
};

const SEASON_SOURCE_LABELS: Record<string, string> = {
  demo: 'Demo',
  import: 'Import',
  deere: 'Deere',
  app: 'App',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const DASH = '—';

/** "74.4 ac", "1,234.5 ac"; null stays null. */
export function formatAcres(acres: number | null): string | null {
  if (acres === null || !Number.isFinite(acres)) return null;
  return `${acres.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ac`;
}

/** "Soybeans", "Corn", "Winter wheat"; null → "—". */
export function formatCrop(crop: string | null): string {
  const c = crop?.trim().replace(/_/g, ' ');
  if (!c) return DASH;
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/**
 * A calendar date (YYYY-MM-DD) as "May 8", with the year when it isn't `cropYear`
 * ("Jan 4, 2026" for a harvest that ran into the next year). Never time-zone shifted.
 */
export function formatSeasonDate(ymd: string | null, cropYear?: number): string {
  if (!ymd) return DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const [, y, mo, d] = m;
  const month = MONTHS[Number(mo) - 1];
  if (!month) return ymd;
  const base = `${month} ${Number(d)}`;
  return cropYear !== undefined && Number(y) === cropYear ? base : `${base}, ${y}`;
}

/** "197.9 bu/ac"; null → "—". */
export function formatYield(buAc: number | null): string {
  if (buAc === null || !Number.isFinite(buAc)) return DASH;
  return `${buAc.toFixed(1)} bu/ac`;
}

const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: FARM_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** "just now", "5 min ago", "3 h ago" within two days; else "Oct 12, 2026" (America/Detroit). */
export function formatWhen(isoTs: string, now: number): string {
  const t = Date.parse(isoTs);
  if (Number.isNaN(t)) return 'at an unknown time';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return dateFmt.format(new Date(t)).replace(/\s/g, ' ');
}

export function seasonView(s: SeasonRow): SeasonView {
  return {
    cropYear: s.cropYear,
    crop: formatCrop(s.crop),
    variety: s.variety?.trim() || DASH,
    planted: formatSeasonDate(s.plantedOn, s.cropYear),
    harvested: formatSeasonDate(s.harvestedOn, s.cropYear),
    yield: formatYield(s.yieldBuAc),
    yieldValue:
      s.yieldBuAc === null || !Number.isFinite(s.yieldBuAc) ? DASH : s.yieldBuAc.toFixed(1),
    source: SEASON_SOURCE_LABELS[s.source] ?? s.source,
  };
}

/**
 * Who the panel names (plan 1a "owner or landlord"): the custom-work customer for a client's
 * field, the landlord for rented or share ground, else your own operation as the owner.
 */
export function partyView(field: FieldDetail['field']): PartyView {
  const of = (role: PartyView['role'], p: PartyRef): PartyView => ({
    role,
    name: p.displayName,
    party: p,
    phone: p.phone,
    email: p.email,
    missing: false,
  });
  if (field.customer) return of('Customer', field.customer);
  if (field.landlord) return of('Landlord', field.landlord);
  const rented = field.tenure === 'cash_rent' || field.tenure === 'share';
  if (rented || field.tenure === 'custom') {
    return {
      role: rented ? 'Landlord' : 'Customer',
      name: 'Not recorded yet',
      party: null,
      phone: null,
      email: null,
      missing: true,
    };
  }
  return {
    role: 'Owner',
    name: 'Your operation',
    party: null,
    phone: null,
    email: null,
    missing: false,
  };
}

export function notesView(notes: FieldDetail['notes'], role: Role, now: number): NotesView {
  let edited: string | null = null;
  if (notes.updatedAt) {
    edited = `Edited ${formatWhen(notes.updatedAt, now)}`;
    if (notes.updatedByName) edited += ` by ${notes.updatedByName}`;
  }
  return {
    text: notes.text,
    edited,
    canEdit: roleAtLeast(role, ROLE_FOR.editFieldNotes),
    version: notes.version,
  };
}

export function boundaryView(detail: FieldDetail): BoundaryView | null {
  const b = detail.boundary;
  if (!b) return null;
  const n = detail.openBoundaryRequests;
  return {
    acres: formatAcres(b.acres) ?? DASH,
    source: BOUNDARY_SOURCE_LABELS[b.source] ?? b.source,
    since: formatSeasonDate(b.validFrom.slice(0, 10)),
    editable: b.editable,
    readOnlyReason: b.readOnlyReason,
    openRequests:
      n > 0 ? `${n} change request${n === 1 ? '' : 's'} open in Operations Center` : null,
  };
}

/** The whole panel. `now` (ms) only feeds the "edited … ago" text. */
export function fieldPanelView(detail: FieldDetail, role: Role, now: number): FieldPanelView {
  const f = detail.field;
  return {
    title: f.name,
    acres: formatAcres(f.acres),
    tenure: { key: f.tenure, label: TENURE_LABELS[f.tenure], color: TENURE_COLORS[f.tenure] },
    farm: f.farmName,
    client: f.customer?.displayName ?? null,
    county: f.countyFips ? (COUNTY_NAMES[f.countyFips] ?? `County ${f.countyFips}`) : null,
    party: partyView(f),
    boundary: boundaryView(detail),
    seasons: detail.seasons.map(seasonView),
    notes: notesView(detail.notes, role, now),
    openJobs:
      detail.openJobs.count > 0
        ? `${detail.openJobs.count} open`
        : 'Open jobs show here once the job board arrives (M2).',
    inactive: !f.active,
  };
}
