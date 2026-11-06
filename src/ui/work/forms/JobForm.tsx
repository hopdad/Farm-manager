'use client';
/**
 * The new and edit job form (slice 2a; docs/contracts-2a.md §7.3): kind, business line,
 * customer, field, window, crop year, planned qty / unit / acres, products with rate, unit and
 * supplied-by, notes, request channel and requester. It loads its choices from GET
 * /api/v1/job-options and saves through POST /api/v1/jobs (new) or PATCH /api/v1/jobs/<id>
 * (edit, with the job's version; a 409 shows JOB_CONFLICT_MESSAGE with the current job).
 * Rendered by the board (wall popover, phone sheet) and by the field panel's Jobs tab ("New job
 * here", `initial.fieldId`).
 *
 * The rules live in ./form-model.ts (unit-tested): an edit sends only what the person changed;
 * after a 409 the form shows the current job with their changes on top and Save tries again
 * with the new version. The calls are ./client.ts. Owned by job-forms (src/ui/work/forms/**);
 * props frozen (additive changes only). Test ids: contracts-2a §7.5 (`job-form`, data-mode,
 * `job-form-save`, `job-form-cancel`, inputs `job-form-<name>`; the 409 line `job-form-conflict`).
 */
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  BUSINESS_LINE_LABELS,
  type BusinessLine,
  JOB_KIND_LABELS,
  JOB_PLANNED_UNIT_LABELS,
  JOB_PRIORITY_LABELS,
  type JobKind,
  MAX_JOB_PRODUCTS,
  PRODUCT_KIND_LABELS,
  RATE_UNIT_LABELS,
  type RateUnit,
  REQUEST_CHANNEL_LABELS,
  type RequestChannel,
  SUPPLIED_BY_LABELS,
  type SuppliedBy,
} from '../../../domain/work-jobs';
import type { MapVariant } from '../../map/types';
import type { JobOptionsResponse, JobView } from '../contract';
import { statusLook } from '../style';
import { cachedJobOptions, loadJobOptions, saveJob } from './client';
import {
  applyChange,
  changesSomething,
  createBody,
  defaultRateUnit,
  FORM_CHOICES,
  type FormErrors,
  type FormKey,
  type FormMode,
  hasErrors,
  type JobFormValues,
  jobValues,
  newJobValues,
  newLineKey,
  type ProductLine,
  rebase,
  TYPED_REQUEST_CHANNELS,
  toPriority,
  updateBody,
  validate,
} from './form-model';
import css from './job-form.module.css';

export interface JobFormProps {
  variant: MapVariant;
  /** The job to edit; null or absent = a new job. */
  job?: JobView | null;
  /** Pre-filled values of a new job (a field tapped, a lane's "New job"). */
  initial?: { fieldId?: string; kind?: JobKind; businessLine?: BusinessLine };
  /** Saved: the job as the server answered it. */
  onSaved(job: JobView): void;
  onCancel(): void;
}

export type FormNotice = { kind: 'error' | 'conflict'; text: string } | null;

export function JobForm({ variant, job = null, initial, onSaved, onCancel }: JobFormProps) {
  const mode: FormMode = job ? 'edit' : 'new';
  const [options, setOptions] = useState<JobOptionsResponse | null>(() => cachedJobOptions());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [base, setBase] = useState<JobView | null>(job);
  const [form, setForm] = useState(() => ({
    values: job ? jobValues(job) : newJobValues(initial, cachedJobOptions()),
    dirty: new Set<FormKey>(),
  }));
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<FormNotice>(null);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  const initialFieldId = initial?.fieldId;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The choices: shown at once from the last load, always revalidated.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger.
  useEffect(() => {
    const ctrl = new AbortController();
    loadJobOptions((input, init) => fetch(input, init), ctrl.signal)
      .then((r) => {
        if (ctrl.signal.aborted) return;
        if (!r.ok) {
          setLoadError(r.message);
          return;
        }
        setLoadError(null);
        setOptions(r.options);
        // A pre-filled field of a new job brings its customer (unless one was picked meanwhile).
        const customer = r.options.fields.find((x) => x.id === initialFieldId)?.customerId;
        if (mode === 'new' && customer) {
          setForm((f) =>
            f.dirty.has('customerPartyId') || f.values.customerPartyId
              ? f
              : { ...f, values: { ...f.values, customerPartyId: customer } },
          );
        }
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [attempt, mode, initialFieldId]);

  const onChange = useCallback(
    <K extends FormKey>(key: K, value: JobFormValues[K]) => {
      setForm((f) => applyChange(f, key, value, { mode, options }));
      setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    },
    [mode, options],
  );

  const discard = useCallback(() => {
    if (!base) return;
    setForm({ values: jobValues(base), dirty: new Set() });
    setErrors({});
    setNotice(null);
  }, [base]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const found = validate(form.values, mode);
    setErrors(found);
    if (hasErrors(found)) {
      setNotice({ kind: 'error', text: 'Check the marked fields.' });
      return;
    }
    let body: unknown;
    if (mode === 'edit' && base) {
      const patch = updateBody(form.values, base, form.dirty);
      if (!changesSomething(patch)) {
        onSaved(base);
        return;
      }
      body = patch;
    } else {
      body = createBody(form.values);
    }
    setSaving(true);
    setNotice(null);
    const r = await saveJob((input, init) => fetch(input, init), mode, body, base?.id);
    if (!mounted.current) return;
    setSaving(false);
    if (r.kind === 'saved') {
      onSaved(r.job);
    } else if (r.kind === 'conflict') {
      // The other screen's copy, with this person's changes on top: Save tries again.
      setForm((f) => ({ values: rebase(f.values, f.dirty, r.job), dirty: f.dirty }));
      setBase(r.job);
      setNotice({ kind: 'conflict', text: r.message });
    } else {
      setNotice({ kind: 'error', text: r.message });
    }
  };

  return (
    <JobFormView
      variant={variant}
      mode={mode}
      values={form.values}
      options={options}
      base={base}
      errors={errors}
      saving={saving}
      notice={notice}
      loadError={loadError}
      onChange={onChange}
      onSubmit={submit}
      onCancel={onCancel}
      onRetryLoad={() => setAttempt((n) => n + 1)}
      onDiscard={discard}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// The view (pure: ./JobForm.test.ts renders it to HTML)
// ---------------------------------------------------------------------------------------------

export interface JobFormViewProps {
  variant: MapVariant;
  mode: FormMode;
  values: JobFormValues;
  /** null while the first load runs. */
  options: JobOptionsResponse | null;
  /** The job an edit is based on (the current one after a 409). */
  base: JobView | null;
  errors: FormErrors;
  saving: boolean;
  notice: FormNotice;
  loadError: string | null;
  onChange<K extends FormKey>(key: K, value: JobFormValues[K]): void;
  onSubmit(e: FormEvent): void;
  onCancel(): void;
  onRetryLoad(): void;
  onDiscard(): void;
}

const acresText = (n: number | null | undefined) =>
  n === null || n === undefined
    ? null
    : `${n.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ac`;

function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child.
    <label className={`${css.label} ${className ?? ''}`}>
      <span>{label}</span>
      {children}
      {hint && <span className={css.hint}>{hint}</span>}
      {error && <span className={css.fieldError}>{error}</span>}
    </label>
  );
}

function cropYearChoices(options: JobOptionsResponse | null, base: JobView | null): number[] {
  const years = new Set<number>(options?.cropYears ?? []);
  if (base?.cropYear) years.add(base.cropYear);
  return [...years].sort((a, b) => a - b);
}

function acresHint(v: JobFormValues, boundary: number | null, base: JobView | null): string {
  if (v.plannedAcres !== '') return 'Typed by hand: a new boundary won’t change them.';
  if (!v.fieldId) return 'From the field’s boundary once it has a field.';
  const acres = boundary ?? null;
  return acres !== null
    ? `From the boundary: ${acresText(acres)}.`
    : base?.plannedAcres !== null && base?.plannedAcres !== undefined
      ? `From the boundary: ${acresText(base.plannedAcres)}.`
      : 'From the boundary.';
}

const customerLabel = (c: JobOptionsResponse['customers'][number]) =>
  c.orgName ? `${c.name} · ${c.orgName}` : c.name;

export function JobFormView(p: JobFormViewProps) {
  const { values: v, options, errors, base, mode } = p;
  const headingId = useId();
  const field = options?.fields.find((f) => f.id === v.fieldId) ?? null;
  const boundaryAcres =
    field?.acres ?? (base?.field?.id === v.fieldId ? (base?.field?.boundaryAcres ?? null) : null);
  const requested =
    mode === 'new'
      ? v.status === 'requested'
      : v.requestChannel !== '' || base?.status === 'requested';
  const ready = options !== null;
  const look = base ? statusLook(base.status) : null;
  const disabled = !ready || p.saving;
  const channels: readonly RequestChannel[] =
    v.requestChannel === 'web_form'
      ? [...TYPED_REQUEST_CHANNELS, 'web_form']
      : TYPED_REQUEST_CHANNELS;

  /** Props of a text input or select bound to `key`. */
  const bind = (key: FormKey) => ({
    value: v[key] as string,
    onChange: (e: { target: { value: string } }) =>
      p.onChange(key, e.target.value as JobFormValues[typeof key]),
    'aria-invalid': errors[key] ? true : undefined,
  });

  return (
    <form
      className={`${css.form} ${p.variant === 'wall' ? css.wall : css.phone}`}
      data-testid="job-form"
      data-mode={mode}
      data-variant={p.variant}
      data-state={p.saving ? 'saving' : ready ? 'ready' : 'loading'}
      aria-labelledby={headingId}
      aria-busy={disabled}
      onSubmit={p.onSubmit}
      noValidate
    >
      <div className={css.head}>
        <h3 className={css.title} id={headingId}>
          {mode === 'new' ? 'New job' : `Edit: ${base?.summary ?? 'job'}`}
        </h3>
        {look && (
          <span
            className={css.status}
            data-testid="job-form-current-status"
            data-status={base?.status}
          >
            <span className={css.dot} style={{ background: look.fill }} aria-hidden="true" />
            {look.label}
          </span>
        )}
      </div>

      {p.loadError && (
        <div
          className={`${css.message} ${css.error}`}
          role="alert"
          data-testid="job-form-load-error"
        >
          Couldn’t load the fields, customers and products: {p.loadError}{' '}
          <button type="button" className={`${css.button} ${css.small}`} onClick={p.onRetryLoad}>
            Try again
          </button>
        </div>
      )}
      {!ready && !p.loadError && <p className={css.muted}>Loading the fields and products…</p>}

      {p.notice?.kind === 'conflict' && (
        <div
          className={`${css.message} ${css.conflict}`}
          role="alert"
          data-testid="job-form-conflict"
        >
          <span>{p.notice.text}</span>
          <span className={css.muted}>
            This is the job as it is now, with your changes on top. Save again to keep yours.
          </span>
          <span>
            <button
              type="button"
              className={`${css.button} ${css.small}`}
              onClick={p.onDiscard}
              data-testid="job-form-discard"
            >
              Drop my changes
            </button>
          </span>
        </div>
      )}
      {p.notice?.kind === 'error' && (
        <p className={`${css.message} ${css.error}`} role="alert" data-testid="job-form-error">
          {p.notice.text}
        </p>
      )}

      <fieldset className={css.section} disabled={disabled}>
        <legend className={css.sectionTitle}>What</legend>
        <div className={css.grid}>
          <Field label="Kind" error={errors.kind}>
            <select className={css.select} data-testid="job-form-kind" {...bind('kind')}>
              {FORM_CHOICES.kinds.map((k) => (
                <option key={k} value={k}>
                  {JOB_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Lane" error={errors.businessLine}>
            <select
              className={css.select}
              data-testid="job-form-business-line"
              {...bind('businessLine')}
            >
              {FORM_CHOICES.businessLines.map((l) => (
                <option key={l} value={l}>
                  {BUSINESS_LINE_LABELS[l]}
                </option>
              ))}
            </select>
          </Field>
          {mode === 'new' && (
            <Field label="Status" error={errors.status}>
              <select className={css.select} data-testid="job-form-status" {...bind('status')}>
                <option value="planned">Planned</option>
                <option value="requested">Requested (a customer asked)</option>
              </select>
            </Field>
          )}
          <Field label="Priority" error={errors.priority}>
            <select
              className={css.select}
              data-testid="job-form-priority"
              value={String(v.priority)}
              onChange={(e) => p.onChange('priority', toPriority(Number(e.target.value)))}
            >
              {FORM_CHOICES.priorities.map((n) => (
                <option key={n} value={n}>
                  {JOB_PRIORITY_LABELS[n]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field
          label="Title (optional)"
          hint="Without one the card says the kind, the field and the acres."
          error={errors.title}
        >
          <input
            className={css.input}
            data-testid="job-form-title"
            maxLength={80}
            autoComplete="off"
            {...bind('title')}
          />
        </Field>
      </fieldset>

      <fieldset className={css.section} disabled={disabled}>
        <legend className={css.sectionTitle}>Where and for whom</legend>
        <div className={css.grid}>
          <Field
            label="Field"
            hint={v.fieldId ? undefined : 'No field yet: drag the card onto one on the map later.'}
            error={errors.fieldId}
          >
            <select className={css.select} data-testid="job-form-field" {...bind('fieldId')}>
              <option value="">No field yet</option>
              {base?.field && !options?.fields.some((f) => f.id === base.field?.id) && (
                <option value={base.field.id}>{base.field.name}</option>
              )}
              {options?.fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {[f.name, f.farmName, acresText(f.acres)].filter(Boolean).join(' · ')}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Customer"
            hint={v.customerPartyId ? undefined : 'Our own work, unless the field is a customer’s.'}
            error={errors.customerPartyId}
          >
            <select
              className={css.select}
              data-testid="job-form-customer"
              {...bind('customerPartyId')}
            >
              <option value="">Our own work</option>
              {base?.customer && !options?.customers.some((c) => c.id === base.customer?.id) && (
                <option value={base.customer.id}>{base.customer.name}</option>
              )}
              {options?.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {customerLabel(c)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset className={css.section} disabled={disabled}>
        <legend className={css.sectionTitle}>When and how much</legend>
        <div className={css.grid}>
          <Field label="From" hint="Farm time (Michigan)." error={errors.windowFrom}>
            <input
              type="datetime-local"
              className={css.input}
              data-testid="job-form-window-from"
              {...bind('windowFrom')}
            />
          </Field>
          <Field label="Until" error={errors.windowTo}>
            <input
              type="datetime-local"
              className={css.input}
              data-testid="job-form-window-to"
              {...bind('windowTo')}
            />
          </Field>
          <Field label="Crop year" error={errors.cropYear}>
            <select className={css.select} data-testid="job-form-crop-year" {...bind('cropYear')}>
              {(mode === 'new' || base?.cropYear === null) && (
                <option value="">{v.fieldId ? 'The field’s growing year' : 'This year'}</option>
              )}
              {cropYearChoices(options, base).map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Planned acres"
            hint={acresHint(v, boundaryAcres, base)}
            error={errors.plannedAcres}
          >
            <input
              className={css.input}
              data-testid="job-form-planned-acres"
              inputMode="decimal"
              autoComplete="off"
              placeholder={
                boundaryAcres === null ? '' : String(Math.round(boundaryAcres * 10) / 10)
              }
              {...bind('plannedAcres')}
            />
          </Field>
          <Field label="Planned amount" error={errors.plannedQty}>
            <input
              className={css.input}
              data-testid="job-form-planned-qty"
              inputMode="decimal"
              autoComplete="off"
              {...bind('plannedQty')}
            />
          </Field>
          <Field label="Counted in" error={errors.plannedUnit}>
            <select
              className={css.select}
              data-testid="job-form-planned-unit"
              {...bind('plannedUnit')}
            >
              <option value="">—</option>
              {FORM_CHOICES.plannedUnits.map((u) => (
                <option key={u} value={u}>
                  {JOB_PLANNED_UNIT_LABELS[u]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {mode === 'edit' && base?.plannedAcresByHand && v.plannedAcres !== '' && (
          <span>
            <button
              type="button"
              className={`${css.button} ${css.small}`}
              data-testid="job-form-planned-acres-reset"
              onClick={() => p.onChange('plannedAcres', '')}
            >
              Use the boundary’s acres
            </button>
          </span>
        )}
      </fieldset>

      <ProductsEditor {...p} disabled={disabled} />

      {requested && (
        <fieldset className={css.section} disabled={disabled} data-testid="job-form-request">
          <legend className={css.sectionTitle}>Who asked</legend>
          <div className={css.grid}>
            <Field label="How" error={errors.requestChannel}>
              <select
                className={css.select}
                data-testid="job-form-request-channel"
                {...bind('requestChannel')}
              >
                <option value="">—</option>
                {channels.map((c) => (
                  <option key={c} value={c}>
                    {REQUEST_CHANNEL_LABELS[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Customer who asked" error={errors.requestPartyId}>
              <select
                className={css.select}
                data-testid="job-form-requester"
                {...bind('requestPartyId')}
              >
                <option value="">Someone else (type the name)</option>
                {options?.customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {customerLabel(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name" error={errors.requesterName}>
              <input
                className={css.input}
                data-testid="job-form-requester-name"
                autoComplete="off"
                maxLength={120}
                {...bind('requesterName')}
              />
            </Field>
            <Field label="Phone" error={errors.requesterPhone}>
              <input
                className={css.input}
                data-testid="job-form-requester-phone"
                type="tel"
                autoComplete="off"
                maxLength={40}
                {...bind('requesterPhone')}
              />
            </Field>
          </div>
        </fieldset>
      )}

      <fieldset className={css.section} disabled={disabled}>
        <legend className={css.sectionTitle}>Notes</legend>
        <Field label="Notes for the crew" error={errors.notes}>
          <textarea
            className={css.textarea}
            data-testid="job-form-notes"
            maxLength={4000}
            {...bind('notes')}
          />
        </Field>
      </fieldset>

      <div className={css.actions}>
        <button
          type="button"
          className={css.button}
          onClick={p.onCancel}
          data-testid="job-form-cancel"
        >
          Cancel
        </button>
        <button
          type="submit"
          className={`${css.button} ${css.primary}`}
          disabled={disabled}
          aria-busy={p.saving}
          data-testid="job-form-save"
        >
          {p.saving ? 'Saving…' : mode === 'new' ? 'Add job' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function ProductsEditor(p: JobFormViewProps & { disabled: boolean }) {
  const { values: v, options, errors, base } = p;
  const lines = v.products;
  const info = (productId: string) => {
    const o = options?.products.find((x) => x.id === productId);
    if (o) return { name: o.name, kind: o.kind, restrictedUse: o.restrictedUse, retired: false };
    const b = base?.products.find((x) => x.productId === productId);
    return b ? { name: b.name, kind: b.kind, restrictedUse: b.restrictedUse, retired: true } : null;
  };
  const set = (next: ProductLine[]) => p.onChange('products', next);
  const update = (key: string, patch: Partial<ProductLine>) =>
    set(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const chosen = new Set(lines.map((l) => l.productId));
  const addable = options?.products.filter((o) => !chosen.has(o.id)) ?? [];
  const add = (productId: string) => {
    const o = options?.products.find((x) => x.id === productId);
    if (!o) return;
    set([
      ...lines,
      { key: newLineKey(), productId, rate: '', unit: defaultRateUnit(o.unit), suppliedBy: 'us' },
    ]);
  };

  return (
    <fieldset className={css.section} disabled={p.disabled} data-testid="job-form-products">
      <legend className={css.sectionTitle}>Products</legend>
      {lines.length === 0 && <p className={css.muted}>No products on this job.</p>}
      {lines.length > 0 && (
        <ul className={css.products}>
          {lines.map((l) => {
            const it = info(l.productId);
            const err = errors[`product:${l.key}`];
            return (
              <li
                key={l.key}
                className={css.productRow}
                data-testid="job-form-product"
                data-product-id={l.productId}
              >
                <span className={`${css.label} ${css.productName}`}>
                  <span>Product</span>
                  <strong>
                    {it?.name ?? 'Unknown product'}
                    {it?.restrictedUse && <span className={css.badge}>restricted use</span>}
                    {it?.retired && <span className={css.badge}>retired</span>}
                  </strong>
                  {it && <span className={css.hint}>{PRODUCT_KIND_LABELS[it.kind]}</span>}
                  {err && <span className={css.fieldError}>{err}</span>}
                </span>
                <Field label="Rate">
                  <input
                    className={css.input}
                    data-testid="job-form-product-rate"
                    inputMode="decimal"
                    autoComplete="off"
                    value={l.rate}
                    aria-invalid={err ? true : undefined}
                    onChange={(e) => update(l.key, { rate: e.target.value })}
                  />
                </Field>
                <Field label="Unit">
                  <select
                    className={css.select}
                    data-testid="job-form-product-unit"
                    value={l.unit}
                    onChange={(e) => update(l.key, { unit: e.target.value as RateUnit | '' })}
                  >
                    <option value="">—</option>
                    {FORM_CHOICES.rateUnits.map((u) => (
                      <option key={u} value={u}>
                        {RATE_UNIT_LABELS[u]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Supplied by">
                  <select
                    className={css.select}
                    data-testid="job-form-product-supplied-by"
                    value={l.suppliedBy}
                    onChange={(e) => update(l.key, { suppliedBy: e.target.value as SuppliedBy })}
                  >
                    {FORM_CHOICES.suppliedBy.map((s) => (
                      <option key={s} value={s}>
                        {SUPPLIED_BY_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </Field>
                <button
                  type="button"
                  className={css.button}
                  data-testid="job-form-product-remove"
                  aria-label={`Remove ${it?.name ?? 'this product'}`}
                  onClick={() => set(lines.filter((x) => x.key !== l.key))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {errors.products && <span className={css.fieldError}>{errors.products}</span>}
      {lines.length < MAX_JOB_PRODUCTS && addable.length > 0 && (
        <Field label="Add a product">
          <select
            className={css.select}
            data-testid="job-form-product-add"
            value=""
            onChange={(e) => {
              if (e.target.value) add(e.target.value);
            }}
          >
            <option value="">Pick a product…</option>
            {addable.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.restrictedUse ? ' (restricted use)' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
    </fieldset>
  );
}
