/**
 * Plain-text reports for the import CLIs (a terminal on Windows PowerShell: ASCII only, no
 * colours, one line per row so it can be copied into a message).
 */
import type { BoundaryImportReport } from '../../src/db/queries/boundaries';

const ac = (n: number | null) => (n === null ? '-' : n.toFixed(1));

/** Fixed-width columns. */
export function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

export function formatBoundaryReport(r: BoundaryImportReport): string {
  const rows = r.items.map((i) => {
    const delta =
      i.acresBefore !== null && i.acresAfter !== null && i.action === 'update'
        ? ` (${i.acresAfter - i.acresBefore >= 0 ? '+' : ''}${(i.acresAfter - i.acresBefore).toFixed(1)})`
        : '';
    return [
      i.action,
      i.name,
      i.fieldName && i.fieldName !== i.name ? i.fieldName : '',
      i.farmName ?? '',
      i.matchedBy ?? '',
      `${ac(i.acresBefore)} -> ${ac(i.acresAfter)}${delta}`,
    ];
  });
  const out = [
    table(['action', 'name in file', 'app field', 'farm', 'matched by', 'acres'], rows),
    '',
  ];
  for (const i of r.items) {
    if (i.reason) out.push(`  skip   ${i.name}: ${i.reason}`);
    for (const w of i.warnings) out.push(`  note   ${i.name}: ${w}`);
  }
  if (r.farmsCreated.length) out.push(`  farms created: ${r.farmsCreated.join(', ')}`);
  if (r.demoHidden) out.push(`  demo fields hidden: ${r.demoHidden}`);
  const c = r.counts;
  out.push(
    `${r.dryRun ? 'DRY RUN (nothing written): ' : ''}${c.create} created, ${c.update} updated, ${c.unchanged} unchanged, ${c.skip} skipped; versions start ${r.effectiveAt}`,
  );
  return out.join('\n');
}
