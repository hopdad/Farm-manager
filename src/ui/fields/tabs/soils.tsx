'use client';
/**
 * Soils tab (plan 1c "Field soils tab: series, drainage and percentage, plus weighted NCCPI";
 * contract ../tabs.ts, order 30). Owner: soils. Renders from `detail.soils` (gis.field_soils of
 * the current boundary ⋈ gis.soil_mapunits, loaded with the rest of the field) and
 * `detail.soilsSummary`; fetches only the soils layer's source line (GET /api/layers) to say which
 * survey it is, or that the synthetic test fixture is loaded.
 *
 * Wall: a table with 72 px rows; phone: a list. Styles are inline (the panel's CSS module is the
 * field-panel builder's) and follow the panel's variables: --font, --target. Each map unit's
 * symbol opens the soil map unit sheet (its components; ../../soils/MapUnitSheet.tsx) over the
 * panel.
 */
import { type CSSProperties, useEffect, useState } from 'react';
import type { FieldDetail } from '../../../domain/fields';
import type { MapLayersResponse } from '../../../domain/map-layers';
import {
  DRAINAGE_CLASSES,
  type FieldSoilRow,
  type FieldSoilsSummary,
  summarizeFieldSoils,
} from '../../../domain/soils';
import { DRAINAGE_COLORS, DRAINAGE_UNKNOWN_COLOR } from '../../map/layers/soils';
import type { MapUnitPreview } from '../../soils/map-unit';
import { useMapUnitSheet } from '../../soils/sheet-store';
import { type FieldPanelTab, type FieldPanelTabProps, TAB_ORDER } from '../tabs';

// ---------------------------------------------------------------------------------------------
// View model (pure; unit-tested)
// ---------------------------------------------------------------------------------------------

export interface SoilsTabRow {
  mukey: string;
  symbol: string;
  name: string;
  series: string | null;
  drainage: string;
  drainageColor: string;
  hydgrp: string;
  acres: string;
  pct: string;
  nccpi: string;
}

export interface SoilsTabView {
  empty: boolean;
  /** '0.61' or '—'. */
  weightedNccpi: string;
  /** 0-100 for the gauge; null when unknown. */
  nccpiPercent: number | null;
  /** Shown when the soils don't cover the whole boundary. */
  coverage: string | null;
  /** 'Mostly Blount (BnB), somewhat poorly drained · 62 %'. */
  dominant: string | null;
  drainage: { label: string; color: string; pct: number; text: string }[];
  rows: SoilsTabRow[];
  /** "2 slivers along the edges (under 0.05 %) not listed", or null. */
  slivers: string | null;
}

/**
 * Map units covering less than this share of the boundary (percent) are edge slivers where a
 * boundary grazes a neighbouring soil polygon: kept in the data and the weighted NCCPI, not listed.
 */
export const SLIVER_PCT = 0.05;

const colorOf = (c: string | null) =>
  c && (DRAINAGE_CLASSES as readonly string[]).includes(c)
    ? DRAINAGE_COLORS[c as (typeof DRAINAGE_CLASSES)[number]]
    : DRAINAGE_UNKNOWN_COLOR;

const fmtPct = (n: number) => (n >= 9.95 || n === 0 ? n.toFixed(0) : n.toFixed(1));
const fmtAcres = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

/** Drainage order for display: driest first, unknown last. */
const drainageRank = (c: string) => {
  const i = (DRAINAGE_CLASSES as readonly string[]).indexOf(c);
  return i === -1 ? DRAINAGE_CLASSES.length : i;
};

export function soilsTabView(
  soils: readonly FieldSoilRow[],
  summary: FieldSoilsSummary | null = soils.length ? summarizeFieldSoils(soils) : null,
): SoilsTabView {
  if (soils.length === 0 || !summary) {
    return {
      empty: true,
      weightedNccpi: '—',
      nccpiPercent: null,
      coverage: null,
      dominant: null,
      drainage: [],
      rows: [],
      slivers: null,
    };
  }
  const d = summary.dominant;
  const listed = soils.filter((r) => r.pct >= SLIVER_PCT);
  const hidden = soils.length - listed.length;
  return {
    empty: false,
    weightedNccpi: summary.weightedNccpi === null ? '—' : summary.weightedNccpi.toFixed(2),
    nccpiPercent: summary.weightedNccpi === null ? null : Math.round(summary.weightedNccpi * 100),
    coverage:
      summary.coveredPct < 99.5
        ? `Soils cover ${fmtPct(summary.coveredPct)} % of the boundary`
        : null,
    dominant: d
      ? `Mostly ${d.dominantComponent ?? d.muname}${d.musym ? ` (${d.musym})` : ''}${
          d.drainageClass ? `, ${d.drainageClass.toLowerCase()}` : ''
        } · ${fmtPct(d.pct)} %`
      : null,
    drainage: summary.drainage
      .filter((x) => x.pct >= SLIVER_PCT)
      .sort((a, b) => drainageRank(a.drainageClass) - drainageRank(b.drainageClass))
      .map((x) => ({
        label: x.drainageClass === 'Unknown' ? 'Not rated' : x.drainageClass,
        color: colorOf(x.drainageClass === 'Unknown' ? null : x.drainageClass),
        pct: x.pct,
        text: `${fmtPct(x.pct)} %`,
      })),
    rows: listed
      .sort((a, b) => b.acres - a.acres || a.mukey.localeCompare(b.mukey))
      .map((r) => ({
        mukey: r.mukey,
        symbol: r.musym ?? '—',
        name: r.muname,
        series: r.dominantComponent,
        drainage: r.drainageClass ?? 'Not rated',
        drainageColor: colorOf(r.drainageClass),
        hydgrp: r.hydgrp ?? '—',
        acres: fmtAcres(r.acres),
        pct: `${fmtPct(r.pct)} %`,
        nccpi: r.nccpi === null ? '—' : r.nccpi.toFixed(2),
      })),
    slivers:
      hidden > 0
        ? `${hidden} sliver${hidden === 1 ? '' : 's'} along the edges (under ${SLIVER_PCT} %) not listed`
        : null,
  };
}

// ---------------------------------------------------------------------------------------------
// The soils layer's source line (which survey; synthetic or not)
// ---------------------------------------------------------------------------------------------

export interface SoilsSource {
  text: string;
  synthetic: boolean;
}

export function soilsSourceOf(res: MapLayersResponse | null): SoilsSource | null {
  const row = res?.layers.find((l) => l.key === 'soils');
  if (!row) return null;
  const synthetic = row.meta.fixture === true;
  if (synthetic) return { text: 'Synthetic test fixture, not survey data', synthetic };
  return { text: row.sourceVintage ?? row.attribution ?? 'USDA NRCS SSURGO', synthetic };
}

let sourcePromise: Promise<SoilsSource | null> | null = null;

function loadSoilsSource(): Promise<SoilsSource | null> {
  sourcePromise ??= fetch('/api/layers', { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<MapLayersResponse>) : null))
    .then(soilsSourceOf)
    .catch(() => {
      sourcePromise = null;
      return null;
    });
  return sourcePromise;
}

function useSoilsSource(enabled: boolean): SoilsSource | null {
  const [source, setSource] = useState<SoilsSource | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadSoilsSource().then((s) => {
      if (live) setSource(s);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return source;
}

// ---------------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------------

const S = {
  section: { margin: '0 0 24px' },
  title: {
    margin: '0 0 10px',
    fontSize: 'calc(var(--font, 18px) * 0.72)',
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'rgb(231 239 233 / 65%)',
  },
  muted: { color: 'rgb(231 239 233 / 70%)' },
  big: { fontSize: 'calc(var(--font, 18px) * 2)', fontWeight: 800, lineHeight: 1.1 },
  gauge: {
    position: 'relative',
    height: 14,
    borderRadius: 7,
    background: 'linear-gradient(90deg, #7f1d1d, #ca8a04 50%, #16a34a)',
    margin: '10px 0 4px',
  },
  needle: {
    position: 'absolute',
    top: -4,
    width: 6,
    height: 22,
    marginLeft: -3,
    borderRadius: 3,
    background: '#f4f7f2',
    boxShadow: '0 0 0 2px #0d1512',
  },
  bar: {
    display: 'flex',
    height: 18,
    borderRadius: 9,
    overflow: 'hidden',
    margin: '8px 0 10px',
  },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px 14px',
    fontSize: 'calc(var(--font, 18px) * 0.8)',
  },
  swatch: {
    display: 'inline-block',
    width: '0.9em',
    height: '0.9em',
    borderRadius: 3,
    marginRight: 6,
    verticalAlign: '-0.1em',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'calc(var(--font, 18px) * 0.85)' },
  th: {
    textAlign: 'left',
    padding: '6px 8px',
    fontWeight: 600,
    color: 'rgb(231 239 233 / 65%)',
    borderBottom: '1px solid rgb(255 255 255 / 14%)',
  },
  td: { padding: '8px', borderBottom: '1px solid rgb(255 255 255 / 8%)', verticalAlign: 'middle' },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  item: {
    padding: '10px 0',
    borderBottom: '1px solid rgb(255 255 255 / 8%)',
    display: 'grid',
    gap: 4,
  },
  notice: {
    marginTop: 10,
    padding: '10px 14px',
    borderLeft: '4px solid #fbbf24',
    borderRadius: 8,
    background: 'rgb(251 191 36 / 8%)',
    fontSize: 'calc(var(--font, 18px) * 0.85)',
  },
  foot: { fontSize: 'calc(var(--font, 18px) * 0.72)', color: 'rgb(231 239 233 / 60%)' },
  open: {
    minHeight: 'calc(var(--target, 56px) * 0.8)',
    minWidth: 'calc(var(--target, 56px) * 1.1)',
    padding: '0 10px',
    borderRadius: 10,
    border: '1px solid rgb(125 211 252 / 45%)',
    background: 'rgb(56 189 248 / 10%)',
    color: '#bae6fd',
    font: 'inherit',
    fontWeight: 700,
    cursor: 'pointer',
    touchAction: 'manipulation',
  },
  skeleton: {
    height: '1.2em',
    borderRadius: 6,
    background: 'rgb(255 255 255 / 8%)',
    margin: '0 0 12px',
  },
} satisfies Record<string, CSSProperties>;

function Swatch({ color }: { color: string }) {
  return <span aria-hidden="true" style={{ ...S.swatch, background: color }} />;
}

/** A field soil row as what the map unit sheet opens with. */
export function mapUnitPreviewOf(r: FieldSoilRow): MapUnitPreview {
  return {
    mukey: r.mukey,
    musym: r.musym,
    muname: r.muname,
    drainage_class: r.drainageClass,
    hydgrp: r.hydgrp,
    farmland_class: r.farmlandClass,
    nccpi: r.nccpi,
  };
}

/** The map unit's symbol, as a button that opens its sheet (components, series description). */
function OpenMapUnit({ row, symbol }: { row: FieldSoilRow | undefined; symbol: string }) {
  if (!row) return <>{symbol}</>;
  return (
    <button
      type="button"
      style={S.open}
      aria-label={`Map unit ${symbol}: components and series`}
      onClick={() => useMapUnitSheet.getState().show(mapUnitPreviewOf(row))}
      data-testid="field-soils-open-mapunit"
    >
      {symbol} ›
    </button>
  );
}

export function SoilsTab({ detail, variant }: FieldPanelTabProps) {
  const source = useSoilsSource(detail !== null);
  if (!detail) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading soils"
        data-testid="field-soils-loading"
      >
        {[50, 80, 65, 90].map((w) => (
          <div key={w} style={{ ...S.skeleton, width: `${w}%` }} />
        ))}
      </div>
    );
  }
  return <SoilsBody detail={detail} variant={variant} source={source} />;
}

/** The tab's content for a loaded detail (exported for render tests). */
export function SoilsBody({
  detail,
  variant,
  source,
}: {
  detail: FieldDetail;
  variant: 'wall' | 'phone';
  source: SoilsSource | null;
}) {
  const v = soilsTabView(detail.soils, detail.soilsSummary);
  const byMukey = new Map(detail.soils.map((r) => [r.mukey, r]));
  if (v.empty) {
    return (
      <section style={S.section} data-testid="field-soils-empty">
        <h3 style={S.title}>Soils</h3>
        <p style={S.muted}>No soils loaded for this boundary.</p>
        <p style={S.foot}>
          On the PC, <code>pnpm gis:soils</code> loads SSURGO soils for Lenawee and Monroe from USDA
          NRCS; every field gets its soils as soon as they arrive.
        </p>
      </section>
    );
  }
  const wall = variant === 'wall';
  return (
    <div data-testid="field-soils">
      <section style={S.section}>
        <h3 style={S.title}>Productivity (NCCPI)</h3>
        <div style={S.big} data-testid="field-soils-nccpi">
          {v.weightedNccpi}
        </div>
        {v.nccpiPercent !== null && (
          <div style={S.gauge} aria-hidden="true" data-testid="field-soils-gauge">
            <span style={{ ...S.needle, left: `${v.nccpiPercent}%` }} />
          </div>
        )}
        <div style={S.muted}>
          Acre-weighted over the map units below · 0 to 1, higher is more productive
        </div>
        {v.dominant && <div style={{ marginTop: 8 }}>{v.dominant}</div>}
        {v.coverage && (
          <div style={S.notice} data-testid="field-soils-coverage">
            {v.coverage}
          </div>
        )}
      </section>

      <section style={S.section} data-testid="field-soils-drainage">
        <h3 style={S.title}>Drainage</h3>
        <div style={S.bar} aria-hidden="true">
          {v.drainage.map((d) => (
            <span key={d.label} style={{ width: `${d.pct}%`, background: d.color }} />
          ))}
        </div>
        <div style={S.chips}>
          {v.drainage.map((d) => (
            <span key={d.label}>
              <Swatch color={d.color} />
              {d.label} {d.text}
            </span>
          ))}
        </div>
      </section>

      <section style={S.section}>
        <h3 style={S.title}>Map units</h3>
        {wall ? (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Symbol</th>
                <th style={S.th}>Soil</th>
                <th style={S.th}>Drainage</th>
                <th style={S.th}>Hyd. group</th>
                <th style={{ ...S.th, ...S.num }}>Acres</th>
                <th style={{ ...S.th, ...S.num }}>Share</th>
                <th style={{ ...S.th, ...S.num }}>NCCPI</th>
              </tr>
            </thead>
            <tbody>
              {v.rows.map((r) => (
                <tr
                  key={r.mukey}
                  data-testid="field-soils-row"
                  data-mukey={r.mukey}
                  style={{ height: 'var(--target, 56px)' }}
                >
                  <td style={{ ...S.td, fontWeight: 700 }}>
                    <OpenMapUnit row={byMukey.get(r.mukey)} symbol={r.symbol} />
                  </td>
                  <td style={S.td}>
                    <div>{r.series ?? r.name}</div>
                    <div style={{ ...S.muted, fontSize: '0.85em' }}>{r.name}</div>
                  </td>
                  <td style={S.td}>
                    <Swatch color={r.drainageColor} />
                    {r.drainage}
                  </td>
                  <td style={S.td}>{r.hydgrp}</td>
                  <td style={{ ...S.td, ...S.num }}>{r.acres}</td>
                  <td style={{ ...S.td, ...S.num }}>{r.pct}</td>
                  <td style={{ ...S.td, ...S.num }}>{r.nccpi}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div>
            {v.rows.map((r) => (
              <div key={r.mukey} style={S.item} data-testid="field-soils-row" data-mukey={r.mukey}>
                <div>
                  <OpenMapUnit row={byMukey.get(r.mukey)} symbol={r.symbol} />{' '}
                  <strong>{r.series ?? r.name}</strong>
                  <span style={{ float: 'right', ...S.num }}>
                    {r.pct} · {r.acres} ac
                  </span>
                </div>
                <div style={S.muted}>{r.name}</div>
                <div style={{ fontSize: '0.9em' }}>
                  <Swatch color={r.drainageColor} />
                  {r.drainage} · group {r.hydgrp} · NCCPI {r.nccpi}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {v.slivers && (
        <p style={S.foot} data-testid="field-soils-slivers">
          {v.slivers}
        </p>
      )}
      <p style={S.foot} data-testid="field-soils-source">
        {source?.synthetic ? (
          <strong style={{ color: '#fbbf24' }}>{source.text}. </strong>
        ) : (
          source && <>{source.text}. </>
        )}
        Soils: USDA NRCS SSURGO via Soil Data Access; NCCPI v3 per map unit weighted by component
        percent. Series and drainage are the dominant component&apos;s.
      </p>
    </div>
  );
}

export const soilsTab: FieldPanelTab = {
  id: 'soils',
  label: 'Soils',
  order: TAB_ORDER.soils,
  Component: SoilsTab,
};
