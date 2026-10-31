/**
 * The AEMP schemas against bodies from each provider's published spec (./fixtures/spec-examples.ts:
 * ISO's XSDs, Deere's aemp.yaml, Samsara's OpenAPI, Trackunit's schema, CNH's FieldOps schema):
 * XML and JSON parse to the same model, wrapped and unwrapped JSON, lower-case keys, numbers as
 * strings, and a broken machine or section dropped without losing the page.
 */
import { describe, expect, test } from 'vitest';
import {
  CNH_XML,
  DEERE_XML,
  DEERE_YAML_LINKS,
  ISO_FAULTS_XML,
  ISO_XML,
  SAMSARA_JSON,
  TRACKUNIT_JSON,
} from './fixtures/spec-examples';
import {
  AempParseError,
  aempBodyValue,
  aempMachineId,
  connectionsLink,
  nextPageNumber,
  parseCautionPage,
  parseFaultPage,
  parseFleetPage,
  parseLocationsPage,
} from './parse';
import { aempLinks, canonicalKeys } from './schemas';

const xml = (body: string) => aempBodyValue(body, 'application/xml; charset=utf-8', 'auto');
const jsonBody = (v: unknown) => aempBodyValue(JSON.stringify(v), 'application/json', 'auto');

describe('ISO 15143-3 Fleet pages', () => {
  test('ISO XML: every section typed, numbers from text, the next page', () => {
    const page = parseFleetPage(xml(ISO_XML));
    expect(page.version).toBe('1');
    expect(page.snapshotTime).toBe('2026-10-30T14:05:00.000Z');
    expect(nextPageNumber(page.links)).toBe(2);
    expect(page.machines.map((m) => m.id)).toEqual(['KBCZ097C0L1R42001', 'KBT0043']);
    expect(page.machines[0]?.equipment).toMatchObject({
      EquipmentHeader: { OEMName: 'Kubota', SerialNumber: 'KBT0042' },
      Location: {
        datetime: '2026-10-30T14:00:00.000Z',
        Latitude: 41.912345,
        Longitude: -84.0412345,
      },
      CumulativeOperatingHours: { Hour: 1912.4, datetime: '2026-10-30T13:45:00.000Z' },
      FuelRemaining: { Percent: 62.5 },
      DEFRemaining: { Percent: 71 },
      EngineStatus: { Running: false, EngineNumber: 'V3800-1' },
    });
    expect(page.dropped).toEqual([]);
  });

  test('the same machine as XML and as JSON parses to the same model', () => {
    const fromXml = parseFleetPage(xml(ISO_XML)).machines[0];
    const asJson = {
      Fleet: {
        version: 1,
        snapshotTime: '2026-10-30T14:05:00Z',
        Links: [{ rel: 'self', href: 'https://aemp.example.com/Fleet/1' }],
        Equipment: [
          {
            EquipmentHeader: {
              OEMName: 'Kubota',
              Model: 'SVL97-2',
              EquipmentID: 'L1',
              SerialNumber: 'KBT0042',
              PIN: 'KBCZ097C0L1R42001',
            },
            Location: {
              datetime: '2026-10-30T14:00:00Z',
              Latitude: 41.912345,
              Longitude: -84.0412345,
              Altitude: 270,
              AltitudeUnits: 'metre',
            },
            CumulativeOperatingHours: { datetime: '2026-10-30T13:45:00Z', Hour: 1912.4 },
            FuelRemaining: { datetime: '2026-10-30T13:45:00Z', Percent: 62.5 },
            DEFRemaining: { datetime: '2026-10-30T13:45:00Z', Percent: 71 },
            EngineStatus: {
              datetime: '2026-10-30T14:00:00Z',
              EngineNumber: 'V3800-1',
              Running: false,
            },
          },
        ],
      },
    };
    expect(parseFleetPage(jsonBody(asJson)).machines[0]).toEqual(fromXml);
  });

  test("Deere's example: sections without datetime, the connections link, a 3-decimal odometer", () => {
    const page = parseFleetPage(xml(DEERE_XML));
    expect(page.version).toBe('2');
    expect(connectionsLink(page.links)).toMatch(/^https:\/\/connections\.deere\.com\//);
    expect(nextPageNumber(page.links)).toBe(2);
    const m = page.machines[0];
    expect(m?.id).toBe('1DW260EXJEF001076');
    expect(m?.equipment.Location).toEqual({ Latitude: 42.573861, Longitude: -90.709778 });
    expect(m?.equipment.Distance).toMatchObject({
      Odometer: 18871.799,
      OdometerUnits: 'kilometre',
    });
    expect(m?.equipment.CumulativeOperatingHours?.datetime).toBeUndefined();
  });

  test("Deere's YAML rendering of Links (nested Link items)", () => {
    expect(aempLinks(DEERE_YAML_LINKS).map((l) => l.rel)).toEqual(['self', 'last', 'next']);
  });

  test("Samsara's wrapped JSON: a string version, EquipmentID as the id, EngineStatus without EngineNumber", () => {
    const page = parseFleetPage(jsonBody(SAMSARA_JSON), 'EquipmentID');
    expect(page.version).toBe('1');
    expect(page.machines.map((m) => m.id)).toEqual(['494123']);
    expect(page.machines[0]?.equipment.EngineStatus).toEqual({
      Running: true,
      datetime: '2019-06-13T19:08:25.000Z',
    });
    // Without idElement the PIN comes first.
    expect(parseFleetPage(jsonBody(SAMSARA_JSON)).machines[0]?.id).toBe('8V8WD530FLN016251');
  });

  test("Trackunit's bare Fleet with lower-case keys and `defremaining`", () => {
    const page = parseFleetPage(jsonBody(TRACKUNIT_JSON));
    expect(page.version).toBe('1');
    expect(nextPageNumber(page.links)).toBe(3);
    expect(page.machines[0]).toMatchObject({
      id: 'JCB3CX4TJE2731234',
      equipment: {
        Location: { Latitude: 55.67, Longitude: 12.56 },
        CumulativeOperatingHours: { Hour: 3120.5 },
        DEFRemaining: { Percent: 80 },
      },
    });
  });

  test("CNH's lower-case location keys and VIN", () => {
    const page = parseFleetPage(xml(CNH_XML), 'VIN');
    expect(page.version).toBe('iso15143-3');
    expect(page.machines[0]).toMatchObject({
      id: 'YJG23800100',
      equipment: {
        EquipmentHeader: { Model: 'Magnum™ 380 Rowtrac™ AFS Connect' },
        Location: { Latitude: 41.9012, Longitude: -84.0571, Altitude: 5 },
        EngineStatus: { Running: true },
      },
    });
  });

  test('a broken section is dropped from its machine; a machine without an id is dropped', () => {
    const page = parseFleetPage({
      Fleet: {
        Links: [],
        Equipment: [
          {
            EquipmentHeader: { PIN: 'P1' },
            Location: { Latitude: 'north', Longitude: 1 },
            CumulativeOperatingHours: { Hour: '12.5', datetime: '2026-10-30T10:00:00' },
            FuelRemaining: { Percent: 140 },
          },
          { EquipmentHeader: { Model: 'no id' } },
          'garbage',
        ],
      },
    });
    expect(page.machines).toHaveLength(1);
    expect(page.machines[0]?.equipment).toEqual({
      EquipmentHeader: { PIN: 'P1' },
      // A date-time without a zone is read as UTC.
      CumulativeOperatingHours: { Hour: 12.5, datetime: '2026-10-30T10:00:00.000Z' },
    });
    expect(page.dropped.map((d) => [d.what, d.id])).toEqual([
      ['Location', 'P1'],
      ['FuelRemaining', 'P1'],
      ['Equipment[1]', null],
      ['Equipment[2]', null],
    ]);
  });

  test('format: json and xml are forced; auto sniffs a body without a useful Content-Type', () => {
    expect(aempBodyValue(ISO_XML, 'text/plain', 'auto')).toHaveProperty('Fleet');
    expect(aempBodyValue(ISO_XML, null, 'xml')).toHaveProperty('Fleet');
    expect(aempBodyValue(JSON.stringify(SAMSARA_JSON), 'text/html', 'json')).toHaveProperty(
      'Fleet',
    );
    expect(() => aempBodyValue('<oops', 'application/xml', 'auto')).toThrow(AempParseError);
    expect(() => aempBodyValue('{oops', 'application/json', 'auto')).toThrow(AempParseError);
    expect(() => parseFleetPage([1, 2])).toThrow(AempParseError);
  });

  test('canonicalKeys keeps unknown keys and prefers the standard spelling', () => {
    expect(canonicalKeys({ latitude: 1, LATITUDE: 2, Latitude: 3, extra: { pin: 'x' } })).toEqual({
      Latitude: 3,
      extra: { PIN: 'x' },
    });
  });

  test('the machine id: idElement, else PIN, VIN, SerialNumber, EquipmentID', () => {
    expect(aempMachineId({ SerialNumber: 'S', EquipmentID: 'E' })).toBe('S');
    expect(aempMachineId({ SerialNumber: 'S', EquipmentID: 'E' }, 'EquipmentID')).toBe('E');
    expect(aempMachineId({ VIN: ' V ', PIN: '' })).toBe('V');
    expect(aempMachineId({ Model: 'x' })).toBeNull();
    expect(aempMachineId(undefined)).toBeNull();
  });
});

describe('ISO 15143-3 series pages', () => {
  test('FaultCode occurrences (the bad one dropped)', () => {
    const page = parseFaultPage(xml(ISO_FAULTS_XML));
    expect(page.items).toEqual([
      {
        datetime: '2026-10-30T09:12:00.000Z',
        CodeIdentifier: 'SPN 110 FMI 0',
        CodeDescription: 'Engine coolant temperature high',
        CodeSeverity: 'High',
        CodeSource: 'ECU',
      },
      {
        datetime: '2026-10-30T10:30:00.000Z',
        CodeIdentifier: 'E9031',
        CodeDescription: 'Hydraulic filter restriction & bypass',
        CodeSeverity: 'Low',
      },
    ]);
    expect(page.dropped).toHaveLength(1);
    expect(page.links[0]?.rel).toBe('self');
  });

  test('Locations (CNH lower-case keys) and caution codes (CNH CautionDescriptions)', () => {
    const loc = parseLocationsPage(
      xml(`<LocationMessages><Links><rel>next</rel><href>x/Locations/a/b/2</href></Links>
        <Location datetime="2026-10-30T10:00:00Z"><latitude>41.1</latitude><longitude>-84.2</longitude></Location>
        <Location datetime="2026-10-30T10:00:10Z"><latitude>41.2</latitude><longitude>-84.3</longitude></Location>
      </LocationMessages>`),
    );
    expect(loc.items.map((l) => [l.datetime, l.Latitude, l.Longitude])).toEqual([
      ['2026-10-30T10:00:00.000Z', 41.1, -84.2],
      ['2026-10-30T10:00:10.000Z', 41.2, -84.3],
    ]);
    expect(nextPageNumber(loc.links)).toBe(2);
    const caution = parseCautionPage(
      xml(`<CautionMessages><Links><rel>self</rel><href>x</href></Links>
        <CautionDescriptions datetime="2026-10-30T10:00:00Z"><Identifier>1234</Identifier>
          <Description>Low hydraulic oil</Description><Severity>Amber</Severity><Active>true</Active></CautionDescriptions>
      </CautionMessages>`),
    );
    expect(caution.items).toEqual([
      {
        datetime: '2026-10-30T10:00:00.000Z',
        Identifier: '1234',
        Description: 'Low hydraulic oil',
        Severity: 'Amber',
        Active: true,
      },
    ]);
  });
});
