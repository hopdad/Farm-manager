import { beforeEach, describe, expect, test } from 'vitest';
import { closeWorkBoardOverlays, useWorkBoardUi } from './store';

describe('one sheet at a time (the BoardScreen seam)', () => {
  beforeEach(() => useWorkBoardUi.setState({ overlayOpen: false, detail: null }));

  test('opening a detail opens the overlay; closing the overlay clears the detail', () => {
    useWorkBoardUi.getState().openDetail({ kind: 'job', jobId: 'j1', mode: 'view' });
    expect(useWorkBoardUi.getState()).toMatchObject({ overlayOpen: true, detail: { jobId: 'j1' } });
    closeWorkBoardOverlays();
    expect(useWorkBoardUi.getState()).toMatchObject({ overlayOpen: false, detail: null });
  });

  test('the phone sheet: open with no detail, back from a detail keeps it open', () => {
    useWorkBoardUi.getState().setOverlayOpen(true);
    expect(useWorkBoardUi.getState()).toMatchObject({ overlayOpen: true, detail: null });
    useWorkBoardUi.getState().openDetail({ kind: 'new' });
    useWorkBoardUi.getState().closeDetail();
    expect(useWorkBoardUi.getState()).toMatchObject({ overlayOpen: true, detail: null });
  });

  test('no change, no new state (no re-render)', () => {
    const before = useWorkBoardUi.getState();
    closeWorkBoardOverlays();
    useWorkBoardUi.getState().closeDetail();
    expect(useWorkBoardUi.getState()).toBe(before);
    useWorkBoardUi.getState().setOverlayOpen(true);
    const open = useWorkBoardUi.getState();
    useWorkBoardUi.getState().setOverlayOpen(true);
    expect(useWorkBoardUi.getState()).toBe(open);
  });
});
