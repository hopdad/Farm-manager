/**
 * What the admin upload panels show for an import (boundaries, seasons, contacts): one small,
 * serializable table built on the server from the import's report. Pure.
 */
import type { BoundaryImportReport } from '@/db/queries/boundaries';
import type { PartyImportReport } from '@/db/queries/parties';
import type { SeasonImportReport } from '@/db/queries/seasons';

export type Tone = 'create' | 'insert' | 'update' | 'unchanged' | 'skip' | 'error' | 'blocked';

export interface ImportView {
  columns: string[];
  rows: { cells: string[]; tone: Tone }[];
  /** Notes and problems, one line each. */
  problems: string[];
  summary: string;
  /** The preview found changes and nothing blocks them. */
  canApply: boolean;
  applied: boolean;
}

const ac = (n: number | null) => (n === null ? '–' : n.toFixed(1));

export function boundaryView(r: BoundaryImportReport): ImportView {
  const c = r.counts;
  const changes = c.create + c.update;
  return {
    columns: ['Action', 'In the file', 'App field', 'Farm', 'Matched by', 'Acres'],
    rows: r.items.map((i) => ({
      tone: i.action,
      cells: [
        i.action,
        i.name,
        i.fieldName && i.fieldName !== i.name ? i.fieldName : '',
        i.farmName ?? '',
        i.matchedBy?.replace('_', ' ') ?? '',
        i.action === 'update' || i.action === 'unchanged'
          ? `${ac(i.acresBefore)} → ${ac(i.acresAfter)}`
          : ac(i.acresAfter),
      ],
    })),
    problems: [
      ...r.items.flatMap((i) => [
        ...(i.reason ? [`${i.name}: ${i.reason}`] : []),
        ...i.warnings.map((w) => `${i.name}: ${w}`),
      ]),
      ...(r.farmsCreated.length ? [`New farm(s): ${r.farmsCreated.join(', ')}`] : []),
      ...(r.demoHidden ? [`${r.demoHidden} demo field(s) hidden`] : []),
    ],
    summary: `${r.dryRun ? 'Preview: ' : ''}${c.create} new, ${c.update} changed, ${c.unchanged} unchanged, ${c.skip} skipped`,
    canApply: r.dryRun && changes + r.demoHidden > 0,
    applied: !r.dryRun,
  };
}

export function seasonView(r: SeasonImportReport): ImportView {
  const c = r.counts;
  return {
    columns: ['Line', 'Action', 'Field', 'Farm', 'Year', 'Problem'],
    rows: r.rows.map((x) => ({
      tone: x.action,
      cells: [
        String(x.line),
        x.action,
        x.fieldName ?? x.field,
        x.farmName ?? '',
        String(x.cropYear),
        x.message ?? '',
      ],
    })),
    problems: [],
    summary:
      c.error > 0
        ? `Nothing can be written until the ${c.error} row(s) marked error are fixed`
        : `${r.dryRun ? 'Preview: ' : ''}${c.insert} new, ${c.update} replaced, ${c.unchanged} unchanged`,
    canApply: r.dryRun && c.error === 0 && c.insert + c.update > 0,
    applied: r.written,
  };
}

export function partyView(r: PartyImportReport): ImportView {
  const c = r.counts;
  return {
    columns: ['Line', 'Action', 'Name', 'Problem'],
    rows: r.rows.map((x) => ({
      tone: x.action,
      cells: [String(x.line), x.action, x.name, x.message ?? ''],
    })),
    problems: [],
    summary:
      c.error > 0
        ? `Nothing can be written until the ${c.error} row(s) marked error are fixed`
        : `${r.dryRun ? 'Preview: ' : ''}${c.insert} new, ${c.update} updated, ${c.unchanged} unchanged`,
    canApply: r.dryRun && c.error === 0 && c.insert + c.update > 0,
    applied: r.written,
  };
}

/** A file-level failure (unreadable file, missing columns, problems by line). */
export function problemView(summary: string, problems: string[]): ImportView {
  return { columns: [], rows: [], problems, summary, canApply: false, applied: false };
}
