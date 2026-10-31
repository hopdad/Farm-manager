/**
 * The Samsara equipment-feed replay fixtures: the committed JSON is ./equipment-fixtures.ts's
 * output, every body read by the live client's schemas with nothing dropped, every machine one the
 * demo seed maps, and (across everything CONNECTOR_SAMSARA=replay serves) no two exchanges
 * answering the same request.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildDemoFarm } from '../../sim/farm/build';
import { simExternalRefs } from '../../sim/types';
import { replayFixtureSchema } from '../replay';
import { buildSamsaraEquipmentFixtures } from './equipment-fixtures';
import { equipmentPositionItems, equipmentStatItems } from './equipment-mapper';
import { samsaraEquipmentReplayFixtures } from './equipment-replay';
import { EQUIPMENT_STAT_GROUPS, samsaraEquipmentFeedSchema } from './equipment-schemas';
import { samsaraReplayFixtures } from './replay';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'doc-derived');
const built = buildSamsaraEquipmentFixtures();

describe('Samsara equipment-feed fixtures', () => {
  test('the committed files are what the builder makes; replay serves them', () => {
    for (const [rel, fixture] of Object.entries(built)) {
      const committed = JSON.parse(readFileSync(path.join(dir, ...rel.split('/')), 'utf8'));
      expect(committed, `${rel} is out of date: run equipment-fixtures-write.ts`).toEqual(
        JSON.parse(JSON.stringify(fixture)),
      );
    }
    expect(samsaraEquipmentReplayFixtures).toHaveLength(Object.keys(built).length);
    expect(samsaraReplayFixtures).toEqual(
      expect.arrayContaining([...samsaraEquipmentReplayFixtures]),
    );
  });

  test('layout, metadata, and every body read by the live schemas', () => {
    for (const [rel, f] of Object.entries(built)) {
      const parsed = replayFixtureSchema.parse(f);
      expect(rel.startsWith(`${parsed.stream}/`)).toBe(true);
      expect(parsed.reference).toMatch(/https:\/\/developers\.samsara\.com\/openapi\//);
      expect(parsed.reference).toMatch(/no real farm data/);
      for (const x of parsed.exchanges) {
        const page = samsaraEquipmentFeedSchema.parse(x.response.body);
        if (parsed.stream === 'equipment_positions') {
          expect(equipmentPositionItems(page.data).dropped).toEqual([]);
        } else {
          const types = x.request.query?.types;
          const group = types === EQUIPMENT_STAT_GROUPS.hours.join(',') ? 'hours' : 'state';
          expect(types).toBe(EQUIPMENT_STAT_GROUPS[group].join(','));
          expect(equipmentStatItems(group, page.data).dropped).toEqual([]);
        }
      }
    }
  });

  test('every machine is a Samsara asset-gateway machine the demo seed maps', () => {
    const farm = buildDemoFarm();
    const gateways = new Set(
      farm.machines
        .filter((m) => m.telematics?.vendor === 'samsara' && m.telematics.feed === 'equipment')
        .map((m) => m.id),
    );
    const known = new Set(
      simExternalRefs(farm)
        .filter((r) => r.ref.source === 'samsara' && gateways.has(r.entityId))
        .map((r) => r.ref.externalId),
    );
    expect(known.size).toBe(1);
    for (const f of Object.values(built)) {
      for (const x of f.exchanges) {
        for (const row of (x.response.body as { data: { id: string }[] }).data) {
          expect(known.has(row.id)).toBe(true);
        }
      }
    }
  });

  test('no two exchanges CONNECTOR_SAMSARA=replay serves answer the same request', () => {
    const keys = samsaraReplayFixtures.flatMap((f) =>
      f.exchanges.map((x) =>
        JSON.stringify([
          x.request.method,
          x.request.path,
          x.request.query ?? {},
          x.request.body ?? null,
        ]),
      ),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
