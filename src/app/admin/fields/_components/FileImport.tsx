'use client';
/**
 * Upload panel for the imports on /admin/fields and /admin/parties: choose the file(s), see
 * exactly what would change (the server runs the real import and rolls it back), then apply.
 * The chosen files stay in state between the two steps, so nothing is uploaded twice by hand.
 */
import { useRouter } from 'next/navigation';
import { type ReactNode, useId, useRef, useState, useTransition } from 'react';
import adminCss from '../../admin.module.css';
import type { DataResult } from '../_lib/access';
import type { ImportView } from '../_lib/import-view';
import css from '../field-data.module.css';

type ImportAction = (form: FormData) => Promise<DataResult<ImportView>>;

export function FileImport({
  title,
  accept,
  multiple = false,
  hint,
  preview,
  apply,
  options,
  testId,
}: {
  title: string;
  accept: string;
  multiple?: boolean;
  hint?: ReactNode;
  preview: ImportAction;
  apply: ImportAction;
  /** Extra form controls (named inputs) sent with both steps. */
  options?: ReactNode;
  testId: string;
}) {
  const router = useRouter();
  const inputId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<DataResult<ImportView> | null>(null);
  const [pending, start] = useTransition();
  const [over, setOver] = useState(false);

  const formData = () => {
    const fd = formRef.current ? new FormData(formRef.current) : new FormData();
    fd.delete('files');
    for (const f of files) fd.append('files', f, f.name);
    return fd;
  };
  const run = (action: ImportAction, after?: () => void) =>
    start(async () => {
      try {
        const r = await action(formData());
        setResult(r);
        if (r.ok && r.data?.applied) {
          after?.();
          router.refresh();
        }
      } catch (e) {
        // Next refuses action bodies over 4 MB (next.config.ts) before our code runs.
        setResult({
          ok: false,
          at: Date.now(),
          message: `The upload did not go through (${(e as Error).message}). Files over 4 MB: use the command line (pnpm import:boundaries / import:seasons).`,
        });
      }
    });
  const choose = (list: FileList | null) => {
    setFiles(list ? Array.from(list) : []);
    setResult(null);
  };
  const view = result?.data;

  return (
    <section className={adminCss.card} data-testid={testId}>
      <h2>{title}</h2>
      <form
        ref={formRef}
        className={css.form}
        onSubmit={(e) => {
          e.preventDefault();
          run(preview);
        }}
      >
        <label
          htmlFor={inputId}
          className={`${css.drop} ${over ? css.dropActive : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            choose(e.dataTransfer.files);
          }}
        >
          <span>
            {files.length ? files.map((f) => f.name).join(', ') : 'Choose or drop a file'}
          </span>
          <input
            id={inputId}
            type="file"
            accept={accept}
            multiple={multiple}
            data-testid={`${testId}-file`}
            onChange={(e) => choose(e.currentTarget.files)}
          />
          {hint && <span className={css.muted}>{hint}</span>}
        </label>
        {options}
        <div className={adminCss.row}>
          <button
            type="submit"
            className={adminCss.button}
            disabled={pending || files.length === 0}
            data-testid={`${testId}-preview`}
          >
            {pending ? 'Working…' : 'Preview'}
          </button>
          {view?.canApply && (
            <button
              type="button"
              className={`${adminCss.button} ${adminCss.primary}`}
              disabled={pending}
              data-testid={`${testId}-apply`}
              onClick={() => run(apply, () => setFiles([]))}
            >
              Apply
            </button>
          )}
        </div>
      </form>
      {result && (
        <div aria-live="polite" data-testid={`${testId}-result`} data-ok={result.ok}>
          <p className={result.ok ? undefined : adminCss.error}>
            <strong>{view?.applied ? 'Done: ' : ''}</strong>
            {view?.summary ?? result.message}
          </p>
          {view && view.rows.length > 0 && (
            <div className={adminCss.tableWrap}>
              <table className={`${adminCss.table} ${css.report}`}>
                <thead>
                  <tr>
                    {view.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((r, i) => (
                    // Rows have no ids of their own; the order is the file's.
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable for one result
                    <tr key={i} data-tone={r.tone}>
                      {r.cells.map((cell, j) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: fixed columns
                        <td key={j} className={j === 0 || j === 1 ? css[r.tone] : undefined}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {view && view.problems.length > 0 && (
            <ul className={css.problems}>
              {view.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
