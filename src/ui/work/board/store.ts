/**
 * Board-wide UI state of the job board that BoardScreen needs (slice 2a; docs/contracts-2a.md
 * §7.2): "one sheet at a time". When a field panel opens, a machine is picked or a pin popup
 * opens, BoardScreen calls `closeWorkBoardOverlays()`, which closes the phone's jobs sheet and
 * the wall's job detail popover. The other way round, WorkBoard calls its `onOpen` prop when it
 * opens one of them, and BoardScreen closes the field panel, the soil sheet (and, on phones, the
 * machine card).
 *
 * Owned by the board builder; the foundation lands this seam so BoardScreen compiles. Keep
 * `useWorkBoardUi`'s `overlayOpen` / `setOverlayOpen` and `closeWorkBoardOverlays` (additive
 * changes only).
 */
import { create } from 'zustand';

export interface WorkBoardUiState {
  /** The phone's jobs sheet or the wall's job detail popover is open. */
  overlayOpen: boolean;
  setOverlayOpen(open: boolean): void;
}

export const useWorkBoardUi = create<WorkBoardUiState>()((set) => ({
  overlayOpen: false,
  setOverlayOpen: (open) => set((s) => (s.overlayOpen === open ? s : { overlayOpen: open })),
}));

export function closeWorkBoardOverlays(): void {
  useWorkBoardUi.getState().setOverlayOpen(false);
}
