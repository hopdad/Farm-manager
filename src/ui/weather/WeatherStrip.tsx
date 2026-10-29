'use client';
/**
 * The weather strip (plan 1b) for /board (`variant="wall"`) and /m (`variant="phone"`):
 * now (nearest station), today and the next 3 days (rain chance and amount, wind, gusts,
 * high/low), the next 12 hours with the spray verdict of the cell's reference field, soil
 * temperature from the latest probe reading with its age, and the spray summary for the
 * current hour, which toggles the map's spray colours (the `spray` layer's visibility, the same
 * store the layer rail uses). Advisory wording while the D4 thresholds are the defaults.
 *
 * Self-contained: loads GET /api/weather/strip and refetches on weather/updated and
 * spray/assessed (and every minute). Renders offline from whatever the job last stored
 * (CONNECTOR_WEATHER=sim needs no internet). Phones get a chip that opens a sheet with the
 * days, the hours and the soil temperature form.
 */
import { useState } from 'react';
import { SPRAY_ADVISORY_DEFAULTS_TEXT, SPRAY_VERDICT_LABELS } from '../../domain/spray';
import type { WeatherStripDay, WeatherStripHour } from '../../domain/weather';
import { useLayerVisibilityStore, useLayerVisible } from '../map/layers/visibility';
import type { WeatherStripPayload } from './contract';
import {
  fmtAgeMinutes,
  fmtClock,
  fmtHour,
  fmtMph,
  fmtPct,
  fmtRain,
  fmtTemp,
  minutesSince,
  SPRAY_COLORS,
  windFrom,
} from './format';
import { SoilTempForm } from './SoilTempForm';
import { useLiveJson, useNowTick } from './useLiveJson';
import css from './weather.module.css';

const TOPICS = ['weather', 'spray'] as const;
const WALL_HOURS = 12;

/** The strip's hours from the start of the current hour on (an old payload keeps past hours). */
function upcomingHours(strip: WeatherStripPayload, now: number): WeatherStripHour[] {
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
  return strip.hours.filter((h) => Date.parse(h.validAt) >= hourStart);
}

function ModeBadges({
  strip,
  notUpdatedSince,
}: {
  strip: WeatherStripPayload;
  notUpdatedSince: number | null;
}) {
  return (
    <span className={css.badges}>
      {notUpdatedSince !== null && (
        <span className={`${css.badge} ${css.badgeWarn}`} data-testid="weather-not-updated">
          Not updated since {fmtClock(new Date(notUpdatedSince).toISOString())}
        </span>
      )}
      {strip.mode === 'sim' && <span className={css.badge}>Simulated weather</span>}
      {strip.mode === 'replay' && <span className={css.badge}>Replay</span>}
      {strip.mode === 'off' && <span className={`${css.badge} ${css.badgeWarn}`}>Weather off</span>}
      {strip.stale && (
        <span className={`${css.badge} ${css.badgeWarn}`} data-testid="weather-stale">
          {strip.issuedAt ? 'Forecast stale' : 'No forecast yet'}
        </span>
      )}
    </span>
  );
}

function NowBlock({
  strip,
  now,
  notUpdatedSince,
}: {
  strip: WeatherStripPayload;
  now: number;
  notUpdatedSince: number | null;
}) {
  const o = strip.now;
  const first = upcomingHours(strip, now)[0] ?? null;
  const temp = o?.tempF ?? first?.tempF ?? null;
  const wind = o?.windMph ?? first?.windMph ?? null;
  const gust = o ? o.gustMph : (first?.gustMph ?? null);
  const dir = o?.windDir ?? first?.windDir ?? null;
  return (
    <div className={css.block} data-testid="weather-now">
      <span className={css.label}>Now</span>
      <span className={css.big}>{fmtTemp(temp)}</span>
      <span>
        {windFrom(dir)} {fmtMph(wind)} mph{gust !== null ? ` g${fmtMph(gust)}` : ''}
      </span>
      <span className={css.small}>
        {o
          ? `${o.stationId} ${fmtAgeMinutes(minutesSince(o.observedAt, now))}`
          : strip.issuedAt
            ? `forecast ${fmtClock(strip.issuedAt)}`
            : 'waiting for the first forecast'}
      </span>
      <ModeBadges strip={strip} notUpdatedSince={notUpdatedSince} />
    </div>
  );
}

function DayBlock({ d }: { d: WeatherStripDay }) {
  return (
    <div className={css.block} data-testid="weather-day">
      <span className={css.label}>{d.label}</span>
      <span>
        <strong>{fmtTemp(d.highF)}</strong> / {fmtTemp(d.lowF)}
      </span>
      <span>
        Rain {fmtPct(d.maxPopPct)} · {fmtRain(d.rainIn)}
      </span>
      <span className={css.small}>
        Wind {fmtMph(d.maxWindMph)} g{fmtMph(d.maxGustMph)} mph
      </span>
    </div>
  );
}

function HourCell({ h }: { h: WeatherStripHour }) {
  return (
    <div
      className={css.hour}
      data-testid="weather-hour"
      title={h.spray ? SPRAY_VERDICT_LABELS[h.spray] : 'not assessed'}
    >
      <span>{fmtHour(h.validAt)}</span>
      <span>
        {fmtMph(h.windMph)}
        <small> g{fmtMph(h.gustMph)}</small>
      </span>
      <span>{fmtPct(h.popPct)}</span>
      <span
        className={`${css.dot} ${h.spray ? '' : css.dotNone}`}
        style={h.spray ? { background: SPRAY_COLORS[h.spray] } : undefined}
      />
    </div>
  );
}

function SoilBlock({ strip }: { strip: WeatherStripPayload }) {
  const s = strip.soilTemp;
  return (
    <div className={css.block} data-testid="weather-soil">
      <span className={css.label}>Soil</span>
      {s ? (
        <>
          <span className={css.big}>{fmtTemp(s.tempF)}</span>
          <span className={css.small}>
            {s.depthIn} in{s.fieldName ? ` · ${s.fieldName}` : ''} · {fmtAgeMinutes(s.ageMinutes)}
          </span>
        </>
      ) : (
        <span className={css.small}>No probe reading yet</span>
      )}
    </div>
  );
}

function SprayToggle({ strip }: { strip: WeatherStripPayload }) {
  const on = useLayerVisible('spray', false);
  const toggle = useLayerVisibilityStore((s) => s.toggle);
  const c = strip.spray;
  return (
    <button
      type="button"
      className={css.sprayButton}
      aria-pressed={on}
      onClick={() => toggle('spray', false)}
      data-testid="spray-toggle"
      title="Show or hide the spray colours on the map"
    >
      <span className={css.label}>Spray now {on ? '· on map' : ''}</span>
      {c ? (
        <span className={css.counts} data-testid="spray-counts">
          <span style={{ color: SPRAY_COLORS.go }}>{c.go} go</span>
          <span style={{ color: SPRAY_COLORS.caution }}>{c.caution} caution</span>
          <span style={{ color: SPRAY_COLORS.no_go }}>{c.noGo} no-go</span>
        </span>
      ) : (
        <span className={css.small}>not assessed yet</span>
      )}
      <span className={css.advisory}>
        {strip.sprayThresholdsDefault ? SPRAY_ADVISORY_DEFAULTS_TEXT : 'Advisory'}
      </span>
    </button>
  );
}

function PhoneSheet({
  strip,
  now,
  notUpdatedSince,
  onClose,
}: {
  strip: WeatherStripPayload;
  now: number;
  notUpdatedSince: number | null;
  onClose(): void;
}) {
  const [logging, setLogging] = useState(false);
  return (
    <section className={css.sheet} data-testid="weather-sheet" aria-label="Weather">
      <div className={css.sheetHead}>
        <strong>Weather</strong>
        <button type="button" className={css.button} onClick={onClose}>
          Close
        </button>
      </div>
      <NowBlock strip={strip} now={now} notUpdatedSince={notUpdatedSince} />
      <div className={css.days}>
        {strip.days.map((d) => (
          <DayBlock key={d.date} d={d} />
        ))}
      </div>
      <div className={css.hours}>
        {upcomingHours(strip, now)
          .slice(0, WALL_HOURS)
          .map((h) => (
            <HourCell key={h.validAt} h={h} />
          ))}
      </div>
      <SprayToggle strip={strip} />
      <SoilBlock strip={strip} />
      {logging ? (
        <SoilTempForm />
      ) : (
        <button
          type="button"
          className={`${css.button} ${css.primary}`}
          onClick={() => setLogging(true)}
          data-testid="soil-temp-open"
        >
          Log a soil temperature
        </button>
      )}
    </section>
  );
}

export function WeatherStrip({ variant }: { variant: 'wall' | 'phone' }) {
  const {
    data: strip,
    error,
    loadedAt,
  } = useLiveJson<WeatherStripPayload>('/api/weather/strip', TOPICS);
  const now = useNowTick(30_000);
  const [open, setOpen] = useState(false);

  if (!strip) {
    return variant === 'wall' ? (
      <div className={css.strip} data-testid="weather-strip" data-state="loading">
        <div className={css.block}>
          <span className={css.label}>Weather</span>
          <span className={css.small}>{error ? `unavailable (${error})` : 'loading…'}</span>
        </div>
      </div>
    ) : null;
  }

  // The farm PC can't be reached: keep the last strip, say since when, drop hours gone by.
  const notUpdatedSince = error ? loadedAt : null;
  if (variant === 'phone') {
    const first = upcomingHours(strip, now)[0] ?? null;
    const today = strip.days[0] ?? null;
    return (
      <>
        <button
          type="button"
          className={css.chip}
          onClick={() => setOpen(true)}
          data-testid="weather-chip"
          aria-expanded={open}
        >
          <span>{fmtTemp(strip.now?.tempF ?? first?.tempF ?? null)}</span>
          <span>
            {windFrom(strip.now?.windDir ?? first?.windDir ?? null)}{' '}
            {fmtMph(strip.now?.windMph ?? first?.windMph ?? null)}
          </span>
          {today && <span>Rain {fmtPct(today.maxPopPct)}</span>}
          {strip.spray && (
            <span
              style={{
                color: strip.spray.noGo
                  ? SPRAY_COLORS.no_go
                  : strip.spray.caution
                    ? SPRAY_COLORS.caution
                    : SPRAY_COLORS.go,
              }}
            >
              ●
            </span>
          )}
        </button>
        {open && (
          <PhoneSheet
            strip={strip}
            now={now}
            notUpdatedSince={notUpdatedSince}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <div
      className={css.strip}
      data-testid="weather-strip"
      data-state="ready"
      data-issued-at={strip.issuedAt ?? ''}
    >
      <div className={css.stripRow}>
        <NowBlock strip={strip} now={now} notUpdatedSince={notUpdatedSince} />
        {strip.days.map((d) => (
          <DayBlock key={d.date} d={d} />
        ))}
        <SoilBlock strip={strip} />
        <SprayToggle strip={strip} />
      </div>
      <div className={css.hours} data-testid="weather-hours">
        {upcomingHours(strip, now)
          .slice(0, WALL_HOURS)
          .map((h) => (
            <HourCell key={h.validAt} h={h} />
          ))}
      </div>
    </div>
  );
}

export default WeatherStrip;
