/**
 * The inputs of one product (add and edit on /admin/products): kind, name, the unit it is bought
 * in, the EPA registration number and the restricted-use mark. The actions check every value
 * again (src/db/queries/products.ts validateProduct).
 */
import type { ProductRow } from '@/db/queries/products';
import { MAX_EPA_REG_NO_CHARS } from '@/db/queries/products';
import {
  MAX_PRODUCT_NAME_CHARS,
  PRODUCT_KIND_LABELS,
  PRODUCT_KINDS,
  PRODUCT_UNIT_LABELS,
  PRODUCT_UNITS,
} from '@/domain/work-jobs';
import adminCss from '../../admin.module.css';
import css from '../../fields/field-data.module.css';

export function ProductFields({ product, prefix }: { product?: ProductRow; prefix: string }) {
  return (
    <div className={css.formGrid}>
      <label className={css.label}>
        Name
        <input
          className={css.input}
          name="name"
          required
          maxLength={MAX_PRODUCT_NAME_CHARS}
          defaultValue={product?.name ?? ''}
          autoComplete="off"
          data-testid={`${prefix}-name`}
        />
      </label>
      <label className={css.label}>
        Kind
        <select
          className={adminCss.select}
          name="kind"
          required
          defaultValue={product?.kind ?? ''}
          data-testid={`${prefix}-kind`}
        >
          <option value="" disabled>
            Pick…
          </option>
          {PRODUCT_KINDS.map((k) => (
            <option key={k} value={k}>
              {PRODUCT_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label className={css.label}>
        Bought in
        <select
          className={adminCss.select}
          name="unit"
          required
          defaultValue={product?.unit ?? ''}
          data-testid={`${prefix}-unit`}
        >
          <option value="" disabled>
            Pick…
          </option>
          {PRODUCT_UNITS.map((u) => (
            <option key={u} value={u}>
              {PRODUCT_UNIT_LABELS[u]}
            </option>
          ))}
        </select>
      </label>
      <label className={css.label}>
        EPA registration number
        <input
          className={css.input}
          name="epaRegNo"
          maxLength={MAX_EPA_REG_NO_CHARS}
          defaultValue={product?.epaRegNo ?? ''}
          placeholder="e.g. 524-475 (chemicals)"
          autoComplete="off"
          data-testid={`${prefix}-epa`}
        />
      </label>
      <label className={css.check}>
        <input
          type="checkbox"
          name="restrictedUse"
          defaultChecked={product?.restrictedUse ?? false}
          data-testid={`${prefix}-restricted`}
        />
        Restricted use (RUP: a certified applicator)
      </label>
    </div>
  );
}
