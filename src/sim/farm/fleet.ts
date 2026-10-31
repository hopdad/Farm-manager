/**
 * The demo fleet (plan §2 step 5: 2 combines, 2 grain carts, a sprayer, a planter, 4 semis, a
 * drone) with everything the simulator needs to move them plausibly: speeds, capacities, fuel
 * burn and the engine-hour / odometer readings they start from.
 *
 * Vendor ids (contracts §9): JDLink machines carry a Deere Equipment API id in
 * SIM_DEERE_HOME_ORG (combines, the tractors pulling the grain carts and the planter, the
 * sprayer); semis carry a Samsara vehicle id. The drone has neither (manual status until D18).
 *
 * 1f.2, the mixed fleet (docs/contracts-1f.md part B): appended AFTER the M0 machines, so their
 * indices, shop slots and motion are unchanged (no scenario names the new keys: they stay parked
 * at the shop, engines off):
 *   C3  Case IH Axial-Flow 8260 combine   CNH FieldOps (its own API; id = VIN, org = the company)
 *   T1  Case IH Magnum 340 tractor        CNH FieldOps
 *   SP2 RoGator RG1100C sprayer           Samsara asset gateway (equipment feeds, via gateway)
 *   L1  Kubota SVL97-2 track loader       AEMP provider `kubota`
 *   H1  hired hauler's Kenworth T880      Motive (on a Motive Vehicle Gateway)
 *   H2  hired hauler's Volvo VNL 760      Geotab
 *   H3  hired hauler's Mack Anthem        Terminal (connection of an Omnitracs XRS hauler)
 *   PU1 Ford F-250 Super Duty pickup      Samsara, via Ford Pro (carmaker cloud, sparser fixes)
 *   PU2 Ram 2500 pickup                   Samsara, via Stellantis Mobilisights
 * A machine whose route doesn't report a counter has none here (`odometerAt2026: null`, as for
 * a loader, a drone or a parked sprayer's road miles): the seed then writes null, never 0.
 */
import type { MachineKind } from '../../domain/fleet';
import { deterministicId } from '../../domain/ids';
import { hash32 } from '../rng';
import {
  SIM_CNH_COMPANY_ID,
  SIM_TERMINAL_CONNECTION_ID,
  type SimTelematics,
  type SimTelematicsVendor,
} from '../types';

export type MachineRole =
  | 'combine'
  | 'cart'
  | 'semi'
  | 'sprayer'
  | 'planter'
  | 'drone'
  | 'tractor'
  | 'loader'
  | 'pickup';

export interface FleetSpec {
  key: string;
  kind: MachineKind;
  role: MachineRole;
  unitNo: string;
  make: string;
  model: string;
  year: number;
  deere: boolean;
  /** 1f.2: the telematics connection that serves the machine (the id is derived from the key). */
  telematics?: Omit<SimTelematics, 'id'>;
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
  /** Odometer (miles) on 2026-01-01 and per year; null = the machine has none (never 0). */
  odometerAt2026: number | null;
  milesPerYear: number;
}

/**
 * Carmaker-cloud vehicles (Ford Pro, Stellantis) report sparser than a plugged-in gateway: the
 * stand-in sends their positions every 30 wall seconds (under the demo's 60 s stale threshold).
 */
export const CARMAKER_REPORT_EVERY_SECONDS = 30;

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
      telematics: { vendor: 'samsara', feed: 'vehicle', tags: ['Semi'] },
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
    implementWidthFt: 30,
    roadMph: 20,
    fieldMph: 10,
    fuelTankGal: 1,
    burnGalPerHour: { working: 0, transport: 0, idle: 0 },
    hoursAt2026: 41,
    hoursPerYear: 60,
    odometerAt2026: null,
    milesPerYear: 0,
  },
  // ---- 1f.2: the mixed fleet (parked at the shop in every scenario) -------------------------
  {
    key: 'combine-cnh-1',
    kind: 'combine',
    role: 'combine',
    unitNo: 'C3',
    make: 'Case IH',
    model: 'Axial-Flow 8260',
    year: 2023,
    deere: false,
    telematics: { vendor: 'cnh', provider: SIM_CNH_COMPANY_ID },
    implementWidthFt: 40,
    roadMph: 18,
    fieldMph: 6,
    workMph: 4.5,
    turnMph: 2.5,
    capacityBu: 410,
    unloadBuPerSec: 4,
    fuelTankGal: 330,
    burnGalPerHour: { working: 21, transport: 10, idle: 3 },
    hoursAt2026: 1460,
    hoursPerYear: 320,
    odometerAt2026: 3900,
    milesPerYear: 850,
  },
  {
    key: 'tractor-cnh-1',
    kind: 'tractor',
    role: 'tractor',
    unitNo: 'T1',
    make: 'Case IH',
    model: 'Magnum 340',
    year: 2022,
    deere: false,
    telematics: { vendor: 'cnh', provider: SIM_CNH_COMPANY_ID },
    roadMph: 25,
    fieldMph: 8,
    fuelTankGal: 230,
    burnGalPerHour: { working: 14, transport: 9, idle: 2.5 },
    hoursAt2026: 2210,
    hoursPerYear: 450,
    odometerAt2026: 5400,
    milesPerYear: 1200,
  },
  {
    key: 'sprayer-2',
    kind: 'sprayer',
    role: 'sprayer',
    unitNo: 'SP2',
    make: 'RoGator',
    model: 'RG1100C',
    year: 2021,
    deere: false,
    telematics: { vendor: 'samsara', feed: 'equipment', via: 'gateway' },
    implementWidthFt: 120,
    roadMph: 30,
    fieldMph: 10,
    workMph: 14,
    turnMph: 6,
    acresPerFill: 90,
    refillMin: 14,
    fuelTankGal: 175,
    burnGalPerHour: { working: 10, transport: 8, idle: 2 },
    hoursAt2026: 2480,
    hoursPerYear: 400,
    // Samsara's equipment feed reports a GPS odometer (gpsOdometerMeters) for a gateway.
    odometerAt2026: 7_640,
    milesPerYear: 2_300,
  },
  {
    key: 'loader-1',
    kind: 'loader',
    role: 'loader',
    unitNo: 'L1',
    make: 'Kubota',
    model: 'SVL97-2 track loader',
    year: 2020,
    deere: false,
    telematics: { vendor: 'aemp', provider: 'kubota' },
    roadMph: 7,
    fieldMph: 5,
    fuelTankGal: 30,
    burnGalPerHour: { working: 4, transport: 3, idle: 1 },
    hoursAt2026: 1830,
    hoursPerYear: 300,
    odometerAt2026: null,
    milesPerYear: 0,
  },
  ...(
    [
      ['semi-hauler-motive', 'H1', 'Kenworth', 'T880', 2020, 488_200, 13_410, 'motive'],
      ['semi-hauler-geotab', 'H2', 'Volvo', 'VNL 760', 2019, 571_640, 15_020, 'geotab'],
      ['semi-hauler-terminal', 'H3', 'Mack', 'Anthem', 2021, 402_870, 11_960, 'terminal'],
    ] as const
  ).map(
    ([key, unitNo, make, model, year, odometer, hours, vendor]): FleetSpec => ({
      key,
      kind: 'semi',
      role: 'semi',
      unitNo,
      make,
      model: `${model} + hopper trailer (hired)`,
      year,
      deere: false,
      telematics:
        vendor === 'motive'
          ? { vendor, gateway: true }
          : vendor === 'terminal'
            ? { vendor, provider: SIM_TERMINAL_CONNECTION_ID, tsp: 'omnitracs-xrs' }
            : { vendor },
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
  ...(
    [
      ['pickup-1', 'PU1', 'Ford', 'F-250 Super Duty', 2023, 'ford_pro', 31_800, 1_120],
      ['pickup-2', 'PU2', 'Ram', '2500 Tradesman', 2022, 'stellantis', 44_260, 1_610],
    ] as const
  ).map(
    ([key, unitNo, make, model, year, via, odometer, hours]): FleetSpec => ({
      key,
      kind: 'pickup',
      role: 'pickup',
      unitNo,
      make,
      model,
      year,
      deere: false,
      telematics: {
        vendor: 'samsara',
        feed: 'vehicle',
        via,
        reportEverySeconds: CARMAKER_REPORT_EVERY_SECONDS,
        tags: ['Pickup'],
      },
      roadMph: 55,
      fieldMph: 10,
      fuelTankGal: 34,
      burnGalPerHour: { working: 1, transport: 2.4, idle: 0.6 },
      hoursAt2026: hours,
      hoursPerYear: 420,
      odometerAt2026: odometer,
      milesPerYear: 21_000,
    }),
  ),
];

/** Deere Equipment API machine id (numeric string, like JDLink principal ids). */
export function deereMachineId(key: string): string {
  return String(1_000_000 + (hash32('sim-deere-machine', key) % 9_000_000));
}

/** Samsara vehicle / asset id (numeric string; the M0 semis keep their ids). */
export function eldVehicleId(key: string): string {
  return String(281_474_976_710_656 + (hash32('sim-eld-vehicle', key) % 1_000_000));
}

/** The telematics id of a machine in its vendor (deterministic, vendor-shaped). */
export function telematicsId(vendor: SimTelematicsVendor, key: string, provider?: string): string {
  switch (vendor) {
    case 'samsara':
      return eldVehicleId(key);
    case 'motive':
      return String(100_000 + (hash32('sim-motive-vehicle', key) % 900_000));
    case 'geotab':
      return `b${(hash32('sim-geotab-device', key) % 46_656).toString(36).toUpperCase()}`;
    case 'aemp': {
      const prefix = (provider ?? 'aemp').slice(0, 3).toUpperCase();
      return `${prefix}${String(1_000_000 + (hash32('sim-aemp-equipment', key) % 9_000_000))}`;
    }
    case 'cnh': // CNH addresses machines by VIN (GET /equipment, /Fleet/Equipment/{vin}/…)
      return `YJG${String(10_000_000 + (hash32('sim-cnh-vin', key) % 90_000_000))}`;
    case 'terminal':
      return `vcl_${hash32('sim-terminal-vehicle', key).toString(16).padStart(8, '0')}`;
  }
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

/**
 * Engine hours / odometer a machine has at an instant (linear wear since 2026-01-01). A machine
 * with no odometer reads 0 here (the sim sample's number); vendors never report it (the seed
 * writes null, and a stand-in leaves it out).
 */
export function countersAt(
  spec: FleetSpec,
  ms: number,
): { engineHours: number; odometerMi: number } {
  const years = (ms - Date.UTC(2026, 0, 1)) / (365.25 * 86_400_000);
  return {
    engineHours: Math.max(0, spec.hoursAt2026 + spec.hoursPerYear * years),
    odometerMi: Math.max(0, (spec.odometerAt2026 ?? 0) + spec.milesPerYear * years),
  };
}
