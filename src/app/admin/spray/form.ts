/**
 * /admin/spray's forms <-> values (pure; unit-tested). Field names are the SprayThresholds keys.
 */
import { type SprayThresholds, sprayThresholdsSchema } from '@/domain/weather';
import {
  NWS_MAX_SIM_WIND_MPH,
  NWS_WEATHER_PATTERNS,
  type NwsSimWeatherRequest,
} from '@/sim/vendors/nws/control-types';

/** The form's inputs, in display order, with labels and units (the thresholds' meaning). */
export const THRESHOLD_FIELDS: readonly {
  key: keyof SprayThresholds;
  label: string;
  unit: string;
  kind: 'number' | 'verdict';
  step?: string;
  help: string;
}[] = [
  {
    key: 'windMaxMph',
    label: 'No-go above wind',
    unit: 'mph',
    kind: 'number',
    step: '0.5',
    help: 'sustained wind over this: no-go',
  },
  {
    key: 'windCautionMph',
    label: 'Caution above wind',
    unit: 'mph',
    kind: 'number',
    step: '0.5',
    help: 'sustained wind over this (up to the no-go): caution',
  },
  {
    key: 'windMinMph',
    label: 'Too calm below',
    unit: 'mph',
    kind: 'number',
    step: '0.5',
    help: 'sustained wind under this: caution (drift travels in still air)',
  },
  {
    key: 'gustMaxMph',
    label: 'No-go above gusts',
    unit: 'mph',
    kind: 'number',
    step: '0.5',
    help: 'gusts over this: no-go',
  },
  {
    key: 'rainFreeHours',
    label: 'Rain-free hours',
    unit: 'h',
    kind: 'number',
    step: '1',
    help: 'rain in the spray hour or this many hours after it',
  },
  {
    key: 'rainPopPct',
    label: 'Rain if chance at least',
    unit: '%',
    kind: 'number',
    step: '5',
    help: 'an hour counts as rain at this probability…',
  },
  {
    key: 'rainQpfIn',
    label: 'Rain if amount at least',
    unit: 'in',
    kind: 'number',
    step: '0.01',
    help: '…or this much forecast rain',
  },
  {
    key: 'rainVerdict',
    label: 'Rain expected means',
    unit: '',
    kind: 'verdict',
    help: 'verdict when rain is expected',
  },
  {
    key: 'inversionWindMph',
    label: 'Inversion: wind below',
    unit: 'mph',
    kind: 'number',
    step: '0.5',
    help: 'inversion heuristic: wind under this…',
  },
  {
    key: 'inversionMaxSkyPct',
    label: 'Inversion: sky cover at most',
    unit: '%',
    kind: 'number',
    step: '5',
    help: '…and a clear sky…',
  },
  {
    key: 'inversionSunHours',
    label: 'Inversion: hours from sunrise/sunset',
    unit: 'h',
    kind: 'number',
    step: '0.5',
    help: '…within this many hours of sunrise or sunset, or at night',
  },
  {
    key: 'inversionVerdict',
    label: 'Inversion risk means',
    unit: '',
    kind: 'verdict',
    help: 'verdict when the inversion heuristic fires',
  },
];

export type FormLike = { get(name: string): FormDataEntryValue | null };

const str = (form: FormLike, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** The thresholds form -> validated thresholds, or the first problem in words. */
export function parseThresholdsForm(
  form: FormLike,
): { ok: true; thresholds: SprayThresholds } | { ok: false; message: string } {
  const raw: Record<string, unknown> = {};
  for (const f of THRESHOLD_FIELDS) {
    const v = str(form, f.key);
    if (f.kind === 'verdict') {
      raw[f.key] = v;
      continue;
    }
    if (v === '' || !Number.isFinite(Number(v))) {
      return { ok: false, message: `${f.label}: enter a number` };
    }
    raw[f.key] = Number(v);
  }
  const r = sprayThresholdsSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    const field = THRESHOLD_FIELDS.find((f) => f.key === i?.path[0]);
    return {
      ok: false,
      message: field ? `${field.label}: ${i?.message}` : (i?.message ?? 'invalid thresholds'),
    };
  }
  return { ok: true, thresholds: r.data };
}

/** The simulated weather form -> the stand-in request ('' clears a knob). */
export function parseSimWeatherForm(
  form: FormLike,
): { ok: true; request: NwsSimWeatherRequest } | { ok: false; message: string } {
  if (str(form, 'clear') === 'true') return { ok: true, request: { windMph: null, pattern: null } };
  const wind = str(form, 'windMph');
  const pinned = str(form, 'pinWind') === 'on' || str(form, 'pinWind') === 'true';
  const pattern = str(form, 'pattern');
  let windMph: number | null = null;
  if (pinned) {
    const n = Number(wind);
    if (wind === '' || !Number.isFinite(n) || n < 0 || n > NWS_MAX_SIM_WIND_MPH) {
      return { ok: false, message: `wind: 0-${NWS_MAX_SIM_WIND_MPH} mph` };
    }
    windMph = Math.round(n * 10) / 10;
  }
  if (pattern !== '' && !(NWS_WEATHER_PATTERNS as readonly string[]).includes(pattern)) {
    return { ok: false, message: `unknown weather pattern '${pattern}'` };
  }
  return {
    ok: true,
    request: {
      windMph,
      pattern: pattern === '' ? null : (pattern as NwsSimWeatherRequest['pattern'] & string),
    },
  };
}
