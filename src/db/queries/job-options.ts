/**
 * What the job form picks from (GET /api/v1/job-options, JobOptionsResponse in
 * src/ui/work/contract.ts; docs/contracts-2a.md §5.2, §7.3): one read, four small lists.
 *
 *  - products: the ACTIVE products (retired ones stay on the jobs that name them; the form
 *    shows those from the job itself), by kind (PRODUCT_KINDS order) and name;
 *  - customers: parties with role customer of EITHER kind, organizations first, then persons,
 *    each by name; a person's organization as `orgName` ("Gail Pressler · Juniper Hill");
 *  - fields: active fields with a current boundary (what the map shows), with their farm, the
 *    boundary's acres (the planned acres a job gets unless typed, decision 2a-5) and the
 *    customer the farm is custom work for (farms.client_party_id: the job's default customer);
 *  - cropYears: the synced seasons, `cropSeasonsToSync(now)` (D23), and `currentCropYear(now)`,
 *    the fallback for a job with no field (decision 2a-6).
 */
import { cropSeasonsToSync, currentCropYear } from '../../domain/crops';
import { PRODUCT_KINDS } from '../../domain/work-jobs';
import type { JobOptionsResponse } from '../../ui/work/contract';
import { type Executor, exec } from '../exec';

type Options = JobOptionsResponse;

export async function jobOptions(ex: Executor, now: Date): Promise<Options> {
  const [products, customers, fields] = await Promise.all([
    exec<Options['products'][number]>(
      ex,
      `select p.id, p.kind, p.name, p.unit, p.epa_reg_no as "epaRegNo",
              p.restricted_use as "restrictedUse", p.active
         from farm.products p
        where p.active
        order by array_position($1::text[], p.kind), lower(p.name), p.id`,
      [PRODUCT_KINDS],
    ),
    exec<Options['customers'][number]>(
      ex,
      `select p.id, p.display_name as name, p.kind,
              case when p.kind = 'person' then o.display_name end as "orgName"
         from farm.parties p
         left join farm.parties o on o.id = p.org_id
        where 'customer' = any (p.roles)
        order by p.kind = 'person', lower(p.display_name), p.id`,
    ),
    exec<Options['fields'][number]>(
      ex,
      `select f.id, f.name, fa.name as "farmName", b.acres::float8 as acres,
              fa.client_party_id as "customerId"
         from farm.fields f
         join farm.current_boundaries b on b.field_id = f.id
         join farm.farms fa on fa.id = f.farm_id
        where f.active
        order by lower(f.name), f.id`,
    ),
  ]);
  return {
    products: products.rows,
    customers: customers.rows,
    fields: fields.rows,
    cropYears: cropSeasonsToSync(now),
    currentCropYear: currentCropYear(now),
  };
}
