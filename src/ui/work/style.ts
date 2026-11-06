/**
 * The job board's one status palette (slice 2a; docs/contracts-2a.md §7.4): job cards, the
 * field panel's Jobs tab and any legend use these, so a status reads the same colour
 * everywhere. A CONTRACT FILE (foundation); additive changes only.
 *
 * Each status has a fill (the card's left bar, the tab's dot), a text colour readable on that
 * fill, and a label (JOB_STATUS_LABELS). Colours are distinct from the fleet's kind colours and
 * the spray verdict greens/ambers/reds where they could sit side by side.
 */
import {
  BUSINESS_LINE_LABELS,
  type BusinessLine,
  JOB_KIND_LABELS,
  JOB_STATUS_LABELS,
  type JobKind,
  type JobStatus,
} from '../../domain/work-jobs';

export interface StatusLook {
  fill: string;
  text: string;
  label: string;
}

export const JOB_STATUS_COLORS: Record<JobStatus, { fill: string; text: string }> = {
  requested: { fill: '#a78bfa', text: '#1e1033' },
  planned: { fill: '#94a3b8', text: '#0f172a' },
  assigned: { fill: '#38bdf8', text: '#082f49' },
  pushed: { fill: '#22d3ee', text: '#083344' },
  in_progress: { fill: '#facc15', text: '#422006' },
  done: { fill: '#4ade80', text: '#052e16' },
  invoiced: { fill: '#2dd4bf', text: '#042f2e' },
  cancelled: { fill: '#6b7280', text: '#f9fafb' },
};

export function statusLook(status: JobStatus): StatusLook {
  return { ...JOB_STATUS_COLORS[status], label: JOB_STATUS_LABELS[status] };
}

/** A short glyph per kind for cards and rows (text, so it needs no icon font). */
export const JOB_KIND_GLYPHS: Record<JobKind, string> = {
  plant: 'PL',
  spray: 'SP',
  harvest: 'HV',
  haul: 'HL',
  tillage: 'TL',
  fertilize: 'FT',
  scout: 'SC',
  tile: 'TI',
  repair: 'RP',
  other: '··',
};

export function kindLabel(kind: JobKind): string {
  return JOB_KIND_LABELS[kind];
}

export function laneLabel(line: BusinessLine): string {
  return BUSINESS_LINE_LABELS[line];
}

/** The drag overlay sits above every board layer (the status sheet is 40). */
export const DRAG_OVERLAY_Z_INDEX = 50;

/**
 * Map layer ids the drag hover highlight adds (pattern of src/ui/fields/highlight.ts; never the
 * field panel's `field-panel-selected-*`).
 */
export const DROP_HOVER_LAYER_IDS = {
  fill: 'work-drop-hover-fill',
  line: 'work-drop-hover-line',
} as const;
