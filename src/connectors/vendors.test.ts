/**
 * The vendor registry (1f.2): every connection has its entry and mode key, labels fall back to
 * the raw id, capabilities merge a provider's or route's own with its connection's, and "not
 * reported" follows the capability matrix.
 */
import { describe, expect, test } from 'vitest';
import { parseConfig } from '../config';
import { CONNECTOR_SOURCES, VEHICLE_STAT_FIELDS } from './types';
import {
  CONNECTION_MODE_KEYS,
  CONNECTIONS,
  capabilitiesFor,
  capabilityMatrix,
  connectionMode,
  connectionModes,
  connectionOf,
  connectionOfSource,
  faultsNotReported,
  statsNotReported,
  VENDORS,
  vendorEntry,
  vendorLabel,
} from './vendors';

const cfg = parseConfig({
  DATABASE_URL: 'postgres://farm_app:pw@127.0.0.1:15432/postgres',
  JOBS_SECRET: 'a'.repeat(64),
  SESSION_SECRET: 'a'.repeat(64),
  CONNECTOR_DEERE: 'replay',
  CONNECTOR_GEOTAB: 'off',
});

describe('vendor registry', () => {
  test('ids are unique, of the position-vendor format, and every connection is a source', () => {
    const ids = VENDORS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]{1,30}$/);
    for (const c of CONNECTIONS) {
      expect(CONNECTOR_SOURCES).toContain(c);
      expect(vendorEntry(c)?.role).toBe('connection');
      expect(CONNECTION_MODE_KEYS[c]).toBe(`CONNECTOR_${c.toUpperCase()}`);
    }
    // Every entry is one of the three kinds the brief names.
    expect([...new Set(VENDORS.map((v) => v.kind))].sort()).toEqual(['machine', 'pickup', 'truck']);
  });

  test('labels: the registry, then aggregator providers by pattern, then the raw id', () => {
    expect(vendorLabel('samsara')).toBe('Samsara');
    expect(vendorLabel('aemp_kubota')).toBe('Kubota (AEMP)');
    expect(vendorLabel('aemp_john_deere')).toBe('John Deere (AEMP)');
    expect(vendorLabel('terminal_omnitracs')).toBe('Omnitracs (via Terminal)');
    expect(vendorLabel('terminal_omnitracs_xrs')).toBe('Omnitracs XRS (via Terminal)');
    expect(vendorLabel('aemp_deere')).toBe('John Deere (AEMP)');
    expect(vendorLabel('ford_pro')).toBe('Ford Pro');
    expect(vendorLabel('verizon')).toBe('verizon');
    expect(vendorLabel('Not An Id')).toBe('Not An Id');
  });

  test('the connection behind an id', () => {
    expect(connectionOf('aemp_kubota')).toBe('aemp');
    expect(connectionOf('aemp_jcb')).toBe('aemp');
    expect(connectionOf('terminal_omnitracs')).toBe('terminal');
    expect(connectionOf('geotab')).toBe('geotab');
    expect(connectionOf('ford_pro')).toBeNull();
    expect(connectionOf(null)).toBeNull();
    expect(connectionOfSource('nws')).toBeNull();
    expect(connectionOfSource('motive')).toBe('motive');
  });

  test('capabilities: a provider has its own; a route (via) overrides its connection', () => {
    expect(capabilitiesFor('aemp_kubota')?.positions).toEqual({ live: 'no', lastKnown: 'doc' });
    // An AEMP provider the registry doesn't know: the generic AEMP matrix.
    expect(capabilitiesFor('aemp_jcb')).toEqual(capabilitiesFor('aemp'));
    const ford = capabilitiesFor('samsara', 'ford_pro');
    expect(ford?.stats.engineHours).toBe('unknown');
    expect(ford?.stats.fuelPct).toBe('doc');
    expect(ford?.faults.j1939).toBe('no');
    expect(capabilitiesFor('samsara')?.stats.engineHours).toBe('yes');
    expect(capabilitiesFor('verizon')).toBeNull();
  });

  test('"not reported": what the route does not report, never for an unknown vendor', () => {
    expect(statsNotReported('samsara')).toEqual([]);
    expect(statsNotReported('samsara', 'ford_pro')).toEqual([
      'engineHours',
      'odometerMi',
      'defPct',
      'engineOn',
    ]);
    // Stellantis sends no engine hours (no official source lists them; Motive and Geotab say none).
    expect(statsNotReported('samsara', 'stellantis')).toEqual([
      'engineHours',
      'odometerMi',
      'defPct',
      'engineOn',
    ]);
    // An asset gateway: GPS odometer and engine state on Samsara's equipment feed; no DEF there.
    expect(statsNotReported('samsara', 'gateway')).toEqual(['defPct']);
    expect(statsNotReported('deere')).toEqual(['odometerMi', 'defPct']);
    expect(statsNotReported('aemp_kubota')).toEqual(['odometerMi', 'engineOn']);
    expect(statsNotReported('terminal_omnitracs_xrs')).toEqual(['fuelPct', 'defPct']);
    expect(statsNotReported('cnh')).toEqual([]);
    expect(statsNotReported('verizon')).toEqual([]);
  });

  test('"faults not reported": a route with no fault system, never for an unknown vendor', () => {
    expect(faultsNotReported('samsara')).toBe(false);
    expect(faultsNotReported('aemp_samsara')).toBe(true);
    expect(faultsNotReported('aemp_deere')).toBe(true);
    expect(faultsNotReported('samsara', 'smartcar')).toBe(true);
    expect(faultsNotReported('samsara', 'ford_pro')).toBe(false);
    expect(faultsNotReported('verizon')).toBe(false);
  });

  test('the capability matrix: one row per connection with its mode key and mode', () => {
    const rows = capabilityMatrix(cfg);
    expect(rows.map((r) => [r.connection, r.modeKey, r.mode])).toEqual([
      ['deere', 'CONNECTOR_DEERE', 'replay'],
      ['samsara', 'CONNECTOR_SAMSARA', 'sim'],
      ['motive', 'CONNECTOR_MOTIVE', 'sim'],
      ['geotab', 'CONNECTOR_GEOTAB', 'off'],
      ['aemp', 'CONNECTOR_AEMP', 'sim'],
      ['cnh', 'CONNECTOR_CNH', 'sim'],
      ['terminal', 'CONNECTOR_TERMINAL', 'sim'],
    ]);
    expect(rows.find((r) => r.connection === 'aemp')?.providers.map((p) => p.provider)).toEqual([
      'deere',
      'cnh',
      'kubota',
      'samsara',
    ]);
    expect(rows.find((r) => r.connection === 'terminal')?.providers.map((p) => p.provider)).toEqual(
      ['omnitracs-xrs'],
    );
    expect(rows.find((r) => r.connection === 'samsara')?.build).toBe('built');
    // Every connection's client is built since the 1f merge; a provider row can still be planned.
    for (const r of rows) expect(r.build, r.connection).toBe('built');
    expect(
      rows.find((r) => r.connection === 'aemp')?.providers.find((p) => p.provider === 'cnh')?.build,
    ).toBe('planned');
    for (const r of rows) {
      expect(Object.keys(r.capabilities.stats).sort()).toEqual([...VEHICLE_STAT_FIELDS].sort());
    }
    expect(connectionModes(cfg)).toMatchObject({ deere: 'replay', geotab: 'off', samsara: 'sim' });
    expect(connectionMode(cfg, 'geotab')).toBe('off');
  });
});
