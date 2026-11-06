/**
 * Products (farm.products, decision 2a-12; docs/contracts-2a.md §3.1, §7.6): the seed,
 * chemicals, fertilizer and fuel a job names. /admin/products lists, adds, edits and retires
 * them; the job form offers the active ones (GET /api/v1/job-options). A product that is on a
 * job can't be deleted (farm.job_products restricts): retire it (`active = false`), which keeps
 * every job that names it intact and takes it off the form's list.
 *
 * Rows the app writes are source 'app'. Demo products (source 'demo', tools/seed/work.ts) can be
 * edited, but the demo seed writes their seeded columns back (only `active` and `label_rules`
 * stay yours). `label_rules` is 2b's go/no-go input and is never written here.
 *
 * Edits are a compare-and-set on `updated_at` (the version the page showed, microseconds): two
 * managers editing the same product never silently overwrite each other.
 */
import { z } from 'zod';
import {
  MAX_PRODUCT_NAME_CHARS,
  PRODUCT_KINDS,
  PRODUCT_UNITS,
  type ProductKind,
  type ProductUnit,
} from '../../domain/work-jobs';
import { type Executor, exec } from '../exec';

/** EPA registration numbers look like "524-475" or "100-1070-279"; allow some room. */
export const MAX_EPA_REG_NO_CHARS = 40;

export interface ProductRow {
  id: string;
  kind: ProductKind;
  name: string;
  epaRegNo: string | null;
  restrictedUse: boolean;
  unit: ProductUnit;
  active: boolean;
  source: string;
  /** Jobs that name it (any status): a product on a job can only be retired. */
  jobCount: number;
  /** Open jobs (requested … in progress) that name it. */
  openJobCount: number;
  /** updated_at, ISO with microseconds: the version an edit compares against. */
  version: string;
}

/** What a manager types for a product (the form, trimmed and checked). */
export const productInputSchema = z.strictObject({
  kind: z.enum(PRODUCT_KINDS, { error: 'pick what kind of product it is' }),
  name: z
    .string()
    .trim()
    .min(1, 'give the product a name')
    .max(MAX_PRODUCT_NAME_CHARS, `a name has at most ${MAX_PRODUCT_NAME_CHARS} characters`),
  epaRegNo: z
    .string()
    .trim()
    .max(MAX_EPA_REG_NO_CHARS, `an EPA number has at most ${MAX_EPA_REG_NO_CHARS} characters`)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .default(null),
  restrictedUse: z.boolean().default(false),
  unit: z.enum(PRODUCT_UNITS, { error: 'pick the unit it is bought in' }),
});
export type ProductInput = z.output<typeof productInputSchema>;
export type RawProductInput = z.input<typeof productInputSchema>;

/** The first problem with a product input, or the clean input. */
export function validateProduct(
  raw: unknown,
): { ok: true; value: ProductInput } | { ok: false; error: string } {
  const r = productInputSchema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues[0]?.message ?? 'check the product' };
}

const VERSION = `to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const OPEN = `('requested', 'planned', 'assigned', 'pushed', 'in_progress')`;

const SELECT = `
  select p.id, p.kind, p.name, p.epa_reg_no, p.restricted_use, p.unit, p.active, p.source,
         ${VERSION} as version,
         (select count(distinct jp.job_id)::int from farm.job_products jp
           where jp.product_id = p.id) as job_count,
         (select count(distinct jp.job_id)::int from farm.job_products jp
            join farm.jobs j on j.id = jp.job_id
           where jp.product_id = p.id and j.status in ${OPEN}) as open_job_count
    from farm.products p`;

interface Raw {
  id: string;
  kind: ProductKind;
  name: string;
  epa_reg_no: string | null;
  restricted_use: boolean;
  unit: ProductUnit;
  active: boolean;
  source: string;
  version: string;
  job_count: number;
  open_job_count: number;
}

const toRow = (r: Raw): ProductRow => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  epaRegNo: r.epa_reg_no,
  restrictedUse: r.restricted_use,
  unit: r.unit,
  active: r.active,
  source: r.source,
  jobCount: r.job_count,
  openJobCount: r.open_job_count,
  version: r.version,
});

/**
 * Every product for /admin/products: active ones first, then retired, each by kind (PRODUCT_KINDS
 * order) and name.
 */
export async function listProducts(ex: Executor): Promise<ProductRow[]> {
  const r = await exec<Raw>(
    ex,
    `${SELECT}
      order by p.active desc, array_position($1::text[], p.kind), lower(p.name), p.id`,
    [PRODUCT_KINDS],
  );
  return r.rows.map(toRow);
}

export async function getProduct(ex: Executor, id: string): Promise<ProductRow | null> {
  const r = await exec<Raw>(ex, `${SELECT} where p.id = $1::uuid`, [id]);
  const row = r.rows[0];
  return row ? toRow(row) : null;
}

/** Add a product (source 'app', active). */
export async function createProduct(ex: Executor, input: ProductInput): Promise<ProductRow> {
  const r = await exec<{ id: string }>(
    ex,
    `insert into farm.products (kind, name, epa_reg_no, restricted_use, unit, source)
     values ($1, $2, $3, $4, $5, 'app') returning id`,
    [input.kind, input.name, input.epaRegNo, input.restrictedUse, input.unit],
  );
  const id = r.rows[0]?.id;
  const row = id ? await getProduct(ex, id) : null;
  if (!row) throw new Error('the product was not saved');
  return row;
}

export type ProductWriteResult =
  | { status: 'saved'; product: ProductRow }
  | { status: 'not_found' }
  /** Someone saved it since `version`: nothing written; `product` is the current row. */
  | { status: 'conflict'; product: ProductRow };

/**
 * Edit a product. `version` is the one the page showed (null skips the check, for scripts).
 * The jobs that name it keep naming it (the job form shows the new name).
 */
export async function updateProduct(
  ex: Executor,
  id: string,
  input: ProductInput,
  version: string | null,
): Promise<ProductWriteResult> {
  const r = await exec<{ id: string }>(
    ex,
    `update farm.products p
        set kind = $2, name = $3, epa_reg_no = $4, restricted_use = $5, unit = $6,
            updated_at = greatest(now(), p.updated_at + interval '1 microsecond')
      where p.id = $1::uuid and ($7::text is null or ${VERSION} = $7)
      returning p.id`,
    [id, input.kind, input.name, input.epaRegNo, input.restrictedUse, input.unit, version],
  );
  return settle(ex, id, r.rowCount > 0);
}

/** Retire (`active = false`) or bring back a product. Idempotent. */
export async function setProductActive(
  ex: Executor,
  id: string,
  active: boolean,
): Promise<ProductWriteResult> {
  const r = await exec<{ id: string }>(
    ex,
    `update farm.products p
        set active = $2,
            updated_at = case when p.active = $2 then p.updated_at
                              else greatest(now(), p.updated_at + interval '1 microsecond') end
      where p.id = $1::uuid
      returning p.id`,
    [id, active],
  );
  return settle(ex, id, r.rowCount > 0);
}

async function settle(ex: Executor, id: string, written: boolean): Promise<ProductWriteResult> {
  const product = await getProduct(ex, id);
  if (!product) return { status: 'not_found' };
  return written ? { status: 'saved', product } : { status: 'conflict', product };
}

export type ProductDeleteResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  /** On `jobCount` jobs: retire it instead. */
  | { status: 'in_use'; jobCount: number };

/**
 * Delete a product nothing names (a typo, a test). One that is on a job answers 'in_use' and
 * stays: the foreign key from farm.job_products restricts, and the check runs in the same
 * statement, so a job saved meanwhile can't slip past it.
 */
export async function deleteProduct(ex: Executor, id: string): Promise<ProductDeleteResult> {
  try {
    const r = await exec(
      ex,
      `delete from farm.products p
        where p.id = $1::uuid
          and not exists (select 1 from farm.job_products jp where jp.product_id = p.id)`,
      [id],
    );
    if (r.rowCount > 0) return { status: 'deleted' };
  } catch (e) {
    // 23503: a job_products row arrived between the check and the delete.
    if ((e as { code?: string }).code !== '23503') throw e;
  }
  const row = await getProduct(ex, id);
  return row ? { status: 'in_use', jobCount: Math.max(1, row.jobCount) } : { status: 'not_found' };
}
