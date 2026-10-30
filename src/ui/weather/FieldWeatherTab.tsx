'use client';
/**
 * The field panel's Spray tab (docs/contracts-m1.md §8: id 'weather', order 50): the current
 * hour's advisory verdict with its reasons, then the next 12 hours. Renders at once from
 * `detail.spray` (FieldDetail) and loads the hours from GET /api/weather/spray/<fieldId>,
 * refetching on spray/assessed.
 */
import {
  SPRAY_ADVISORY_DEFAULTS_TEXT,
  SPRAY_ADVISORY_TEXT,
  SPRAY_VERDICT_LABELS,
} from '../../domain/spray';
import type { SprayAssessmentView } from '../../domain/weather';
import { type FieldPanelTab, type FieldPanelTabProps, TAB_ORDER } from '../fields/tabs';
import type { FieldSprayResponse } from './contract';
import { fmtClock, fmtHour, SPRAY_COLORS } from './format';
import { useLiveJson } from './useLiveJson';
import css from './weather.module.css';

const TOPICS = ['spray'] as const;

function Verdict({ v }: { v: SprayAssessmentView }) {
  return (
    <span
      className={css.verdict}
      style={{ background: SPRAY_COLORS[v.verdict] }}
      data-testid="field-spray-verdict"
    >
      {SPRAY_VERDICT_LABELS[v.verdict]}
    </span>
  );
}

export function FieldWeatherTab({ fieldId, detail, variant }: FieldPanelTabProps) {
  const { data, error } = useLiveJson<FieldSprayResponse>(
    `/api/weather/spray/${encodeURIComponent(fieldId)}`,
    TOPICS,
    120_000,
  );
  const current = data?.hours[0] ?? detail?.spray ?? null;
  const later = (data?.hours ?? []).slice(1);
  return (
    <section
      className={`${css.tab} ${variant === 'wall' ? css.wallTab : ''}`}
      data-testid="field-spray-tab"
    >
      <p className={css.advisory}>
        {data?.thresholdsDefault === false ? SPRAY_ADVISORY_TEXT : SPRAY_ADVISORY_DEFAULTS_TEXT}
      </p>
      {current ? (
        <>
          <div>
            <span className={css.label}>Now ({fmtHour(current.forHour)})</span>{' '}
            <Verdict v={current} />
          </div>
          {current.reasons.length > 0 ? (
            <ul className={css.reasons} data-testid="field-spray-reasons">
              {current.reasons.map((r) => (
                <li key={r.code}>{r.message}</li>
              ))}
            </ul>
          ) : (
            <p className={css.muted}>Within every threshold.</p>
          )}
          <p className={css.muted}>
            {current.forecastIssuedAt
              ? `NWS forecast issued ${fmtClock(current.forecastIssuedAt)}${
                  current.forecastCheckedAt
                    ? `, checked ${fmtClock(current.forecastCheckedAt)}`
                    : ''
                }`
              : 'No forecast'}{' '}
            · rules {current.rulesVersion}
          </p>
        </>
      ) : (
        <p className={css.muted}>
          {error
            ? `Spray verdicts unavailable (${error}).`
            : 'Not assessed yet: the weather job runs every 30 minutes.'}
        </p>
      )}
      {later.length > 0 && (
        <ol className={css.timeline} aria-label="Next hours">
          {later.map((h) => (
            <li key={h.forHour} className={css.timelineRow}>
              <span>{fmtHour(h.forHour)}</span>
              <span className={css.verdict} style={{ background: SPRAY_COLORS[h.verdict] }}>
                {SPRAY_VERDICT_LABELS[h.verdict]}
              </span>
              <span className={css.muted}>{h.reasons.map((r) => r.message).join('; ')}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Registered in src/ui/fields/tab-registry.ts. */
export const weatherTab: FieldPanelTab = {
  id: 'weather',
  label: 'Spray',
  order: TAB_ORDER.weather,
  Component: FieldWeatherTab,
};
