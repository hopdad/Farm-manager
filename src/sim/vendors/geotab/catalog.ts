/**
 * The MyGeotab stand-in's lookup entities (slice 1f.2, the trucks builder): the Diagnostics and
 * FailureModes it answers `Get` with, the groups of its devices, and the FaultData each knob kind
 * raises. Shapes from my.geotab.com/api.json (ObjectModel.Engine.Diagnostic / FailureMode,
 * ObjectModel.Group); system ids (`DiagnosticEngineHoursId`, `SourceJ1939Id`,
 * `ControllerObdPowertrainId`, `NoFailureModeId`, `UnitOfMeasureSecondsId`, …) are Geotab's own
 * KnownIds, the fault diagnostics' ids are opaque (Geotab: "treat ids as opaque"). Shared with
 * the replay fixture builder (src/connectors/geotab/fixtures).
 */
import type { GeotabDiagnostic, GeotabFailureMode } from '../../../connectors/geotab/schemas';
import type { GeotabSimFaultKind } from './control-types';

const ref = (id: string) => ({ id });

/** Diagnostics the stand-in reports StatusData for: ours, and two the client must drop. */
export const GEOTAB_SIM_DIAGNOSTICS: readonly GeotabDiagnostic[] = [
  {
    id: 'DiagnosticEngineHoursId',
    name: 'Engine hours',
    code: 247,
    source: ref('SourceGeotabGoId'),
    unitOfMeasure: ref('UnitOfMeasureSecondsId'),
    diagnosticType: 'GoDiagnostic',
  },
  {
    id: 'DiagnosticOdometerId',
    name: 'Odometer',
    code: 245,
    source: ref('SourceGeotabGoId'),
    unitOfMeasure: ref('UnitOfMeasureMetersId'),
    diagnosticType: 'GoDiagnostic',
  },
  {
    id: 'DiagnosticFuelLevelId',
    name: 'Fuel level (percentage)',
    code: 96,
    source: ref('SourceJ1939Id'),
    unitOfMeasure: ref('UnitOfMeasurePercentageId'),
    diagnosticType: 'SuspectParameter',
  },
  {
    id: 'DiagnosticDieselExhaustFluidId',
    name: 'Diesel exhaust fluid level',
    code: 1761,
    source: ref('SourceJ1939Id'),
    unitOfMeasure: ref('UnitOfMeasurePercentageId'),
    diagnosticType: 'SuspectParameter',
  },
  {
    id: 'DiagnosticIgnitionId',
    name: 'Ignition',
    code: 0,
    source: ref('SourceGeotabGoId'),
    unitOfMeasure: ref('UnitOfMeasureNoneId'),
    diagnosticType: 'GoDiagnostic',
  },
  {
    id: 'DiagnosticEngineSpeedId',
    name: 'Engine speed',
    code: 190,
    source: ref('SourceJ1939Id'),
    unitOfMeasure: ref('UnitOfMeasureRevolutionsPerMinuteId'),
    diagnosticType: 'SuspectParameter',
  },
  {
    id: 'DiagnosticEngineCoolantTemperatureId',
    name: 'Engine coolant temperature',
    code: 110,
    source: ref('SourceJ1939Id'),
    unitOfMeasure: ref('UnitOfMeasureDegreesCelsiusId'),
    diagnosticType: 'SuspectParameter',
  },
  // Fault diagnostics (opaque ids, as Geotab's are).
  {
    id: 'aSimSpn110',
    name: 'Engine coolant temperature',
    code: 110,
    source: ref('SourceJ1939Id'),
    diagnosticType: 'SuspectParameter',
  },
  {
    id: 'aSimObd309',
    name: 'O2 sensor circuit (bank 1 sensor 1)',
    code: 309,
    source: ref('SourceObdId'),
    controller: ref('ControllerObdPowertrainId'),
    diagnosticType: 'ObdFault',
  },
  {
    id: 'aSimProp4711',
    name: 'Aftertreatment derate',
    code: 4711,
    source: ref('SourceProprietaryId'),
    diagnosticType: 'ProprietaryFault',
  },
];

export const GEOTAB_SIM_FAILURE_MODES: readonly GeotabFailureMode[] = [
  {
    id: 'aSimFmi0',
    code: 0,
    name: 'Data valid but above normal operational range - most severe level',
  },
  { id: 'NoFailureModeId', code: 0, name: 'No failure mode' },
];

/** The groups the devices sit in (Geotab's root group and a hauler's own). */
export const GEOTAB_SIM_GROUPS = [
  { id: 'GroupCompanyId', name: 'Company Group' },
  { id: 'b27C1', name: 'Semi' },
] as const;

/** The FaultData fields each knob kind raises (diagnostic, failure mode, lamps, severity). */
export const GEOTAB_SIM_FAULT_PRESETS: Record<
  GeotabSimFaultKind,
  {
    diagnostic: string;
    failureMode: string;
    controller: string;
    sourceAddress: number | null;
    lamps: {
      redStopLamp: boolean;
      amberWarningLamp: boolean;
      protectWarningLamp: boolean;
      malfunctionLamp: boolean;
    };
    faultLampState: string;
    severity: string;
  }
> = {
  j1939: {
    diagnostic: 'aSimSpn110',
    failureMode: 'aSimFmi0',
    controller: 'ControllerJ1939EngineNo1Id',
    sourceAddress: 0,
    lamps: {
      redStopLamp: true,
      amberWarningLamp: false,
      protectWarningLamp: false,
      malfunctionLamp: false,
    },
    faultLampState: 'Stop',
    severity: 'CheckImmediately',
  },
  obd2: {
    diagnostic: 'aSimObd309',
    failureMode: 'NoFailureModeId',
    controller: 'ControllerObdPowertrainId',
    sourceAddress: null,
    lamps: {
      redStopLamp: false,
      amberWarningLamp: false,
      protectWarningLamp: false,
      malfunctionLamp: true,
    },
    faultLampState: 'Malfunction',
    severity: 'CheckAtNextHalt',
  },
  oem: {
    diagnostic: 'aSimProp4711',
    failureMode: 'NoFailureModeId',
    controller: 'ControllerNoneId',
    sourceAddress: null,
    lamps: {
      redStopLamp: false,
      amberWarningLamp: false,
      protectWarningLamp: false,
      malfunctionLamp: false,
    },
    faultLampState: 'None',
    severity: 'MaintenanceOnly',
  },
};
