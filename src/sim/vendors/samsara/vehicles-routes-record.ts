/**
 * One demo vehicle as Samsara's `GET /fleet/vehicles` lists it (slice 1f.2, terminal-pickups):
 * the stand-in's vehicle module (./vehicles-routes.ts) and the replay fixtures' builder
 * (src/connectors/samsara/vehicles-fixtures.ts) both use it, so the two never disagree on shape.
 * A file of its own (no import of ./modules.ts), so the fixture builder loads it without the
 * stand-in's router.
 */
import type { SamsaraVehicle } from '../../../connectors/samsara/vehicles-schemas';
import { hash32 } from '../../rng';
import type { SimMachine } from '../../types';

/** When the demo farm's vehicles were added to its Samsara org (fixed: replies are stable). */
const ADDED_AT = '2026-03-02T15:00:00.000Z';

const tagId = (name: string) => String(3_000 + (hash32('sim-samsara-tag', name) % 7_000));

/**
 * One demo vehicle as Samsara's GET /fleet/vehicles lists it (also the replay fixtures' builder,
 * src/connectors/samsara/vehicles-fixtures.ts, so the two never disagree on shape).
 */
export function samsaraVehicleRecord(m: SimMachine, tags?: readonly string[]): SamsaraVehicle {
  const t = m.telematics;
  const id = t?.id ?? '';
  const carmaker = t?.via === 'ford_pro' || t?.via === 'stellantis';
  const names = tags ?? t?.tags ?? [];
  return {
    id,
    name: m.unitNo,
    createdAtTime: ADDED_AT,
    updatedAtTime: ADDED_AT,
    make: m.make,
    model: m.model.replace(/ \+ .*$/, ''),
    year: String(m.year),
    tags: names.map((name) => ({ id: tagId(name), name })),
    ...(carmaker
      ? {}
      : {
          gateway: {
            model: 'VG54NA',
            serial: `GVR${(hash32('sim-samsara-gateway', id) % 1_000_000).toString(36).toUpperCase().padStart(4, '0')}`,
          },
        }),
    vehicleRegulationMode: m.kind === 'semi' ? 'regulated' : 'unregulated',
  };
}
