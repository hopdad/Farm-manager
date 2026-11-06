'use client';
/**
 * The board's one message line: a 409 ("Changed on another screen; try again", test id
 * `job-conflict`, decision 2a-7) or another refusal ("That spot is not on a field", test id
 * `job-notice`). Shown inside the job's detail when that detail is open, else on the band
 * (wall) or the sheet (phone), never in both places. It goes away by itself after a while, or
 * with its ×.
 */
import { useEffect } from 'react';
import { useBoard, useBoardStoreApi } from './context';
import { useWorkBoardUi } from './store';
import css from './work-board.module.css';

const SHOW_MS = { conflict: 8_000, error: 8_000, info: 5_000 } as const;

/**
 * `band`: over the top of the map under the wall's band; `sheet`: in the phone sheet's flow
 * (under the chips); `detail`: inside the open job's detail.
 */
export function NoticeBar(props: { placement: 'band' | 'sheet' | 'detail'; jobId?: string }) {
  const store = useBoardStoreApi();
  const notice = useBoard((s) => s.notice);
  const detailJobId = useWorkBoardUi((s) =>
    s.overlayOpen && s.detail?.kind === 'job' && s.detail.mode === 'view' ? s.detail.jobId : null,
  );

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => store.getState().dismiss(notice.id), SHOW_MS[notice.tone]);
    return () => clearTimeout(t);
  }, [notice, store]);

  if (!notice) return null;
  const inDetail = notice.jobId !== null && notice.jobId === detailJobId;
  if (props.placement === 'detail' ? !inDetail || notice.jobId !== props.jobId : inDetail) {
    return null;
  }
  return (
    <div
      className={`${css.notice} ${props.placement === 'band' ? css.noticeBand : ''} ${
        notice.tone === 'info' ? css.noticeInfo : css.noticeBad
      }`}
      role={notice.tone === 'info' ? 'status' : 'alert'}
      data-testid={notice.tone === 'conflict' ? 'job-conflict' : 'job-notice'}
      data-tone={notice.tone}
    >
      <span>{notice.text}</span>
      <button
        type="button"
        className={css.noticeClose}
        aria-label="Dismiss"
        onClick={() => store.getState().dismiss(notice.id)}
      >
        ×
      </button>
    </div>
  );
}
