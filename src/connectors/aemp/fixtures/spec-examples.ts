/**
 * ISO 15143-3 bodies as each provider's published spec shows them (test data for the parser,
 * the mapper and the client; no real farm data). Sources, read Oct 30, 2026 (vendor-docs aemp.md):
 *
 *  ISO_XML       ISO's edition-1 XSDs (standards.iso.org/iso/15143/-3/ed-1/en/common.xsd): Fleet
 *                with `version` / `snapshotTime` attributes, repeated `Links`, `Equipment` with
 *                EquipmentHeader and dated sections; numbers as element text.
 *  DEERE_XML     developer.deere.com/dev-docs/aemp's example (the `connections` case, its own
 *                doc-error hrefs) with the data of aemp.yaml (`Kilograms`, a 3-decimal odometer,
 *                sections WITHOUT datetime: dated by snapshotTime).
 *  SAMSARA_JSON  Samsara's getAempEquipmentList field examples: `{"Fleet": …}`, `version` "1",
 *                EquipmentID, EngineStatus without EngineNumber, an href without /beta.
 *  TRACKUNIT_JSON  Trackunit's aemp-iso-api.json schema (no examples): a bare Fleet, the JSON key
 *                `defremaining`, an integer version.
 *  CNH_XML       CNH FieldOps' Fleet schema: version "iso15143-3", lower-case location keys, VIN.
 *  ISO_FAULTS_XML  FaultCode.xsd: DiagnosticTroubleCode { Links, FaultCode[] @datetime }.
 */

export const ISO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!-- trimmed from ISO/TS 15143-3 ed. 1, common.xsd -->
<Fleet xmlns="http://standards.iso.org/iso/15143/-3" version="1" snapshotTime="2026-10-30T14:05:00Z">
  <Links><rel>self</rel><href>https://aemp.example.com/Fleet/1</href></Links>
  <Links><rel>next</rel><href>https://aemp.example.com/Fleet/2</href></Links>
  <Equipment>
    <EquipmentHeader>
      <OEMName>Kubota</OEMName>
      <Model>SVL97-2</Model>
      <EquipmentID>L1</EquipmentID>
      <SerialNumber>KBT0042</SerialNumber>
      <PIN>KBCZ097C0L1R42001</PIN>
    </EquipmentHeader>
    <Location datetime="2026-10-30T14:00:00Z">
      <Latitude>41.912345</Latitude>
      <Longitude>-84.0412345</Longitude>
      <Altitude>270</Altitude>
      <AltitudeUnits>metre</AltitudeUnits>
    </Location>
    <CumulativeOperatingHours datetime="2026-10-30T13:45:00Z"><Hour>1912.4</Hour></CumulativeOperatingHours>
    <FuelRemaining datetime="2026-10-30T13:45:00Z"><Percent>62.5</Percent></FuelRemaining>
    <DEFRemaining datetime="2026-10-30T13:45:00Z"><Percent>71</Percent></DEFRemaining>
    <EngineStatus datetime="2026-10-30T14:00:00Z"><EngineNumber>V3800-1</EngineNumber><Running>false</Running></EngineStatus>
  </Equipment>
  <Equipment>
    <EquipmentHeader><OEMName>Kubota</OEMName><Model>KX040-4</Model><SerialNumber>KBT0043</SerialNumber></EquipmentHeader>
    <CumulativeOperatingHours datetime="2026-10-30T13:45:00Z"><Hour>812</Hour></CumulativeOperatingHours>
  </Equipment>
</Fleet>
`;

export const DEERE_XML = `<Fleet xmlns="http://standards.iso.org/iso/15143/-3" version="2" snapshotTime="2017-03-24T13:02:38.191Z">
  <Links><rel>self</rel><href>https://sandboxapi.deere.com/aemp/Fleet/1</href></Links>
  <Links><rel>next</rel><href>https://sandboxapi.com/aemp/Fleet/2</href></Links>
  <Links><rel>connections</rel><href>https://connections.deere.com/connections/deere-sld8shg8ee0o8ns8nhdh88hn/select-organizations</href></Links>
  <Equipment>
    <EquipmentHeader>
      <OEMName>JOHN DEERE</OEMName>
      <Model>260E</Model>
      <EquipmentID>1DW260EXJEF001076</EquipmentID>
      <SerialNumber>1DW260EXJEF001076</SerialNumber>
      <PIN>1DW260EXJEF001076</PIN>
    </EquipmentHeader>
    <Location><Latitude>42.573861</Latitude><Longitude>-90.709778</Longitude></Location>
    <CumulativeIdleHours><Hour>180.6</Hour></CumulativeIdleHours>
    <CumulativeLoadCount><Count>496</Count></CumulativeLoadCount>
    <CumulativeOperatingHours><Hour>428.7</Hour></CumulativeOperatingHours>
    <CumulativePayloadTotals><PayloadUnits>Kilograms</PayloadUnits><Payload>499900</Payload></CumulativePayloadTotals>
    <Distance><OdometerUnits>kilometre</OdometerUnits><Odometer>18871.799</Odometer></Distance>
    <DEFRemaining><Percent>34.4</Percent></DEFRemaining>
    <FuelRemaining><Percent>48.8</Percent></FuelRemaining>
    <FuelUsed><FuelUnits>litre</FuelUnits><FuelConsumed>63119</FuelConsumed></FuelUsed>
  </Equipment>
</Fleet>`;

/** Deere's aemp.yaml renders Links as `Links: [{ Link: [{ rel, href }] }]`. */
export const DEERE_YAML_LINKS = [
  { Link: [{ rel: 'self', href: 'https://sandboxapi.deere.com/aemp/Fleet/1' }] },
  { Link: [{ rel: 'last', href: 'https://sandboxapi.deere.com/aemp/Fleet/4' }] },
  { Link: [{ rel: 'next', href: 'https://sandboxapi.com/aemp/Fleet/2' }] },
];

export const SAMSARA_JSON = {
  Fleet: {
    version: '1',
    snapshotTime: '2019-06-13T19:08:25Z',
    Links: [{ rel: 'self', href: 'https://api.samsara.com/aemp/Fleet/1' }],
    Equipment: [
      {
        EquipmentHeader: {
          EquipmentID: '494123',
          OEMName: 'Bobcat',
          Model: 'S630 T4',
          PIN: '8V8WD530FLN016251',
          SerialNumber: '8V8WD530FLN016251',
          UnitInstallDateTime: '2019-06-13T19:08:25Z',
        },
        Location: { Latitude: 12.34, Longitude: 12.34, datetime: '2019-06-13T19:08:25Z' },
        CumulativeOperatingHours: { Hour: 12.34, datetime: '2019-06-13T19:08:25Z' },
        Distance: { Odometer: 12, OdometerUnits: 'kilometre', datetime: '2019-06-13T19:08:25Z' },
        FuelRemaining: { Percent: 12, datetime: '2019-06-13T19:08:25Z' },
        DEFRemaining: { Percent: 12, datetime: '2019-06-13T19:08:25Z' },
        EngineStatus: { Running: true, datetime: '2019-06-13T19:08:25Z' },
      },
    ],
  },
};

export const TRACKUNIT_JSON = {
  links: [
    { rel: 'self', href: 'https://iris.trackunit.com/public/api/aemp/v2/15143/-3/Fleet/2' },
    { rel: 'next', href: 'https://iris.trackunit.com/public/api/aemp/v2/15143/-3/Fleet/3' },
    { rel: 'last', href: 'https://iris.trackunit.com/public/api/aemp/v2/15143/-3/Fleet/993' },
  ],
  equipment: [
    {
      equipmentHeader: {
        oemName: 'JCB',
        model: '3CX',
        serialNumber: '927096',
        pin: 'JCB3CX4TJE2731234',
      },
      location: { latitude: '55.67', longitude: '12.56', datetime: '2026-10-30T13:59:00Z' },
      cumulativeOperatingHours: { hour: '3120.5', datetime: '2026-10-30T13:59:00Z' },
      defremaining: { percent: 80, datetime: '2026-10-30T13:59:00Z' },
    },
  ],
  version: 1,
  snapshotTime: '2026-10-30T14:00:00Z',
};

export const CNH_XML = `<?xml version="1.0" encoding="utf-8"?>
<Fleet xmlns="http://standards.iso.org/iso/15143/-3" version="iso15143-3" snapshotTime="2026-10-30T14:00:00Z">
  <Links><rel>self</rel><href>https://api-data.cnh.com/v1/Fleet/1</href></Links>
  <Equipment>
    <EquipmentHeader>
      <OEMName>CASE IH</OEMName><Model>Magnum&#8482; 380 Rowtrac&#8482; AFS Connect</Model>
      <EquipmentID>T1</EquipmentID><SerialNumber>356938035643809</SerialNumber><VIN>YJG23800100</VIN>
    </EquipmentHeader>
    <Location datetime="2026-10-30T13:40:00Z"><latitude>41.9012</latitude><longitude>-84.0571</longitude><altitude>5</altitude><altitudeUnits>metre</altitudeUnits></Location>
    <CumulativeOperatingHours datetime="2026-10-30T13:40:00Z"><Hour>405.3</Hour></CumulativeOperatingHours>
    <Distance datetime="2026-10-30T13:40:00Z"><Odometer>65000.1</Odometer><OdometerUnits>kilometre</OdometerUnits></Distance>
    <FuelRemaining datetime="2026-10-30T13:40:00Z"><Percent>56.3</Percent></FuelRemaining>
    <DEFRemaining datetime="2026-10-30T13:40:00Z"><Percent>56.3</Percent></DEFRemaining>
    <EngineStatus datetime="2026-10-30T13:40:00Z"><EngineNumber>FPT-N67</EngineNumber><Running>true</Running></EngineStatus>
  </Equipment>
</Fleet>`;

export const ISO_FAULTS_XML = `<DiagnosticTroubleCode xmlns="http://standards.iso.org/iso/15143/-3">
  <Links><rel>self</rel><href>https://aemp.example.com/Fleet/Equipment/ID/KBT0042/Faults/2026-10-30T00:00:00Z/2026-10-30T14:00:00Z/1</href></Links>
  <FaultCode datetime="2026-10-30T09:12:00Z">
    <CodeIdentifier>SPN 110 FMI 0</CodeIdentifier>
    <CodeDescription>Engine coolant temperature high</CodeDescription>
    <CodeSeverity>High</CodeSeverity>
    <CodeSource>ECU</CodeSource>
  </FaultCode>
  <FaultCode datetime="2026-10-30T10:30:00Z">
    <CodeIdentifier>E9031</CodeIdentifier>
    <CodeDescription>Hydraulic filter restriction &amp; bypass</CodeDescription>
    <CodeSeverity>Low</CodeSeverity>
  </FaultCode>
  <FaultCode datetime="not a time"><CodeIdentifier>X</CodeIdentifier></FaultCode>
</DiagnosticTroubleCode>`;
