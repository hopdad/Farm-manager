/**
 * The providers the Terminal stand-in lists on GET /providers (slice 1f.2, terminal-pickups):
 * four entries of Terminal's own public catalog as its unauthenticated `GET /providers` answered
 * on Oct 30, 2026 (trimmed to the models the app reads, plus a few others so the shape stays
 * honest). Omnitracs XRS is the demo hauler H3's provider (`SimTelematics.tsp`). Public vendor
 * metadata, no farm data.
 */
import type { TerminalProvider } from '../../../connectors/terminal/schemas';

const read = (r: 'supported' | 'not_supported_by_terminal' | 'not_supported_by_provider') => ({
  supportedOperations: { read: r },
});

export const SIM_TERMINAL_PROVIDERS: readonly TerminalProvider[] = [
  {
    name: 'Omnitracs XRS',
    status: 'live',
    code: 'omnitracs-xrs',
    logo: 'https://cdn.withterminal.com/providers/omnitracs-xrs/logo.png',
    icon: 'https://cdn.withterminal.com/providers/omnitracs-xrs/icon.png',
    references: [{ type: 'login-page', url: 'https://xataxrs.com/', label: 'Omnitracs XRS Login' }],
    passthrough: { supported: true },
    supportedModels: {
      Vehicle: read('supported'),
      Driver: read('supported'),
      VehicleLocation: {
        sampleRate: '60 seconds',
        availableHistory: 'Vehicle location: 120 days. Safety events: 90 days',
        ...read('supported'),
      },
      VehicleStatLog: {
        ...read('supported'),
        types: ['engine_state', 'odometer', 'engine_runtime', 'engine_rpm'],
      },
      LatestVehicleLocation: read('supported'),
      Trip: read('supported'),
      Group: read('supported'),
      FaultCodeEvent: read('supported'),
      VehicleUtilization: read('not_supported_by_terminal'),
    },
  },
  {
    name: 'Samsara',
    status: 'live',
    code: 'samsara',
    logo: 'https://cdn.withterminal.com/providers/samsara/logo.png',
    icon: 'https://cdn.withterminal.com/providers/samsara/icon.png',
    passthrough: { supported: true },
    supportedModels: {
      Vehicle: read('supported'),
      VehicleLocation: {
        sampleRate: '5 seconds',
        availableHistory: 'Unlimited',
        ...read('supported'),
      },
      VehicleStatLog: {
        ...read('supported'),
        types: [
          'engine_state',
          'odometer',
          'fuel_level',
          'engine_runtime',
          'engine_oil_pressure',
          'engine_coolant_temperature',
          'engine_rpm',
          'battery_voltage',
          'total_fuel_consumption',
        ],
      },
      LatestVehicleLocation: read('supported'),
      FaultCodeEvent: read('supported'),
    },
  },
  {
    name: 'Geotab',
    status: 'live',
    code: 'geotab',
    logo: 'https://cdn.withterminal.com/providers/geotab/logo.png',
    icon: 'https://cdn.withterminal.com/providers/geotab/icon.png',
    passthrough: { supported: true },
    supportedModels: {
      Vehicle: read('supported'),
      VehicleLocation: {
        sampleRate: 'Variable',
        availableHistory: 'Users can set a data retention limit: Unlimited',
        ...read('supported'),
      },
      VehicleStatLog: {
        ...read('supported'),
        types: ['engine_state', 'odometer', 'fuel_level', 'engine_runtime', 'engine_rpm'],
      },
      LatestVehicleLocation: read('supported'),
      FaultCodeEvent: read('supported'),
    },
  },
  {
    name: 'PeopleNet',
    status: 'live',
    code: 'people-net',
    logo: 'https://cdn.withterminal.com/providers/people-net/logo.png',
    icon: 'https://cdn.withterminal.com/providers/people-net/icon.png',
    passthrough: { supported: true },
    supportedModels: {
      Vehicle: read('supported'),
      VehicleLocation: {
        sampleRate: 'Between 600 seconds and 1800 seconds',
        availableHistory: '90 days',
        ...read('supported'),
      },
      VehicleStatLog: {
        ...read('supported'),
        types: [
          'engine_state',
          'fuel_level',
          'odometer',
          'total_fuel_consumption',
          'engine_runtime',
        ],
      },
      LatestVehicleLocation: read('supported'),
      FaultCodeEvent: read('supported'),
    },
  },
];

/** The VehicleStatLog types a provider code supports in the catalog ([] when unknown). */
export function simProviderStatTypes(code: string): string[] {
  const p = SIM_TERMINAL_PROVIDERS.find((x) => x.code === code);
  const m = p?.supportedModels?.VehicleStatLog;
  return m?.supportedOperations?.read === 'supported' ? [...(m.types ?? [])] : [];
}

/** The catalog name of a provider code (the code itself when unknown). */
export function simProviderName(code: string): string {
  return SIM_TERMINAL_PROVIDERS.find((x) => x.code === code)?.name ?? code;
}
