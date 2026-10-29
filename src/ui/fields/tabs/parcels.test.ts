/**
 * The Parcels tab (react-dom/server, no browser): the view model (owners for managers only, acres,
 * overlap, coverage gap, synthetic note), the wall and phone markup, the empty and loading states,
 * its registration, and the server-side redaction it relies on.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { canSeeParcelOwners, redactParcelOwners } from '../../../db/queries/parcels-access';
import type { FieldDetail } from '../../../domain/fields';
import type { FieldParcelRow } from '../../../domain/parcels';
import { FIELD_PANEL_TABS } from '../tab-registry';
import { orderTabs, TAB_ORDER } from '../tabs';
import { ParcelsBody, ParcelsTab, parcelsTab, parcelsTabView } from './parcels';

const P1: FieldParcelRow = {
  id: 'p1',
  countyFips: '26091',
  parcelNo: 'SYN-091-517034-01',
  ownerName: 'Ivan Abernath',
  ownerMailing: '3173 Fenmore Rd, Adrian, MI 49221',
  propertyAddress: null,
  acres: 80,
  gisAcres: 79.94,
  importSource: 'synthetic',
  receivedOn: null,
  overlapAcres: 76.4,
  overlapPct: 99.6,
};

function detail(parcels: FieldParcelRow[]): FieldDetail {
  return { parcels } as unknown as FieldDetail;
}

describe('parcelsTabView', () => {
  test('managers see owners and mailing; acres from the file and the map; overlap', () => {
    const v = parcelsTabView(detail([P1]), 'manager');
    expect(v.ownersVisible).toBe(true);
    expect(v.cards[0]).toMatchObject({
      owner: 'Ivan Abernath',
      mailing: '3173 Fenmore Rd, Adrian, MI 49221',
      county: 'Lenawee',
      acres: '80.0 ac (file) · 79.9 ac mapped',
      overlap: '76.4 ac of this field (100 %)',
      synthetic: true,
    });
    expect(v.summary).toBe('1 parcel · 76.4 ac of the field');
    expect(v.gap).toBeNull();
    expect(v.sourceNote).toMatch(/Synthetic demo parcels/);
  });

  test('below manager: no owner names or mailing, even if the data had them', () => {
    for (const role of ['viewer', 'driver', 'operator'] as const) {
      const v = parcelsTabView(detail([P1]), role);
      expect(v.ownersVisible).toBe(false);
      expect(v.cards[0]?.owner).toBeNull();
      expect(v.cards[0]?.mailing).toBeNull();
    }
    expect(canSeeParcelOwners('owner')).toBe(true);
  });

  test('several parcels: summary, a coverage gap is pointed out, no synthetic note for county data', () => {
    const p2 = {
      ...P1,
      id: 'p2',
      parcelNo: 'B',
      overlapAcres: 30.2,
      overlapPct: 39.5,
      importSource: 'lenawee-county',
      acres: null,
      countyFips: '26115',
    };
    const p1 = { ...P1, overlapPct: 50, importSource: 'lenawee-county' };
    const v = parcelsTabView(detail([p1, p2]), 'owner');
    expect(v.summary).toBe('2 parcels · 107 ac of the field');
    expect(v.gap).toMatch(/cover 90 %/);
    expect(v.sourceNote).toBeNull();
    expect(v.cards[1]).toMatchObject({ county: 'Monroe', acres: '79.9 ac mapped' });
  });

  test('empty', () => {
    expect(parcelsTabView(detail([]), 'owner')).toMatchObject({
      empty: true,
      cards: [],
      summary: null,
    });
  });
});

describe('markup', () => {
  test('wall: one card per parcel with test ids; owners shown to managers', () => {
    const html = renderToStaticMarkup(
      createElement(ParcelsBody, {
        view: parcelsTabView(detail([P1]), 'manager'),
        variant: 'wall',
      }),
    );
    expect(html).toContain('data-testid="field-parcels"');
    expect(html).toContain('data-parcel-no="SYN-091-517034-01"');
    expect(html).toContain('Ivan Abernath');
    expect(html).toContain('3173 Fenmore Rd');
    expect(html).toContain('Synthetic demo parcels');
  });

  test('phone, viewer: "Owner: managers only", no owner text anywhere', () => {
    const html = renderToStaticMarkup(
      createElement(ParcelsTab, {
        fieldId: 'f',
        detail: detail([P1]),
        variant: 'phone',
        role: 'viewer',
        onChanged: () => {},
      }),
    );
    expect(html).toContain('Owner: managers only');
    expect(html).not.toContain('Abernath');
    expect(html).not.toContain('Fenmore');
  });

  test('loading skeleton and empty state', () => {
    const loading = renderToStaticMarkup(
      createElement(ParcelsTab, {
        fieldId: 'f',
        detail: null,
        variant: 'wall',
        role: 'owner',
        onChanged: () => {},
      }),
    );
    expect(loading).toContain('aria-busy="true"');
    const empty = renderToStaticMarkup(
      createElement(ParcelsBody, { view: parcelsTabView(detail([]), 'owner'), variant: 'wall' }),
    );
    expect(empty).toContain('data-testid="field-parcels-empty"');
    expect(empty).toContain('pnpm gis:parcels');
  });
});

test('registered as the Parcels tab in its reserved slot', () => {
  expect(parcelsTab).toMatchObject({ id: 'parcels', label: 'Parcels', order: TAB_ORDER.parcels });
  expect(orderTabs(FIELD_PANEL_TABS).map((t) => t.id)).toContain('parcels');
});

test('redactParcelOwners removes owners below manager and never mutates its input', () => {
  const rows = [P1];
  const viewer = redactParcelOwners(rows, 'viewer');
  expect(viewer[0]).toMatchObject({ ownerName: null, ownerMailing: null, parcelNo: P1.parcelNo });
  expect(rows[0]?.ownerName).toBe('Ivan Abernath');
  expect(redactParcelOwners(rows, 'manager')[0]?.ownerName).toBe('Ivan Abernath');
  expect(redactParcelOwners(rows, 'manager')[0]).not.toBe(P1);
});
