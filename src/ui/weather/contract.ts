/**
 * The weather routes' JSON (src/app/api/weather/**), shared by the handlers and the client
 * components. Every response names the realtime adapter so components can subscribe
 * (`getRealtimeClient(realtime)`) without reading config.
 *
 *   GET  /api/weather/strip             WeatherStripResponse   (viewer)
 *   GET  /api/weather/spray             SprayMapResponse       (viewer)  field id -> verdict now
 *   GET  /api/weather/spray/<fieldId>   FieldSprayResponse     (viewer)  current hour + 12
 *   GET  /api/weather/soil-temp         SoilTempFormData       (viewer)
 *   POST /api/weather/soil-temp         SoilTempBody -> 201 SoilTempResult (ROLE_FOR.enterSoilTemp)
 */
import { z } from 'zod';
import type { SoilTempView, SprayAssessmentView, SprayVerdict } from '../../domain/weather';
import type { WeatherStripResponse as StripBase } from './strip-model';

export type RealtimeKind = 'sse' | 'supabase';

export interface WeatherStripPayload extends StripBase {
  realtime: RealtimeKind;
}

export interface SprayMapResponse {
  builtAt: string;
  /** The hour the verdicts are for (current UTC hour). */
  forHour: string;
  thresholdsDefault: boolean;
  realtime: RealtimeKind;
  /** Active fields with a verdict for the hour (staleness applied). */
  fields: { fieldId: string; verdict: SprayVerdict }[];
}

export interface FieldSprayResponse {
  builtAt: string;
  fieldId: string;
  thresholdsDefault: boolean;
  realtime: RealtimeKind;
  /** The current hour first, then the stored hours after it (newest row each; staleness applied). */
  hours: SprayAssessmentView[];
}

export interface SoilTempFormData {
  realtime: RealtimeKind;
  /** May this session enter a reading (UI hint; the POST checks again)? */
  canEnter: boolean;
  fields: { id: string; name: string }[];
  latest: SoilTempView | null;
}

/** Furthest back a reading may be dated. */
export const SOIL_TEMP_MAX_AGE_DAYS = 7;
/** A reading dated in the future by more than this is refused. */
export const SOIL_TEMP_FUTURE_SLACK_MINUTES = 5;
/** A soil temperature body is tiny. */
export const MAX_SOIL_TEMP_BODY_BYTES = 4 * 1024;

export const soilTempBodySchema = z.strictObject({
  fieldId: z.uuid().nullable().optional(),
  tempF: z.number().min(-40).max(140),
  depthIn: z.number().gt(0).max(72).optional(),
  observedAt: z.iso.datetime({ offset: true }).optional(),
  note: z.string().trim().max(500).optional(),
});
export type SoilTempBody = z.infer<typeof soilTempBodySchema>;

export interface SoilTempResult {
  id: string;
  observedAt: string;
}
