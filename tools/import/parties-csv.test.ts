import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseRoles, validateParty } from '../../src/db/queries/parties';
import { decodeCsvBytes, readCsv } from './csv';
import { PARTY_COLUMNS, parsePartiesCsv } from './parties-csv';

const here = import.meta.dirname;

describe('parsePartiesCsv', () => {
  test('template header and the example file', () => {
    const tpl = readFileSync(path.join(here, 'templates', 'parties.csv'), 'utf8');
    expect(readCsv(tpl).headers).toEqual([...PARTY_COLUMNS]);
    const r = parsePartiesCsv(
      readFileSync(path.join(here, 'templates', 'parties-example.csv'), 'utf8'),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.displayName, x.kind, x.roles, x.org])).toEqual([
      ['River Bend Land LLC', 'org', ['landlord'], null],
      ['Joan Albrecht', 'person', ['landlord'], 'River Bend Land LLC'],
      ['Piotrowski Farms', 'org', ['customer'], null],
      ['Casey Morgan', 'person', ['crew'], null],
    ]);
    expect(r.rows[0]?.address).toBe('1200 River Rd, Adrian MI 49221');
  });

  test('a file Excel saved on Windows (Windows-1252) keeps its accents and curly quotes', () => {
    const bytes = Buffer.from(
      'display_name,kind,roles,phone\r\nJos\xe9 O\x92Brien,person,landlord,555-0100\r\n',
      'latin1',
    );
    const r = parsePartiesCsv(decodeCsvBytes(bytes));
    expect(r.errors).toEqual([]);
    expect(r.rows[0]?.displayName).toBe('José O’Brien');
    // UTF-8 (with Excel's BOM) is read as UTF-8.
    const utf8 = Buffer.from('\ufeffdisplay_name\r\nJosé O’Brien\r\n', 'utf8');
    expect(parsePartiesCsv(decodeCsvBytes(utf8)).rows[0]?.displayName).toBe('José O’Brien');
  });

  test('aliases, several roles, problems by line', () => {
    const r = parsePartiesCsv(
      [
        'Name,Type,Role,Phone Number,E-mail,Company',
        'Dale Mercer,,crew;Landlords,517 555 0101,DALE@EXAMPLE.COM,',
        ',person,crew,,,',
        'Bad Role,person,tenant,,,',
        'Bad Mail,person,crew,,not-mail,',
        'Brambleton Land LLC,,landlord,,,',
        'dale  mercer,person,crew,,,',
      ].join('\n'),
    );
    expect(r.rows[0]).toMatchObject({
      line: 2,
      displayName: 'Dale Mercer',
      roles: ['crew', 'landlord'],
      phone: '517 555 0101',
      email: 'dale@example.com',
    });
    expect(r.errors.map((e) => [e.line, e.message])).toEqual([
      [3, 'the name is empty'],
      [
        4,
        'unknown role(s): tenant (roles: owner, crew, landlord, customer, elevator, vendor, neighbor)',
      ],
      [5, "'not-mail' is not an email address"],
      [7, "'dale mercer' is also on line 2"],
    ]);
    expect(r.warnings).toEqual([
      {
        line: 6,
        message: "'Brambleton Land LLC' looks like an organization: set kind to org if it is one",
      },
    ]);
  });
});

describe('validateParty / parseRoles', () => {
  test('organizations never belong to another; phone and length checks', () => {
    const org = validateParty({ displayName: 'X Co', kind: 'Organization', orgId: 'abc' });
    expect(org).toMatchObject({ ok: true, value: { kind: 'org', orgId: null } });
    expect(validateParty({ displayName: 'A', phone: 'call me' })).toMatchObject({ ok: false });
    expect(validateParty({ displayName: 'A'.repeat(121) })).toMatchObject({ ok: false });
    expect(parseRoles(['Customer', 'customer', 'vendor'])).toEqual({
      roles: ['customer', 'vendor'],
      unknown: [],
    });
  });
});
