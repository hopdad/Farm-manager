'use client';
/**
 * The job board on /board and /m (slice 2a; docs/contracts-2a.md §7.1): the wall's jobs band
 * (lanes by business line, cards, "New job", the chips tray, the collapse bar) and the phone's
 * "Jobs" pill with its bottom sheet (chips tray pinned on top; it drops to peek when a drag
 * starts). Self-contained: it loads the snapshot (GET /api/v1/jobs), the crew (GET
 * /api/v1/crew) and the machines (`useFleetPanel()`'s shared feed, no second fetch), and follows
 * the `jobs` realtime topic.
 *
 * FOUNDATION STUB, owned by the board builder: nothing on the wall (the band's row is where this
 * element renders: BoardScreen places it between the status strip and the map area) and an inert
 * pill on phones. The wall renders nothing on purpose: a band of the default 208 px moves the
 * map centre 104 px towards the weather strip and lowers the first fit below z10, which three
 * existing wall specs feel (docs/contracts-2a.md §7.1); the board builder lands the band with
 * those specs green. The props are frozen (additive changes only). Test ids: contracts-2a §7.5.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { PublicConfig } from '../../../config';
import type { MapVariant } from '../../map/types';
import css from './work-board.module.css';

export interface WorkBoardProps {
  variant: MapVariant;
  /** The board's map (drop on a field, the hover highlight); null until loaded. */
  map: MapLibreMap | null;
  /** The page's public config (realtime client, app env). */
  config: PublicConfig;
  /** The board opened its sheet (phone) or a job popover (wall): close the other panels. */
  onOpen?(): void;
}

export function WorkBoard({ variant }: WorkBoardProps) {
  if (variant === 'phone') {
    return (
      <button
        type="button"
        className={css.pill}
        data-testid="jobs-pill"
        data-variant="phone"
        aria-disabled="true"
      >
        Jobs
      </button>
    );
  }
  return null;
}
