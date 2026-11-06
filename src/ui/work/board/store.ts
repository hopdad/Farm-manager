/**
 * Board-wide UI state of the job board that BoardScreen needs (slice 2a; docs/contracts-2a.md
 * §7.2): "one sheet at a time". When a field panel opens, a machine is picked or a pin popup
 * opens, BoardScreen calls `closeWorkBoardOverlays()`, which closes the phone's jobs sheet and
 * the wall's job detail popover. The other way round, WorkBoard calls its `onOpen` prop when it
 * opens one of them, and BoardScreen closes the field panel, the soil sheet (and, on phones, the
 * machine card).
 *
 * `overlayOpen`: the phone's jobs sheet, or the wall's job popover, is open. `detail`: what the
 * popover (wall) or the sheet's detail view (phone) shows: one job (viewing or editing it), or
 * the new-job form; null on the phone is the sheet's lane list. Closing the overlay clears it.
 *
 * Owned by the board builder (the foundation landed the seam so BoardScreen compiles); keep
 * `useWorkBoardUi`'s `overlayOpen` / `setOverlayOpen` and `closeWorkBoardOverlays` (additive
 * changes only).
 */
import { create } from 'zustand';

export type WorkBoardDetail =
  | { kind: 'job'; jobId: string; mode: 'view' | 'edit' }
  | { kind: 'new' }
  | null;

export interface WorkBoardUiState {
  /** The phone's jobs sheet or the wall's job detail popover is open. */
  overlayOpen: boolean;
  setOverlayOpen(open: boolean): void;
  /** What the popover / the sheet's detail view shows (null: nothing / the lane list). */
  detail: WorkBoardDetail;
  /** Show a job or the new-job form (opens the overlay). */
  openDetail(detail: Exclude<WorkBoardDetail, null>): void;
  /** Back from the detail (phone: to the lane list; the sheet stays open). */
  closeDetail(): void;
}

export const useWorkBoardUi = create<WorkBoardUiState>()((set) => ({
  overlayOpen: false,
  detail: null,
  setOverlayOpen: (open) =>
    set((s) => {
      if (open) return s.overlayOpen ? s : { overlayOpen: true };
      return !s.overlayOpen && s.detail === null ? s : { overlayOpen: false, detail: null };
    }),
  openDetail: (detail) => set({ overlayOpen: true, detail }),
  closeDetail: () => set((s) => (s.detail === null ? s : { detail: null })),
}));

export function closeWorkBoardOverlays(): void {
  useWorkBoardUi.getState().setOverlayOpen(false);
}
