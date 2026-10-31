'use client';
/**
 * History tab (field-data builder; contract ../tabs.ts, order 20): every crop year of the field
 * (crop, variety, planted, harvested, yield) and, through farm.field_lineage, the earlier years
 * of the field(s) it was split from or merged out of, so 5-season history survives boundary
 * edits (plan §4). Managers add, correct and remove seasons here (the server re-checks the
 * role: ROLE_FOR.editFieldData).
 *
 * Renders `detail.seasons` (the newest five) at once, then loads the full history; reloads
 * when the panel's detail changes (realtime fields/updated from another screen). After a save
 * it calls onChanged(['seasons']) so the panel refetches too.
 *
 * Slice 1f (deere-ops): above the seasons, this crop year's field operations from Operations
 * Center (../operations-section.tsx: its own fetch of GET /api/fields/<id>/operations, kept
 * current by `fields`/`updated` with part 'operations').
 */
import { type CSSProperties, useCallback, useEffect, useState, useTransition } from 'react';
import {
  deleteSeasonAction,
  loadFieldHistoryAction,
  type SeasonFormValues,
  saveSeasonAction,
} from '../../../app/admin/fields/_lib/history-actions';
import type { FieldHistory } from '../../../db/queries/seasons';
import type { SeasonRow } from '../../../domain/fields';
import { ROLE_FOR, roleAtLeast } from '../../../platform/auth/types';
import { OperationsSection } from '../operations-section';
import { type FieldPanelTab, type FieldPanelTabProps, TAB_ORDER } from '../tabs';

// Sizes relative to the panel's type (22 px on the wall, 16 px on phones): the History tab reads
// from across the room like the Overview.
const S = {
  section: { margin: '0 0 16px' } satisfies CSSProperties,
  h: {
    margin: '0 0 8px',
    fontSize: '0.8em',
    fontWeight: 600,
    opacity: 0.85,
  } satisfies CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '1em' } satisfies CSSProperties,
  th: {
    textAlign: 'left',
    fontSize: '0.75em',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    opacity: 0.7,
    padding: '6px 6px',
    borderBottom: '1px solid rgb(255 255 255 / 12%)',
    whiteSpace: 'nowrap',
  } satisfies CSSProperties,
  td: {
    padding: '8px 6px',
    borderBottom: '1px solid rgb(255 255 255 / 8%)',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
  } satisfies CSSProperties,
  muted: { opacity: 0.7, fontSize: '0.85em' } satisfies CSSProperties,
  error: { color: '#fca5a5' } satisfies CSSProperties,
  ok: { color: '#86efac' } satisfies CSSProperties,
  form: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: 8,
    padding: 12,
    margin: '0 0 12px',
    borderRadius: 12,
    border: '1px solid rgb(255 255 255 / 15%)',
  } satisfies CSSProperties,
  label: { display: 'grid', gap: 4, fontSize: '0.85em', opacity: 0.9 } satisfies CSSProperties,
  input: {
    minHeight: 44,
    padding: '0 10px',
    borderRadius: 10,
    border: '1px solid rgb(255 255 255 / 20%)',
    background: 'rgb(0 0 0 / 25%)',
    color: 'inherit',
    // 16 px at least: iOS zooms the page into smaller inputs.
    fontSize: 'max(16px, 1em)',
    boxSizing: 'border-box',
    width: '100%',
  } satisfies CSSProperties,
  scroll: { overflowX: 'auto' } satisfies CSSProperties,
};

const button = (variant: 'wall' | 'phone', primary = false): CSSProperties => ({
  minHeight: variant === 'wall' ? 72 : 48,
  minWidth: variant === 'wall' ? 72 : 48,
  padding: '0 16px',
  borderRadius: 12,
  border: `1px solid ${primary ? '#22a355' : 'rgb(255 255 255 / 25%)'}`,
  background: primary ? '#166534' : 'rgb(255 255 255 / 6%)',
  color: 'inherit',
  fontSize: variant === 'wall' ? 18 : 16,
  fontWeight: 600,
  cursor: 'pointer',
  touchAction: 'manipulation',
});

const blank = (year: number): SeasonFormValues => ({
  crop_year: String(year),
  crop: '',
  variety: '',
  planted_on: '',
  harvested_on: '',
  yield_bu_ac: '',
});

const toForm = (s: SeasonRow): SeasonFormValues => ({
  crop_year: String(s.cropYear),
  crop: s.crop ?? '',
  variety: s.variety ?? '',
  planted_on: s.plantedOn ?? '',
  harvested_on: s.harvestedOn ?? '',
  yield_bu_ac: s.yieldBuAc === null ? '' : String(s.yieldBuAc),
});

const fmtDate = (d: string | null) => {
  if (!d) return '–';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, day ?? 1)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
};

const SOURCE: Record<string, string> = {
  deere: 'Ops Center',
  import: 'imported',
  app: 'typed in',
  demo: 'demo',
};

function SeasonsTable({
  seasons,
  testId,
  edit,
  variant,
}: {
  seasons: SeasonRow[];
  testId: string;
  edit?: (s: SeasonRow) => void;
  variant: 'wall' | 'phone';
}) {
  return (
    <div style={S.scroll}>
      <table style={S.table} data-testid={testId}>
        <thead>
          <tr>
            <th style={S.th}>Year</th>
            <th style={S.th}>Crop</th>
            <th style={S.th}>Variety</th>
            <th style={S.th}>Planted</th>
            <th style={S.th}>Harvested</th>
            <th style={S.th}>Bu/ac</th>
            {variant === 'wall' && <th style={S.th}>From</th>}
            {edit && <th style={S.th} aria-label="Edit" />}
          </tr>
        </thead>
        <tbody>
          {seasons.map((s) => (
            <tr key={s.cropYear} data-testid={`history-season-${s.cropYear}`}>
              <td style={S.td}>{s.cropYear}</td>
              <td style={S.td}>{s.crop ?? '–'}</td>
              <td style={S.td}>{s.variety ?? '–'}</td>
              <td style={S.td}>{fmtDate(s.plantedOn)}</td>
              <td style={S.td}>{fmtDate(s.harvestedOn)}</td>
              <td style={S.td}>{s.yieldBuAc === null ? '–' : s.yieldBuAc.toFixed(1)}</td>
              {variant === 'wall' && (
                <td style={{ ...S.td, ...S.muted }}>{SOURCE[s.source] ?? s.source}</td>
              )}
              {edit && (
                <td style={S.td}>
                  <button
                    type="button"
                    style={button(variant)}
                    onClick={() => edit(s)}
                    data-testid={`history-edit-${s.cropYear}`}
                  >
                    Edit
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryTab({ fieldId, detail, variant, role, onChanged }: FieldPanelTabProps) {
  const canEdit = roleAtLeast(role, ROLE_FOR.editFieldData);
  const [history, setHistory] = useState<FieldHistory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<{ values: SeasonFormValues; original: number | null } | null>(
    null,
  );
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const load = useCallback(() => {
    start(async () => {
      try {
        const r = await loadFieldHistoryAction(fieldId);
        if (r.ok && r.data) {
          setHistory(r.data);
          setLoadError(null);
        } else {
          setLoadError(r.message);
        }
      } catch {
        setLoadError('Could not load the history (no connection?)');
      }
    });
  }, [fieldId]);

  // Load on open, and again whenever the panel's detail changes (a save here or elsewhere).
  // biome-ignore lint/correctness/useExhaustiveDependencies: detail identity is the trigger
  useEffect(() => {
    load();
  }, [load, detail]);

  if (!detail && !history) {
    return (
      <p role="status" aria-busy="true" style={S.muted} data-testid="field-history-loading">
        Loading history…
      </p>
    );
  }
  const seasons: SeasonRow[] = history?.seasons ?? detail?.seasons ?? [];
  const thisYear = new Date().getFullYear();
  const nextYear = () => {
    const years = new Set(seasons.map((s) => s.cropYear));
    let y = thisYear;
    while (years.has(y)) y--;
    return y;
  };

  /** Run a save or delete; on success close the form, tell the panel, reload the history. */
  const write = (action: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      try {
        const r = await action();
        setMessage({ ok: r.ok, text: r.message });
        if (!r.ok) return;
        setForm(null);
        onChanged(['seasons']);
        const h = await loadFieldHistoryAction(fieldId);
        if (h.ok && h.data) setHistory(h.data);
      } catch {
        setMessage({ ok: false, text: 'Not saved: the server could not be reached. Try again.' });
      }
    });
  const save = () =>
    form &&
    write(() =>
      saveSeasonAction({ fieldId, originalCropYear: form.original, values: form.values }),
    );
  const remove = (year: number) => write(() => deleteSeasonAction({ fieldId, cropYear: year }));
  const set = (k: keyof SeasonFormValues) => (e: { target: { value: string } }) =>
    setForm((f) => (f ? { ...f, values: { ...f.values, [k]: e.target.value } } : f));

  return (
    <div data-testid="field-history" aria-busy={pending}>
      {message && (
        <p role="status" style={message.ok ? S.ok : S.error} data-testid="history-message">
          {message.text}
        </p>
      )}
      {loadError && <p style={S.error}>{loadError}</p>}
      <OperationsSection fieldId={fieldId} variant={variant} />
      {canEdit && !form && (
        <p>
          <button
            type="button"
            style={button(variant)}
            onClick={() => setForm({ values: blank(nextYear()), original: null })}
            data-testid="history-add"
          >
            Add a season
          </button>
        </p>
      )}
      {canEdit && form && (
        <form
          style={S.form}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          data-testid="history-form"
        >
          <label style={S.label}>
            Crop year
            <input
              style={S.input}
              inputMode="numeric"
              value={form.values.crop_year}
              onChange={set('crop_year')}
              data-testid="history-year"
            />
          </label>
          <label style={S.label}>
            Crop
            <input
              style={S.input}
              list="history-crops"
              value={form.values.crop}
              onChange={set('crop')}
              data-testid="history-crop"
            />
          </label>
          <label style={S.label}>
            Variety
            <input style={S.input} value={form.values.variety} onChange={set('variety')} />
          </label>
          <label style={S.label}>
            Planted
            <input
              style={S.input}
              type="date"
              value={form.values.planted_on}
              onChange={set('planted_on')}
            />
          </label>
          <label style={S.label}>
            Harvested
            <input
              style={S.input}
              type="date"
              value={form.values.harvested_on}
              onChange={set('harvested_on')}
            />
          </label>
          <label style={S.label}>
            Yield (bu/ac)
            <input
              style={S.input}
              inputMode="decimal"
              value={form.values.yield_bu_ac}
              onChange={set('yield_bu_ac')}
              data-testid="history-yield"
            />
          </label>
          <datalist id="history-crops">
            <option value="corn" />
            <option value="soybeans" />
            <option value="wheat" />
          </datalist>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <button
              type="submit"
              style={button(variant, true)}
              disabled={pending}
              data-testid="history-save"
            >
              Save
            </button>
            <button type="button" style={button(variant)} onClick={() => setForm(null)}>
              Cancel
            </button>
            {form.original !== null && (
              <button
                type="button"
                style={button(variant)}
                disabled={pending}
                onClick={() => form.original !== null && remove(form.original)}
                data-testid="history-delete"
              >
                Remove {form.original}
              </button>
            )}
          </div>
        </form>
      )}

      <section style={S.section}>
        {seasons.length ? (
          <SeasonsTable
            seasons={seasons}
            testId="history-seasons"
            variant={variant}
            edit={canEdit ? (s) => setForm({ values: toForm(s), original: s.cropYear }) : undefined}
          />
        ) : (
          <p style={S.muted}>
            No crop history yet{canEdit ? ': add a season, or import a CSV on /admin/fields.' : '.'}
          </p>
        )}
        {!history && !loadError && <p style={S.muted}>Loading older years…</p>}
      </section>

      {history?.ancestors.map((a) => (
        <section key={a.fieldId} style={S.section} data-testid="history-ancestor">
          <h4 style={S.h}>
            {a.kind === 'split' ? 'Split from' : 'Merged from'} {a.name} on {a.effectiveOn}
            {a.depth > 1 ? ' (earlier)' : ''}
          </h4>
          {a.seasons.length ? (
            <SeasonsTable
              seasons={a.seasons}
              testId={`history-ancestor-${a.fieldId}`}
              variant={variant}
            />
          ) : (
            <p style={S.muted}>No seasons recorded for {a.name}.</p>
          )}
        </section>
      ))}

      {history && history.children.length > 0 && (
        <section style={S.section} data-testid="history-children">
          <h4 style={S.h}>Became</h4>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {history.children.map((c) => (
              <li key={c.fieldId}>
                {c.name} ({c.kind}, {c.effectiveOn})
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export const historyTab: FieldPanelTab = {
  id: 'history',
  label: 'History',
  order: TAB_ORDER.history,
  Component: HistoryTab,
};
