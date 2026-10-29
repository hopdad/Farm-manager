'use client';
/**
 * Parcels tab (plan 1d "Parcels import (D7) … with owner names"; contract ../tabs.ts, order 40).
 * Owner: imagery. Renders from `detail.parcels` (the tax parcels overlapping the field's current
 * boundary, largest overlap first, loaded with the rest of the field): owner and mailing address,
 * the parcel's acres (the county file's and the mapped area) and how much of the field lies in it.
 *
 * Owner names and mailing addresses are for managers and owners (`canSeeParcelOwners`): below
 * that the server leaves them out (redactParcelOwners) and the tab says who may see them. The
 * synthetic demo parcels (D7) are labelled as such.
 *
 * Wall: one card per parcel with 72 px rows; phone: compact cards. Styles are inline (the panel's
 * CSS module is the field-panel builder's) and follow the panel's variables (--font, --target),
 * inheriting its text colour so they read on the dark wall and the light phone sheet.
 */
import type { CSSProperties } from 'react';
import { canSeeParcelOwners } from '../../../db/queries/parcels-access';
import type { FieldDetail } from '../../../domain/fields';
import type { FieldParcelRow } from '../../../domain/parcels';
import type { Role } from '../../../platform/auth/types';
import { type FieldPanelTab, type FieldPanelTabProps, TAB_ORDER } from '../tabs';

// ---------------------------------------------------------------------------------------------
// View model (pure; unit-tested)
// ---------------------------------------------------------------------------------------------

export interface ParcelCard {
  id: string;
  parcelNo: string;
  county: string;
  /** null when hidden for the role or not in the file. */
  owner: string | null;
  mailing: string | null;
  address: string | null;
  /** '80 ac (file) · 79.9 ac mapped'. */
  acres: string;
  /** '79.8 ac of this field (99.8 %)'. */
  overlap: string;
  overlapPct: number;
  synthetic: boolean;
}

export interface ParcelsTabView {
  empty: boolean;
  /** Owner names shown to this role? */
  ownersVisible: boolean;
  cards: ParcelCard[];
  /** '2 parcels · 159.6 ac of the field'. */
  summary: string | null;
  /** Shown when the parcels cover noticeably less than the field. */
  gap: string | null;
  /** 'Synthetic demo parcels (fictional owners)…' when any parcel is from the D7 fixture. */
  sourceNote: string | null;
}

const COUNTY_NAMES: Record<string, string> = { '26091': 'Lenawee', '26115': 'Monroe' };

const fmtAcres = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
const fmtPct = (n: number) => (n >= 9.95 ? n.toFixed(0) : n.toFixed(1));

function acresText(p: FieldParcelRow): string {
  const mapped = `${fmtAcres(p.gisAcres)} ac mapped`;
  return p.acres !== null ? `${fmtAcres(p.acres)} ac (file) · ${mapped}` : mapped;
}

/** The parcels cover less than this share of the field: say so (a gap in the county file). */
export const GAP_PCT = 98;

export function parcelsTabView(detail: FieldDetail, role: Role): ParcelsTabView {
  const ownersVisible = canSeeParcelOwners(role);
  const rows = detail.parcels;
  const cards: ParcelCard[] = rows.map((p) => ({
    id: p.id,
    parcelNo: p.parcelNo,
    county: COUNTY_NAMES[p.countyFips] ?? p.countyFips,
    owner: ownersVisible ? p.ownerName : null,
    mailing: ownersVisible ? p.ownerMailing : null,
    address: p.propertyAddress,
    acres: acresText(p),
    overlap: `${fmtAcres(p.overlapAcres)} ac of this field (${fmtPct(p.overlapPct)} %)`,
    overlapPct: p.overlapPct,
    synthetic: p.importSource === 'synthetic',
  }));
  if (cards.length === 0) {
    return { empty: true, ownersVisible, cards, summary: null, gap: null, sourceNote: null };
  }
  const coveredAcres = rows.reduce((s, p) => s + p.overlapAcres, 0);
  const coveredPct = rows.reduce((s, p) => s + p.overlapPct, 0);
  const summary = `${cards.length} parcel${cards.length === 1 ? '' : 's'} · ${fmtAcres(coveredAcres)} ac of the field`;
  const gap =
    coveredPct < GAP_PCT
      ? `Parcels cover ${fmtPct(coveredPct)} % of the field: the parcel file may have a gap here.`
      : null;
  const sourceNote = cards.some((c) => c.synthetic)
    ? 'Synthetic demo parcels (fictional owners) until a county file is loaded (D7).'
    : null;
  return { empty: false, ownersVisible, cards, summary, gap, sourceNote };
}

// ---------------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------------

const S = {
  section: { margin: '0 0 20px' },
  title: {
    margin: '0 0 10px',
    fontSize: 'calc(var(--font, 18px) * 0.72)',
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    opacity: 0.65,
  },
  muted: { opacity: 0.7 },
  card: {
    border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
    borderRadius: 12,
    padding: '10px 14px',
    margin: '0 0 12px',
    display: 'grid',
    gap: 4,
  },
  head: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
    minHeight: 'calc(var(--target, 48px) * 0.6)',
  },
  owner: { fontWeight: 700, fontSize: 'calc(var(--font, 18px) * 1.05)' },
  number: {
    fontVariantNumeric: 'tabular-nums',
    fontSize: 'calc(var(--font, 18px) * 0.8)',
    opacity: 0.75,
    whiteSpace: 'nowrap',
  },
  line: { fontSize: 'calc(var(--font, 18px) * 0.85)' },
  bar: {
    height: 8,
    borderRadius: 4,
    background: 'color-mix(in srgb, currentColor 14%, transparent)',
    overflow: 'hidden',
    margin: '4px 0 2px',
  },
  fill: { height: '100%', background: '#e879f9' },
  notice: {
    margin: '8px 0 0',
    padding: '8px 12px',
    borderRadius: 8,
    background: 'color-mix(in srgb, #f59e0b 18%, transparent)',
    fontSize: 'calc(var(--font, 18px) * 0.8)',
  },
  foot: { fontSize: 'calc(var(--font, 18px) * 0.75)', opacity: 0.65, margin: '8px 0 0' },
  skeleton: {
    height: 'calc(var(--font, 18px) * 1.2)',
    borderRadius: 6,
    background: 'color-mix(in srgb, currentColor 10%, transparent)',
    margin: '0 0 10px',
  },
} satisfies Record<string, CSSProperties>;

export function ParcelsBody({
  view,
  variant,
}: {
  view: ParcelsTabView;
  variant: 'wall' | 'phone';
}) {
  if (view.empty) {
    return (
      <section style={S.section} data-testid="field-parcels-empty">
        <h3 style={S.title}>Parcels</h3>
        <p style={S.muted}>No tax parcels overlap this field.</p>
        <p style={S.foot}>Load the county parcel file with pnpm gis:parcels.</p>
      </section>
    );
  }
  return (
    <section style={S.section} data-testid="field-parcels">
      <h3 style={S.title}>Parcels</h3>
      <div style={{ ...S.muted, margin: '0 0 10px' }} data-testid="field-parcels-summary">
        {view.summary}
      </div>
      {view.cards.map((c) => (
        <article
          key={c.id}
          style={{ ...S.card, ...(variant === 'phone' ? { padding: '8px 10px' } : {}) }}
          data-testid="field-parcel"
          data-parcel-no={c.parcelNo}
        >
          <div style={S.head}>
            <span style={S.owner} data-testid="field-parcel-owner">
              {view.ownersVisible ? (c.owner ?? 'Owner not in file') : 'Owner: managers only'}
            </span>
            <span style={S.number}>
              {c.parcelNo} · {c.county}
            </span>
          </div>
          {view.ownersVisible && c.mailing && (
            <div style={S.line} data-testid="field-parcel-mailing">
              {c.mailing}
            </div>
          )}
          {c.address && <div style={{ ...S.line, ...S.muted }}>Site: {c.address}</div>}
          <div style={S.bar} aria-hidden="true">
            <div style={{ ...S.fill, width: `${Math.min(100, Math.max(0, c.overlapPct))}%` }} />
          </div>
          <div style={S.line} data-testid="field-parcel-overlap">
            {c.overlap}
          </div>
          <div style={{ ...S.line, ...S.muted }} data-testid="field-parcel-acres">
            Parcel: {c.acres}
          </div>
        </article>
      ))}
      {view.gap && <div style={S.notice}>{view.gap}</div>}
      {view.sourceNote && (
        <p style={S.foot} data-testid="field-parcels-source">
          {view.sourceNote}
        </p>
      )}
    </section>
  );
}

export function ParcelsTab({ detail, variant, role }: FieldPanelTabProps) {
  if (!detail) {
    return (
      <section style={S.section} aria-busy="true">
        {[70, 90, 55].map((w) => (
          <div key={w} style={{ ...S.skeleton, width: `${w}%` }} />
        ))}
      </section>
    );
  }
  return <ParcelsBody view={parcelsTabView(detail, role)} variant={variant} />;
}

export const parcelsTab: FieldPanelTab = {
  id: 'parcels',
  label: 'Parcels',
  order: TAB_ORDER.parcels,
  Component: ParcelsTab,
};
