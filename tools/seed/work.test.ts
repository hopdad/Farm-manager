/**
 * The job board's demo data, pure parts (./work.ts; docs/contracts-2a.md §4.4, §9): the
 * customer-org party links the seed writes are the ones the simulated farm implies.
 */
import { describe, expect, test } from 'vitest';
import { demoId } from '../../src/domain/ids';
import { buildDemoFarm } from '../../src/sim/farm/build';
import { simCustomerOrgParties } from '../../src/sim/types';
import { DEMO_CUSTOMER_ORGS } from './work';

describe('DEMO_CUSTOMER_ORGS', () => {
  test('Halvorsen owns org-customer-1; Juniper Hill shares its fields from org-customer-2', () => {
    for (const seed of [1, 7]) {
      expect(simCustomerOrgParties(buildDemoFarm(seed))).toEqual(
        DEMO_CUSTOMER_ORGS.map((o) => ({ orgId: o.org, partyId: demoId(o.party) })),
      );
    }
  });
});
