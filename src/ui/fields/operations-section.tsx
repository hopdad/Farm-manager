'use client';
/**
 * "This season" in the field panel's History tab (slice 1f, deere-ops; docs/contracts-1f.md
 * §5.1): the field's operations of the current crop year from Operations Center, oldest first,
 * each with its kind, crop, dates, acres, yield or rates, products, machines and operator,
 * coverage and provisional/final state. Data and refresh: ./operations.ts (the loader refetches
 * on `fields`/`updated` with part 'operations', on invalidate and resync, and polls while
 * realtime is down). Read-only for every role (Operations Center is the system of record).
 */
import { type CSSProperties, useEffect, useState } from 'react';
import { resolveRealtimeClient } from '../map/fleet/realtime';
import {
  type OperationsState,
  operationRowText,
  type RealtimeResolver,
  startFieldOperations,
} from './operations';

const S = {
  section: { margin: '0 0 16px' } satisfies CSSProperties,
  h: {
    margin: '0 0 8px',
    fontSize: '0.8em',
    fontWeight: 600,
    opacity: 0.85,
  } satisfies CSSProperties,
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gap: 8,
  } satisfies CSSProperties,
  item: {
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid rgb(255 255 255 / 12%)',
    background: 'rgb(255 255 255 / 4%)',
  } satisfies CSSProperties,
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 12px',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  } satisfies CSSProperties,
  title: { fontWeight: 600 } satisfies CSSProperties,
  line: { margin: '4px 0 0', fontSize: '0.85em' } satisfies CSSProperties,
  muted: { opacity: 0.7, fontSize: '0.85em' } satisfies CSSProperties,
  badge: (final: boolean): CSSProperties => ({
    fontSize: '0.7em',
    padding: '2px 8px',
    borderRadius: 999,
    border: `1px solid ${final ? 'rgb(134 239 172 / 50%)' : 'rgb(253 224 71 / 50%)'}`,
    color: final ? '#86efac' : '#fde047',
    whiteSpace: 'nowrap',
  }),
  error: { color: '#fca5a5', fontSize: '0.85em' } satisfies CSSProperties,
};

const resolveRealtime: RealtimeResolver = ({ realtime, appEnv }) =>
  resolveRealtimeClient({
    realtime: realtime === 'supabase' ? 'supabase' : 'sse',
    appEnv: appEnv === 'production' ? 'production' : appEnv === 'test' ? 'test' : 'development',
  });

/** The field's operations of the current crop year, kept current. */
export function useFieldOperations(fieldId: string): OperationsState {
  const [state, setState] = useState<OperationsState>(() => ({
    fieldId,
    status: 'loading',
    data: null,
    error: null,
  }));
  useEffect(() => {
    const loader = startFieldOperations({
      fieldId,
      fetch: (input, init) => fetch(input, init),
      realtime: resolveRealtime,
      onState: setState,
    });
    return () => loader.stop();
  }, [fieldId]);
  // Until the new field's loader reports, never show the previous field's operations.
  return state.fieldId === fieldId
    ? state
    : { fieldId, status: 'loading', data: null, error: null };
}

export function OperationsSection({
  fieldId,
  variant,
}: {
  fieldId: string;
  variant: 'wall' | 'phone';
}) {
  const s = useFieldOperations(fieldId);
  const year = s.data?.cropYear;
  return (
    <section style={S.section} data-testid="field-operations" aria-busy={s.status === 'loading'}>
      <h4 style={S.h}>This season{year ? ` (${year})` : ''}: field operations</h4>
      {s.status === 'loading' && <p style={S.muted}>Loading operations…</p>}
      {s.status === 'denied' && <p style={S.muted}>Sign in to see this field's operations.</p>}
      {s.status === 'error' && <p style={S.error}>Could not load the operations ({s.error}).</p>}
      {s.status === 'ready' && s.error && (
        <p style={S.error}>Couldn't refresh ({s.error}); showing what was loaded.</p>
      )}
      {s.data && s.data.operations.length === 0 && (
        <p style={S.muted} data-testid="field-operations-empty">
          No field operations from Operations Center yet this season.
        </p>
      )}
      {s.data && s.data.operations.length > 0 && (
        <ul style={S.list}>
          {s.data.operations.map((o) => {
            const t = operationRowText(o);
            return (
              <li
                key={o.id}
                style={S.item}
                data-testid="field-operation"
                data-kind={o.kind}
                data-status={o.status}
                data-coverage={o.hasCoverage ? 'yes' : 'no'}
              >
                <div style={S.head}>
                  <span style={S.title}>{t.title}</span>
                  <span style={S.muted}>{t.dates}</span>
                  <span style={S.badge(o.status === 'final')}>{t.status}</span>
                </div>
                <p style={S.line} data-testid="field-operation-acres">
                  {t.acres}
                  {t.measurements ? ` · ${t.measurements}` : ''}
                </p>
                {t.products.length > 0 && (
                  <p style={S.line} data-testid="field-operation-products">
                    {t.products.join('; ')}
                  </p>
                )}
                <p style={{ ...S.line, ...S.muted }}>
                  {[t.machines, t.coverage, variant === 'wall' ? `from ${t.source}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
