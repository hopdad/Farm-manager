/**
 * The job form's model (docs/contracts-2a.md §7.3), framework-free so every rule is unit-tested
 * (./form-model.test.ts) and ./JobForm.tsx only renders it.
 *
 *  - Values are what the inputs hold (strings; '' = empty). A new job starts from `initial` (a
 *    tapped field, a lane's "New job"); an edit starts from the JobView.
 *  - `dirty` is the set of inputs the person changed. An edit sends ONLY those, and only when
 *    they differ from the job it opened (PATCH: "only the fields present change"), with the
 *    version it saw (decision 2a-7). After a 409 the form `rebase`s onto the current job: what the
 *    person changed stays, everything else shows the other screen's values, and Save tries again
 *    with the new version.
 *  - Field rules the server applies anyway (decisions 2a-4/5/6) are shown, not duplicated:
 *    picking a field fills an untouched customer with the field's (its farm's custom-work
 *    customer); planned acres left empty follow the field's boundary (the boundary's acres are
 *    the placeholder), typed ones are "by hand", and emptying typed acres on an edit hands them
 *    back to the boundary (`plannedAcres: null`); crop year left on "with the field" lets the
 *    server take the field's growing year (D23).
 *  - A `requested` job (a customer asked: text, phone, in person; decision 2a-9) carries the
 *    channel and who asked: a customer party, or a name and phone.
 */
import {
  BUSINESS_LINES,
  type BusinessLine,
  DEFAULT_BUSINESS_LINE,
  JOB_DEFAULT_PRIORITY,
  JOB_KINDS,
  JOB_PLANNED_UNITS,
  JOB_PRIORITIES,
  type JobKind,
  type JobPlannedUnit,
  type JobPriority,
  MAX_JOB_NOTES_CHARS,
  MAX_JOB_PRODUCTS,
  MAX_JOB_TITLE_CHARS,
  MAX_REQUESTER_NAME_CHARS,
  MAX_REQUESTER_PHONE_CHARS,
  type ProductUnit,
  RATE_UNITS,
  type RateUnit,
  REQUEST_CHANNELS,
  type RequestChannel,
  SUPPLIED_BY,
  type SuppliedBy,
} from '../../../domain/work-jobs';
import type {
  CreateJobBodyInput,
  JobOptionsResponse,
  JobProductInput,
  JobView,
  JobWindow,
  UpdateJobBodyInput,
} from '../contract';
import { dateToFarmLocal, farmLocalToDate, toFarmIso } from './farm-time';

export type FormMode = 'new' | 'edit';

export interface ProductLine {
  /** Stable React key for the row (not sent). */
  key: string;
  productId: string;
  rate: string;
  unit: RateUnit | '';
  suppliedBy: SuppliedBy;
}

export interface JobFormValues {
  kind: JobKind;
  businessLine: BusinessLine;
  /** A new job: planned, or requested (a customer asked). Edits change status elsewhere. */
  status: 'planned' | 'requested';
  title: string;
  customerPartyId: string;
  fieldId: string;
  /** 'YYYY-MM-DDTHH:mm' farm time (America/Detroit). */
  windowFrom: string;
  windowTo: string;
  /** '' = with the field (the server decides). */
  cropYear: string;
  /** '' = the field's boundary acres (decision 2a-5); a number = typed by hand. */
  plannedAcres: string;
  plannedQty: string;
  plannedUnit: JobPlannedUnit | '';
  priority: JobPriority;
  notes: string;
  /** '' = no request details. */
  requestChannel: RequestChannel | '';
  requestPartyId: string;
  requesterName: string;
  requesterPhone: string;
  products: ProductLine[];
}

export type FormKey = keyof JobFormValues;
export type FormErrors = Partial<Record<string, string>>;

/** The channels a manager types in (web_form jobs come through a request link). */
export const TYPED_REQUEST_CHANNELS = REQUEST_CHANNELS.filter((c) => c !== 'web_form');

/** The kind a lane's "New job" starts with (the first kind whose default lane it is). */
export function kindForLane(line: BusinessLine): JobKind {
  return JOB_KINDS.find((k) => DEFAULT_BUSINESS_LINE[k] === line) ?? 'other';
}

/** A product's natural rate unit (its stock unit per acre). */
export function defaultRateUnit(unit: ProductUnit): RateUnit {
  const perAcre: Record<ProductUnit, RateUnit> = {
    gal: 'gal_ac',
    qt: 'qt_ac',
    pt: 'pt_ac',
    floz: 'floz_ac',
    lb: 'lb_ac',
    oz: 'oz_ac',
    ton: 'ton_ac',
    bag: 'unit_ac',
    unit: 'unit_ac',
    kseed: 'kseed_ac',
  };
  return perAcre[unit];
}

let lineSeq = 0;
export const newLineKey = () => `line-${++lineSeq}`;

export interface InitialValues {
  fieldId?: string;
  kind?: JobKind;
  businessLine?: BusinessLine;
}

/** A new job's values. With options, a pre-filled field also fills its customer. */
export function newJobValues(
  initial: InitialValues = {},
  options: JobOptionsResponse | null = null,
): JobFormValues {
  const kind = initial.kind ?? (initial.businessLine ? kindForLane(initial.businessLine) : 'spray');
  const fieldId = initial.fieldId ?? '';
  const field = options?.fields.find((f) => f.id === fieldId);
  return {
    kind,
    businessLine: initial.businessLine ?? DEFAULT_BUSINESS_LINE[kind],
    status: 'planned',
    title: '',
    customerPartyId: field?.customerId ?? '',
    fieldId,
    windowFrom: '',
    windowTo: '',
    cropYear: '',
    plannedAcres: '',
    plannedQty: '',
    plannedUnit: '',
    priority: JOB_DEFAULT_PRIORITY,
    notes: '',
    requestChannel: '',
    requestPartyId: '',
    requesterName: '',
    requesterPhone: '',
    products: [],
  };
}

const numText = (n: number | null) => (n === null ? '' : String(n));

/** A priority from the wire (1-4), else the default. */
export function toPriority(n: number): JobPriority {
  return (JOB_PRIORITIES as readonly number[]).includes(n)
    ? (n as JobPriority)
    : JOB_DEFAULT_PRIORITY;
}

/** An existing job's values. */
export function jobValues(job: JobView): JobFormValues {
  return {
    kind: job.kind,
    businessLine: job.businessLine,
    status: job.status === 'requested' ? 'requested' : 'planned',
    title: job.title ?? '',
    customerPartyId: job.customer?.id ?? '',
    fieldId: job.field?.id ?? '',
    windowFrom: job.window?.from ? dateToFarmLocal(job.window.from) : '',
    windowTo: job.window?.to ? dateToFarmLocal(job.window.to) : '',
    cropYear: numText(job.cropYear),
    plannedAcres: job.plannedAcresByHand ? numText(job.plannedAcres) : '',
    plannedQty: numText(job.plannedQty),
    plannedUnit: job.plannedUnit ?? '',
    priority: toPriority(job.priority),
    notes: job.notes ?? '',
    requestChannel: job.request?.channel ?? '',
    requestPartyId: job.request?.partyId ?? '',
    requesterName: job.request?.name ?? '',
    requesterPhone: job.request?.phone ?? '',
    products: job.products.map((p) => ({
      key: `product-${p.productId}`,
      productId: p.productId,
      rate: numText(p.rate),
      unit: p.unit ?? '',
      suppliedBy: p.suppliedBy,
    })),
  };
}

/**
 * One input changed: the new values and dirty set, with the knock-on defaults (a new job's lane
 * follows its kind until the lane is picked; a field fills an empty, untouched customer).
 */
export function applyChange<K extends FormKey>(
  state: { values: JobFormValues; dirty: ReadonlySet<FormKey> },
  key: K,
  value: JobFormValues[K],
  ctx: { mode: FormMode; options: JobOptionsResponse | null },
): { values: JobFormValues; dirty: Set<FormKey> } {
  const values: JobFormValues = { ...state.values, [key]: value };
  const dirty = new Set(state.dirty);
  dirty.add(key);
  if (key === 'kind' && ctx.mode === 'new' && !dirty.has('businessLine')) {
    values.businessLine = DEFAULT_BUSINESS_LINE[value as JobKind];
  }
  if (key === 'fieldId' && !state.dirty.has('customerPartyId') && !values.customerPartyId) {
    const customer = ctx.options?.fields.find((f) => f.id === value)?.customerId;
    if (customer) {
      values.customerPartyId = customer;
      dirty.add('customerPartyId');
    }
  }
  if (key === 'status' && value === 'planned' && ctx.mode === 'new') {
    values.requestChannel = '';
  }
  return { values, dirty };
}

// ---------------------------------------------------------------------------------------------
// Parsing and checks
// ---------------------------------------------------------------------------------------------

/** '1,234.5' -> 1234.5; '' -> null; anything else -> NaN. */
export function parseNumber(text: string): number | null {
  const t = text.replace(/[,\s]/g, '');
  if (t === '') return null;
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return Number.NaN;
  return Number(t);
}

/** The window the inputs say ([from, to), farm time), null when both are empty. */
export function windowOf(v: Pick<JobFormValues, 'windowFrom' | 'windowTo'>): JobWindow | null {
  const from = v.windowFrom ? farmLocalToDate(v.windowFrom) : null;
  const to = v.windowTo ? farmLocalToDate(v.windowTo) : null;
  if (!from && !to) return null;
  return { from: from ? toFarmIso(from) : null, to: to ? toFarmIso(to) : null };
}

const MAX_ACRES = 100_000;
const MAX_QTY = 10_000_000;
const MAX_RATE = 100_000;

/** What is wrong with the values (keyed by input; products by `product:<key>`); {} = fine. */
export function validate(values: JobFormValues, mode: FormMode): FormErrors {
  const e: FormErrors = {};
  if (values.title.trim().length > MAX_JOB_TITLE_CHARS) {
    e.title = `At most ${MAX_JOB_TITLE_CHARS} characters.`;
  }
  if (values.notes.trim().length > MAX_JOB_NOTES_CHARS) {
    e.notes = `At most ${MAX_JOB_NOTES_CHARS.toLocaleString('en-US')} characters.`;
  }
  const from = values.windowFrom ? farmLocalToDate(values.windowFrom) : null;
  const to = values.windowTo ? farmLocalToDate(values.windowTo) : null;
  if (values.windowFrom && !from) e.windowFrom = 'Not a date and time.';
  if (values.windowTo && !to) e.windowTo = 'Not a date and time.';
  if (from && to && from.getTime() >= to.getTime())
    e.windowTo = 'The window must end after it starts.';
  if (values.cropYear && !/^\d{4}$/.test(values.cropYear)) e.cropYear = 'Pick a crop year.';
  const acres = parseNumber(values.plannedAcres);
  if (acres !== null && !(acres >= 0 && acres <= MAX_ACRES)) e.plannedAcres = 'Acres, 0 or more.';
  const qty = parseNumber(values.plannedQty);
  if (qty !== null && !(qty >= 0 && qty <= MAX_QTY)) e.plannedQty = 'A quantity, 0 or more.';
  if (qty !== null && !values.plannedUnit && !e.plannedQty) e.plannedUnit = 'Pick what it counts.';
  if (!(JOB_PRIORITIES as readonly number[]).includes(values.priority)) e.priority = 'Pick one.';
  const requested = mode === 'new' ? values.status === 'requested' : values.requestChannel !== '';
  if (mode === 'new' && values.status === 'requested' && !values.requestChannel) {
    e.requestChannel = 'How did they ask?';
  }
  if (requested) {
    if (values.requesterName.trim().length > MAX_REQUESTER_NAME_CHARS) {
      e.requesterName = `At most ${MAX_REQUESTER_NAME_CHARS} characters.`;
    }
    if (values.requesterPhone.trim().length > MAX_REQUESTER_PHONE_CHARS) {
      e.requesterPhone = `At most ${MAX_REQUESTER_PHONE_CHARS} characters.`;
    }
  }
  if (values.products.length > MAX_JOB_PRODUCTS) {
    e.products = `At most ${MAX_JOB_PRODUCTS} products on a job.`;
  }
  const seen = new Set<string>();
  for (const line of values.products) {
    const key = `product:${line.key}`;
    if (!line.productId) {
      e[key] = 'Pick a product.';
      continue;
    }
    if (seen.has(line.productId)) e[key] = 'This product is on the job already.';
    seen.add(line.productId);
    const rate = parseNumber(line.rate);
    if (rate !== null && !(rate >= 0 && rate <= MAX_RATE)) e[key] = 'A rate, 0 or more.';
    else if (rate !== null && !line.unit) e[key] = 'Pick the rate’s unit.';
  }
  return e;
}

export const hasErrors = (e: FormErrors) => Object.keys(e).length > 0;

// ---------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------

const textOrNull = (s: string) => (s.trim() === '' ? null : s.trim());
const id = (s: string) => (s === '' ? null : s);

function productInputs(lines: readonly ProductLine[]): JobProductInput[] {
  return lines.map((l) => ({
    productId: l.productId,
    rate: parseNumber(l.rate),
    unit: l.unit === '' ? null : l.unit,
    suppliedBy: l.suppliedBy,
  }));
}

function requestOf(v: JobFormValues): NonNullable<CreateJobBodyInput['request']> | null {
  if (!v.requestChannel) return null;
  return {
    channel: v.requestChannel,
    partyId: id(v.requestPartyId),
    name: textOrNull(v.requesterName),
    phone: textOrNull(v.requesterPhone),
  };
}

/** POST /api/v1/jobs (createJobBodySchema): what was filled in; the server defaults the rest. */
export function createBody(v: JobFormValues): CreateJobBodyInput {
  const body: CreateJobBodyInput = { kind: v.kind, businessLine: v.businessLine, status: v.status };
  const title = textOrNull(v.title);
  if (title) body.title = title;
  if (v.fieldId) body.fieldId = v.fieldId;
  if (v.customerPartyId) body.customerPartyId = v.customerPartyId;
  const window = windowOf(v);
  if (window) body.window = window;
  if (v.cropYear) body.cropYear = Number(v.cropYear);
  const acres = parseNumber(v.plannedAcres);
  if (acres !== null) body.plannedAcres = acres;
  const qty = parseNumber(v.plannedQty);
  if (qty !== null) body.plannedQty = qty;
  if (v.plannedUnit) body.plannedUnit = v.plannedUnit;
  body.priority = v.priority;
  const notes = textOrNull(v.notes);
  if (notes) body.notes = notes;
  if (v.status === 'requested') {
    const request = requestOf(v);
    if (request) body.request = request;
  }
  if (v.products.length > 0) body.products = productInputs(v.products);
  return body;
}

const sameInstant = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));

function sameWindow(a: JobWindow | null, b: JobWindow | null): boolean {
  if (a === null || b === null) return a === b;
  return sameInstant(a.from, b.from) && sameInstant(a.to, b.to);
}

function sameProducts(a: readonly JobProductInput[], job: JobView): boolean {
  if (a.length !== job.products.length) return false;
  const byId = new Map(job.products.map((p) => [p.productId, p]));
  return a.every((p) => {
    const q = byId.get(p.productId);
    return (
      q !== undefined &&
      (p.rate ?? null) === q.rate &&
      (p.unit ?? null) === q.unit &&
      (p.suppliedBy ?? 'us') === q.suppliedBy
    );
  });
}

const REQUEST_KEYS: readonly FormKey[] = [
  'requestChannel',
  'requestPartyId',
  'requesterName',
  'requesterPhone',
];

/**
 * PATCH /api/v1/jobs/<id> (updateJobBodySchema): `version` of the job the form is based on, and
 * each changed input whose value differs from that job. Only `version` = nothing to save.
 */
export function updateBody(
  v: JobFormValues,
  base: JobView,
  dirty: ReadonlySet<FormKey>,
): UpdateJobBodyInput {
  const body: UpdateJobBodyInput = { version: base.version };
  const changed = (k: FormKey) => dirty.has(k);
  if (changed('kind') && v.kind !== base.kind) body.kind = v.kind;
  if (changed('businessLine') && v.businessLine !== base.businessLine) {
    body.businessLine = v.businessLine;
  }
  if (changed('title') && textOrNull(v.title) !== base.title) body.title = textOrNull(v.title);
  if (changed('fieldId') && id(v.fieldId) !== (base.field?.id ?? null))
    body.fieldId = id(v.fieldId);
  if (changed('customerPartyId') && id(v.customerPartyId) !== (base.customer?.id ?? null)) {
    body.customerPartyId = id(v.customerPartyId);
  }
  if (changed('windowFrom') || changed('windowTo')) {
    const w = windowOf(v);
    if (!sameWindow(w, base.window)) body.window = w;
  }
  if (changed('cropYear')) {
    const year = v.cropYear ? Number(v.cropYear) : null;
    if (year !== base.cropYear) body.cropYear = year;
  }
  if (changed('plannedAcres')) {
    const acres = parseNumber(v.plannedAcres);
    if (acres === null) {
      // Emptied: hand the acres back to the boundary (only typed ones need it).
      if (base.plannedAcresByHand) body.plannedAcres = null;
    } else if (!base.plannedAcresByHand || acres !== base.plannedAcres) {
      body.plannedAcres = acres;
    }
  }
  if (changed('plannedQty')) {
    const qty = parseNumber(v.plannedQty);
    if (qty !== base.plannedQty) body.plannedQty = qty;
  }
  if (changed('plannedUnit') && (v.plannedUnit || null) !== base.plannedUnit) {
    body.plannedUnit = v.plannedUnit || null;
  }
  if (changed('priority') && v.priority !== base.priority) body.priority = v.priority;
  if (changed('notes') && textOrNull(v.notes) !== base.notes) body.notes = textOrNull(v.notes);
  if (REQUEST_KEYS.some(changed)) {
    const r = requestOf(v);
    const b = base.request;
    const same =
      r === null
        ? b === null
        : b !== null &&
          r.channel === b.channel &&
          (r.partyId ?? null) === b.partyId &&
          (r.name ?? null) === b.name &&
          (r.phone ?? null) === b.phone;
    if (!same) body.request = r;
  }
  if (changed('products')) {
    const products = productInputs(v.products);
    if (!sameProducts(products, base)) body.products = products;
  }
  return body;
}

/** Does an update body change anything? */
export const changesSomething = (body: UpdateJobBodyInput) => Object.keys(body).length > 1;

/**
 * After a 409: the form's values on top of the CURRENT job. What the person changed stays; every
 * other input takes the current job's value (what the other screen saved).
 */
export function rebase(
  values: JobFormValues,
  dirty: ReadonlySet<FormKey>,
  current: JobView,
): JobFormValues {
  const fresh = jobValues(current);
  const out = { ...fresh };
  for (const k of dirty) (out as Record<FormKey, unknown>)[k] = values[k];
  return out;
}

/** Choices for the selects, in display order (the form and its tests share them). */
export const FORM_CHOICES = {
  kinds: JOB_KINDS,
  businessLines: BUSINESS_LINES,
  plannedUnits: JOB_PLANNED_UNITS,
  priorities: JOB_PRIORITIES,
  rateUnits: RATE_UNITS,
  suppliedBy: SUPPLIED_BY,
} as const;
