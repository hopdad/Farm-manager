/**
 * What /board and /m mount for Deere flags (slice 1f, docs/contracts-1f.md §1.2, §5.2): the
 * pins element (source data + popup), the tap patterns and the tap handler BoardScreen passes to
 * WarRoomMap (`tapLayers={PIN_TAP_LAYERS}`, `onFeatureTap={drawing ? undefined : openPinFromTap}`).
 */
export { DeerePins, openPinFromTap } from './DeerePins';
export { PIN_TAP_LAYERS } from './model';
