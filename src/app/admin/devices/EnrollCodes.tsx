'use client';
/**
 * The one-time code panel of /admin/devices: after "Add device" or "New code" it shows the code
 * (to type), the link and its QR code (to scan with a cab iPad's camera), once; the server keeps
 * only the code's hash.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import css from '../admin.module.css';
import { detroitTime } from '../format';
import { ResultProvider } from '../people/forms';
import type { DeviceActionResult, EnrollCodeView } from './actions';
import own from './devices.module.css';

function CodePanel({ view }: { view: EnrollCodeView }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);
  return (
    <section ref={ref} className={css.card} data-testid="enroll-code-panel" aria-live="polite">
      <h2>Enroll “{view.deviceName}”</h2>
      <div className={css.grid}>
        <div className={css.stack}>
          <p>On the device, open this link (or scan the QR code):</p>
          <a className={`${css.mono} ${own.codeLink}`} href={view.url} data-testid="enroll-link">
            {view.url}
          </a>
          <p>
            Or open <span className={css.mono}>/enroll</span> on the device and type:
          </p>
          <div className={own.bigCode} data-testid="enroll-code">
            {view.code}
          </div>
          <p className={css.muted}>
            Works once, until {detroitTime(view.expiresAt)}. For the wall, open it in the kiosk
            browser profile (docs/kiosk.md).
          </p>
          {view.lanUrls.length > 0 && (
            <div className={css.stack}>
              <p className={css.muted}>
                This browser uses localhost, which an iPad can&apos;t reach. On the shop Wi-Fi use
                the PC&apos;s address (the `pnpm dev` banner says which adapter is the shop
                network):
              </p>
              {view.lanUrls.map((u) => (
                <span key={u} className={`${css.mono} ${own.codeLink}`}>
                  {u}
                </span>
              ))}
            </div>
          )}
        </div>
        <svg
          viewBox={`0 0 ${view.qr.size} ${view.qr.size}`}
          role="img"
          aria-label={`QR code for ${view.url}`}
          data-testid="enroll-qr"
          shapeRendering="crispEdges"
          className={own.qr}
        >
          <path d={view.qr.path} fill="#000" />
        </svg>
      </div>
    </section>
  );
}

/** Wraps the page: header, then the latest code panel, the forms, and the notice line. */
export function DeviceActions({ header, children }: { header: ReactNode; children: ReactNode }) {
  const [panel, setPanel] = useState<EnrollCodeView | null>(null);
  const onResult = useCallback((r: DeviceActionResult) => {
    if (r.enroll) setPanel(r.enroll);
  }, []);
  return (
    <ResultProvider<DeviceActionResult> onResult={onResult}>
      {header}
      {panel && <CodePanel key={panel.code} view={panel} />}
      {children}
    </ResultProvider>
  );
}
