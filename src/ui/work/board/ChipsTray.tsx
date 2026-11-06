'use client';
/**
 * The chips tray (docs/contracts-2a.md §7.1, test ids §7.5): machine chips (every machine that
 * isn't retired, from the fleet panel's SHARED feed: `useFleetPanel()`, no second fetch) and
 * person chips (crew, GET /api/v1/crew). Chips are DROP TARGETS only (decision 2a-4: you drag a
 * card onto a chip, never a chip). A machine chip shows "down" and the "Deere" badge from the
 * machine alone (decision 2a-13: SP2, a Samsara-gatewayed RoGator, won't take a Work Plan).
 *
 * Two rows, each scrolling sideways on its own; a row is also a droppable so a chip scrolled out
 * of its row never catches a drop (./drop.ts `chipsFirst`). Wall: 72 px chips at the band's
 * right end. Phone: 48 px chips pinned at the top of the jobs sheet, visible at peek.
 */
import { useDroppable } from '@dnd-kit/core';
import type { ReactNode } from 'react';
import { useFleetPanel } from '../../fleet/useFleetPanel';
import { KIND_LABELS } from '../../map/fleet/style';
import type { MapVariant } from '../../map/types';
import { useBoard } from './context';
import { type DropData, machineChipId, personChipId, TRAY_ROW_IDS, type TrayRowId } from './drop';
import { type MachineChip, machineChips, type PersonChip, personChips } from './model';
import css from './work-board.module.css';

function TrayRow(props: {
  id: TrayRowId;
  label: string;
  children: ReactNode;
  empty: string | null;
}) {
  const { setNodeRef } = useDroppable({
    id: props.id,
    data: { kind: 'tray-row' } satisfies DropData,
  });
  return (
    <div className={css.trayRow}>
      <span className={css.trayLabel} aria-hidden="true">
        {props.label}
      </span>
      <ul
        ref={setNodeRef}
        className={css.trayScroll}
        aria-label={props.label}
        data-testid="jobs-chips-row"
        data-row={props.id === TRAY_ROW_IDS.machines ? 'machines' : 'people'}
      >
        {props.children}
        {props.empty && <li className={css.trayEmpty}>{props.empty}</li>}
      </ul>
    </div>
  );
}

function MachineChipView({ chip }: { chip: MachineChip }) {
  const { setNodeRef, isOver } = useDroppable({
    id: machineChipId(chip.id),
    data: { kind: 'machine', machineId: chip.id, row: TRAY_ROW_IDS.machines } satisfies DropData,
  });
  const kind = KIND_LABELS[chip.kind];
  return (
    <li
      ref={setNodeRef}
      className={`${css.chip} ${css.chipMachine} ${isOver ? css.chipOver : ''} ${
        chip.status === 'down' ? css.chipDown : ''
      }`}
      data-testid="chip-machine"
      data-machine-id={chip.id}
      data-unit={chip.unitNo}
      data-status={chip.status}
      data-work-plan={chip.workPlanCapable ? 'true' : 'false'}
      data-over={isOver ? 'true' : 'false'}
      aria-label={`${chip.unitNo} (${kind}${chip.status === 'down' ? ', down' : ''})`}
      title={`${chip.unitNo} · ${kind}${chip.workPlanCapable ? ' · takes a Deere Work Plan' : ''}`}
    >
      <span className={css.chipUnit}>{chip.unitNo}</span>
      <span className={css.chipSub}>
        {chip.status === 'down' ? (
          <span className={css.downTag}>down</span>
        ) : (
          <span className={css.chipKind}>{kind}</span>
        )}
        {chip.workPlanCapable && <span className={css.deere}>Deere</span>}
      </span>
    </li>
  );
}

function PersonChipView({ chip }: { chip: PersonChip }) {
  const { setNodeRef, isOver } = useDroppable({
    id: personChipId(chip.partyId),
    data: { kind: 'person', partyId: chip.partyId, row: TRAY_ROW_IDS.people } satisfies DropData,
  });
  const first = chip.name.split(/\s+/)[0] ?? chip.name;
  return (
    <li
      ref={setNodeRef}
      className={`${css.chip} ${css.chipPerson} ${isOver ? css.chipOver : ''} ${
        chip.inactive ? css.chipInactive : ''
      }`}
      data-testid="chip-person"
      data-party-id={chip.partyId}
      data-over={isOver ? 'true' : 'false'}
      aria-label={chip.name}
      title={chip.inactive ? `${chip.name} (sign-in switched off)` : chip.name}
    >
      <span className={css.initials} aria-hidden="true">
        {chip.initials}
      </span>
      <span className={css.chipName}>{first}</span>
    </li>
  );
}

export function ChipsTray({ variant }: { variant: MapVariant }) {
  const { state: panel } = useFleetPanel();
  const crew = useBoard((s) => s.feed.crew);
  const crewError = useBoard((s) => s.feed.crewError);
  const machines = machineChips(panel.machines);
  const people = personChips(crew ?? []);
  return (
    <div
      className={`${css.tray} ${variant === 'phone' ? css.trayPhone : css.trayWall}`}
      data-testid="jobs-chips-tray"
      data-variant={variant}
    >
      <TrayRow
        id={TRAY_ROW_IDS.machines}
        label="Machines"
        empty={machines.length ? null : panel.loaded ? 'No machines' : 'Loading…'}
      >
        {machines.map((m) => (
          <MachineChipView key={m.id} chip={m} />
        ))}
      </TrayRow>
      <TrayRow
        id={TRAY_ROW_IDS.people}
        label="People"
        empty={
          people.length
            ? null
            : crew
              ? 'No crew yet'
              : crewError
                ? "Couldn't load the crew"
                : 'Loading…'
        }
      >
        {people.map((p) => (
          <PersonChipView key={p.partyId} chip={p} />
        ))}
      </TrayRow>
    </div>
  );
}
