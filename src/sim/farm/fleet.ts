/**
 * The demo fleet (plan §2 step 5: 2 combines, 2 grain carts, a sprayer, a planter, 4 semis, a
 * drone) with everything the simulator needs to move them plausibly: speeds, capacities, fuel
 * burn and the engine-hour / odometer readings they start from.
 *
 * Vendor ids (contracts §9): JDLink machines carry a Deere Equipment API id in
 * SIM_DEERE_HOME_ORG (combines, the tractors pulling the grain carts and the planter, the
 * sprayer); semis carry an ELD vehicle id. The drone has neither (manual status until D18).
 */
import type { MachineKind } from '../../domain/fleet';
import { deterministicId } from '../../domain/ids';
import { hash32 } from '../rng';

export type MachineRole = 'combine' | 'cart' | 'semi' | 'sprayer' | 'planter' | 'drone';

export interface FleetSpec {
  key: string;
  kind: MachineKind;
  role: MachineRole;
  unitNo: string;
  make: string;
  model: string;
  year: number;
  deere: boolean;
  eld: boolean;
  implementWidthFt?: number;
  /** Road speed (empty, for semis). */
  roadMph: number;
  /** Loaded road speed (semis). */
  loadedRoadMph?: number;
  /** In-field / in-yard transport speed. */
  fieldMph: number;
  /** Working speed on a pass. */
  workMph?: number;
  /** Speed through headland turns. */
  turnMph?: number;
  /** Grain tank / cart / trailer capacity in bushels. */
  capacityBu?: number;
  /** Unload rate in bushels per second (combine auger, cart auger). */
  unloadBuPerSec?: number;
  /** Product or seed capacity in acres per fill (sprayer, planter). */
  acresPerFill?: number;
  /** Minutes to refill at the field (tender / seed tender). */
  refillMin?: number;
  fuelTankGal: number;
  /** Fuel burn in gallons per hour. */
  burnGalPerHour: { working: number; transport: number; idle: number };
  /** Engine hours on 2026-01-01 and per year. */
  hoursAt2026: number;
  hoursPerYear: number;
  /** Odometer (miles) on 2026-01-01 and per year. */
  odometerAt2026: number;
  milesPerYear: number;
}

export const FLEET: readonly FleetSpec[] = [
  {
    key: 'combine-1',
    kind: 'combine',
    role: 'combine',
    unitNo: 'C1',
    make: 'John Deere',
    model: 'X9 1100',
    year: 2024,
    deere: true,
    eld: false,
    implementWidthFt: 40,
    roadMph: 18,
    fieldMph: 6,
    workMph: 4.6,
    turnMph: 2.5,
    capacityBu: 480,
    unloadBuPerSec: 4.5,
    fuelTankGal: 400,
    burnGalPerHour: { working: 24, transport: 11, idle: 3.5 },
    hoursAt2026: 612,
    hoursPerYear: 330,
    odometerAt2026: 2140,
    milesPerYear: 900,
  },
  {
    key: 'combine-2',
    kind: 'combine',
    role: 'combine',
    unitNo: 'C2',
    make: 'John Deere',
    model: 'S790',
    year: 2021,
    deere: true,
    eld: false,
    implementWidthFt: 30,
    roadMph: 18,
    fieldMph: 6,
    workMph: 4.3,
    turnMph: 2.5,
    capacityBu: 400,
    unloadBuPerSec: 3.8,
    fuelTankGal: 330,
    burnGalPerHour: { working: 19, transport: 10, idle: 3 },
    hoursAt2026: 2143,
    hoursPerYear: 380,
    odometerAt2026: 6810,
    milesPerYear: 1100,
  },
  {
    key: 'cart-1',
    kind: 'grain_cart',
    role: 'cart',
    unitNo: 'GC1',
    make: 'Kinze',
    model: '1300 grain cart on JD 8R 410',
    year: 2022,
    deere: true,
    eld: false,
    roadMph: 20,
    fieldMph: 9,
    capacityBu: 1300,
    unloadBuPerSec: 9,
    fuelTankGal: 210,
    burnGalPerHour: { working: 10, transport: 9, idle: 2.5 },
    hoursAt2026: 3118,
    hoursPerYear: 460,
    odometerAt2026: 9420,
    milesPerYear: 2600,
  },
  {
    key: 'cart-2',
    kind: 'grain_cart',
    role: 'cart',
    unitNo: 'GC2',
    make: 'Brent',
    model: '1196 grain cart on JD 8R 370',
    year: 2019,
    deere: true,
    eld: false,
    roadMph: 20,
    fieldMph: 9,
    capacityBu: 1100,
    unloadBuPerSec: 8,
    fuelTankGal: 200,
    burnGalPerHour: { working: 9, transport: 8, idle: 2.5 },
    hoursAt2026: 4476,
    hoursPerYear: 430,
    odometerAt2026: 13110,
    milesPerYear: 2400,
  },
  {
    key: 'sprayer-1',
    kind: 'sprayer',
    role: 'sprayer',
    unitNo: 'SP1',
    make: 'John Deere',
    model: 'R4045',
    year: 2022,
    deere: true,
    eld: false,
    implementWidthFt: 120,
    roadMph: 28,
    fieldMph: 10,
    workMph: 13,
    turnMph: 6,
    acresPerFill: 80,
    refillMin: 14,
    fuelTankGal: 160,
    burnGalPerHour: { working: 9, transport: 8, idle: 2 },
    hoursAt2026: 1852,
    hoursPerYear: 420,
    odometerAt2026: 8730,
    milesPerYear: 3100,
  },
  {
    key: 'planter-1',
    kind: 'planter',
    role: 'planter',
    unitNo: 'P1',
    make: 'John Deere',
    model: 'DB60 planter on JD 8R 370',
    year: 2020,
    deere: true,
    eld: false,
    implementWidthFt: 60,
    roadMph: 15,
    fieldMph: 7,
    workMph: 5.5,
    turnMph: 3,
    acresPerFill: 110,
    refillMin: 20,
    fuelTankGal: 200,
    burnGalPerHour: { working: 10, transport: 8, idle: 2.5 },
    hoursAt2026: 3561,
    hoursPerYear: 380,
    odometerAt2026: 10230,
    milesPerYear: 1500,
  },
  ...(
    [
      ['semi-1', 'S1', 'Peterbilt', '579', 2021, 412_300, 11_240],
      ['semi-2', 'S2', 'Kenworth', 'T680', 2019, 538_900, 14_870],
      ['semi-3', 'S3', 'Freightliner', 'Cascadia', 2018, 611_450, 16_920],
      ['semi-4', 'S4', 'Peterbilt', '389', 2016, 702_180, 19_330],
    ] as const
  ).map(
    ([key, unitNo, make, model, year, odometer, hours]): FleetSpec => ({
      key,
      kind: 'semi',
      role: 'semi',
      unitNo,
      make,
      model: `${model} + hopper trailer`,
      year,
      deere: false,
      eld: true,
      roadMph: 50,
      loadedRoadMph: 45,
      fieldMph: 6,
      capacityBu: 1000,
      fuelTankGal: 240,
      burnGalPerHour: { working: 1, transport: 7.5, idle: 0.9 },
      hoursAt2026: hours,
      hoursPerYear: 1300,
      odometerAt2026: odometer,
      milesPerYear: 38_000,
    }),
  ),
  {
    key: 'drone-1',
    kind: 'drone',
    role: 'drone',
    unitNo: 'D1',
    make: 'Hylio',
    model: 'AG-272',
    year: 2025,
    deere: false,
    eld: false,
    implementWidthFt: 30,
    roadMph: 20,
    fieldMph: 10,
    fuelTankGal: 1,
    burnGalPerHour: { working: 0, transport: 0, idle: 0 },
    hoursAt2026: 41,
    hoursPerYear: 60,
    odometerAt2026: 0,
    milesPerYear: 0,
  },
];

/** Deere Equipment API machine id (numeric string, like JDLink principal ids). */
export function deereMachineId(key: string): string {
  return String(1_000_000 + (hash32('sim-deere-machine', key) % 9_000_000));
}

/** ELD vehicle id (numeric string, Samsara-style). */
export function eldVehicleId(key: string): string {
  return String(281_474_976_710_656 + (hash32('sim-eld-vehicle', key) % 1_000_000));
}

/** Deere GUID-style ids for farms, fields and boundaries (vendor ids, not our ids). */
export function deereGuid(kind: string, key: string): string {
  return deterministicId('sim-deere', `${kind}:${key}`);
}

export function fleetSpec(key: string): FleetSpec {
  const spec = FLEET.find((f) => f.key === key);
  if (!spec) throw new Error(`unknown fleet key ${key}`);
  return spec;
}

/** Engine hours / odometer a machine has at an instant (linear wear since 2026-01-01). */
export function countersAt(
  spec: FleetSpec,
  ms: number,
): { engineHours: number; odometerMi: number } {
  const years = (ms - Date.UTC(2026, 0, 1)) / (365.25 * 86_400_000);
  return {
    engineHours: Math.max(0, spec.hoursAt2026 + spec.hoursPerYear * years),
    odometerMi: Math.max(0, spec.odometerAt2026 + spec.milesPerYear * years),
  };
}
