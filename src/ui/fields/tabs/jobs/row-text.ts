/**
 * What one row of the field panel's Jobs tab says (pure; ./jobs.test.ts checks it): the window in
 * farm time, who and what is on the job, its products and flags. The status colour and label come
 * from the board's one palette (src/ui/work/style.ts, contracts-2a §7.4).
 */
import { FARM_TIME_ZONE } from '../../../../domain/farm';
import {
  isOpenJobStatus,
  JOB_FLAGS,
  type JobFlag,
  RATE_UNIT_LABELS,
} from '../../../../domain/work-jobs';
import type { JobView, JobWindow } from '../../../work/contract';
import { JOB_KIND_GLYPHS, kindLabel, statusLook } from '../../../work/style';

const DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: FARM_TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: FARM_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});
const KEY = new Intl.DateTimeFormat('en-CA', { timeZone: FARM_TIME_ZONE });

const at = (iso: string) => {
  const d = new Date(iso);
  return { day: DAY.format(d), time: TIME.format(d), key: KEY.format(d) };
};

/** 'Fri, Nov 6 8:00 AM – 5:00 PM', 'from Fri, Nov 6 8:00 AM', 'no window yet'. */
export function windowText(w: JobWindow | null): string {
  if (!w || (!w.from && !w.to)) return 'no window yet';
  if (w.from && !w.to) {
    const a = at(w.from);
    return `from ${a.day} ${a.time}`;
  }
  if (!w.from && w.to) {
    const b = at(w.to);
    return `by ${b.day} ${b.time}`;
  }
  const a = at(w.from as string);
  const b = at(w.to as string);
  return a.key === b.key
    ? `${a.day} ${a.time} – ${b.time}`
    : `${a.day} ${a.time} – ${b.day} ${b.time}`;
}

/** 'SP2 · Dale Mercer, Amy Kovach' (machine and person of each row). */
export function assignmentsText(job: Pick<JobView, 'assignments'>): string {
  return job.assignments
    .map((a) => [a.machine?.unitNo, a.person?.name].filter(Boolean).join(' · '))
    .filter(Boolean)
    .join(', ');
}

const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** 'Glyphosate 5.5 (demo) 32 fl oz/ac; 28% UAN (customer’s)'. */
export function productsText(job: Pick<JobView, 'products'>): string {
  return job.products
    .map((p) => {
      const rate =
        p.rate !== null ? ` ${num(p.rate)}${p.unit ? ` ${RATE_UNIT_LABELS[p.unit]}` : ''}` : '';
      return `${p.name}${rate}${p.suppliedBy === 'customer' ? ' (customer’s)' : ''}`;
    })
    .join('; ');
}

export const FLAG_LABELS: Record<JobFlag, string> = {
  no_field: 'no field',
  machine_down: 'machine down',
  double_booked: 'double-booked',
  acres_differ: 'acres differ from the boundary',
  restricted_use: 'restricted-use product',
};

export interface JobRowText {
  glyph: string;
  kind: string;
  title: string;
  status: { label: string; fill: string; text: string };
  window: string;
  acres: string | null;
  who: string;
  products: string;
  flags: { flag: JobFlag; label: string }[];
  customer: string | null;
}

export function jobRowText(job: JobView): JobRowText {
  const acres =
    job.plannedAcres !== null
      ? `${job.plannedAcres.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ac`
      : job.plannedQty !== null
        ? `${num(job.plannedQty)} ${job.plannedUnit ?? ''}`.trim()
        : null;
  return {
    glyph: JOB_KIND_GLYPHS[job.kind],
    kind: kindLabel(job.kind),
    title: job.summary,
    status: statusLook(job.status),
    window: windowText(job.window),
    acres,
    who: assignmentsText(job),
    products: productsText(job),
    flags: JOB_FLAGS.filter((f) => job.flags.includes(f)).map((flag) => ({
      flag,
      label: FLAG_LABELS[flag],
    })),
    customer: job.customer?.name ?? null,
  };
}

/** The tab's two lists: the open jobs (board order) and how many went done today. */
export function splitJobs(jobs: readonly JobView[]): { open: JobView[]; doneToday: number } {
  const open = jobs.filter((j) => isOpenJobStatus(j.status));
  return { open, doneToday: jobs.filter((j) => j.status === 'done').length };
}
