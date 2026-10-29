/**
 * Contacts CSV for /admin/parties (plan 1c "landlords, customers and crew through admin forms
 * and CSV import"). Template: tools/import/templates/parties.csv
 *
 *   display_name, kind, roles, phone, email, address, notes, org
 *
 * `roles`: one or more of owner, crew, landlord, customer, elevator, vendor, neighbor,
 * separated by ';' (or '|'). `kind`: person (default) or org. `org`: the organization a
 * person works for (an existing one, or a row of this file). Pure; the database part is
 * importParties in src/db/queries/parties.ts.
 */
import { type PartyImportRow, validateParty } from '../../src/db/queries/parties';
import { readCsv } from './csv';
import type { RowProblem } from './seasons-csv';

export const PARTY_COLUMNS = [
  'display_name',
  'kind',
  'roles',
  'phone',
  'email',
  'address',
  'notes',
  'org',
] as const;

/** Headers people also use for these columns. */
const ALIASES: Record<string, string> = {
  name: 'display_name',
  full_name: 'display_name',
  role: 'roles',
  type: 'kind',
  organization: 'org',
  company: 'org',
  works_for: 'org',
  phone_number: 'phone',
  cell: 'phone',
  email_address: 'email',
  e_mail: 'email',
  note: 'notes',
};

export interface PartyCsvResult {
  rows: PartyImportRow[];
  errors: RowProblem[];
  warnings: RowProblem[];
}

export function parsePartiesCsv(text: string): PartyCsvResult {
  const table = readCsv(text, { required: [['display_name', 'name', 'full_name']] });
  const errors: RowProblem[] = [];
  const warnings: RowProblem[] = [];
  const known = new Set<string>([...PARTY_COLUMNS, ...Object.keys(ALIASES)]);
  const unknown = table.headers.filter((h) => h && !known.has(h));
  if (unknown.length)
    warnings.push({ line: 1, message: `ignored column(s): ${unknown.join(', ')}` });
  const rows: PartyImportRow[] = [];
  const seen = new Map<string, number>();
  for (const { line, cells: raw } of table.rows) {
    const cells: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const col = ALIASES[k] ?? k;
      if (!cells[col]) cells[col] = v;
    }
    const v = validateParty({
      displayName: cells.display_name,
      kind: cells.kind,
      roles: cells.roles,
      phone: cells.phone,
      email: cells.email,
      address: cells.address,
      notes: cells.notes,
    });
    if (!v.ok) {
      for (const message of v.errors) errors.push({ line, message });
      continue;
    }
    for (const message of v.warnings) warnings.push({ line, message });
    const key = v.value.displayName.toLowerCase().replace(/\s+/g, ' ');
    const earlier = seen.get(key);
    if (earlier) {
      errors.push({ line, message: `'${v.value.displayName}' is also on line ${earlier}` });
      continue;
    }
    seen.set(key, line);
    rows.push({ ...v.value, line, org: cells.org ? cells.org.replace(/\s+/g, ' ').trim() : null });
  }
  return { rows, errors, warnings };
}
