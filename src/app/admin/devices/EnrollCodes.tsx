'use client';
/**
 * The one-time code panel of /admin/devices: after "Add device" or "New code" it shows the code
 * (to type), the link and its QR code (to scan with a cab iPad's camera), once; the server keeps
 * only the code's hash. A wall display also gets the PowerShell commands that enroll the kiosk
 * profile on this PC over localhost, then start the kiosk (src/platform/auth/kiosk.ts).
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { NoticeProvider } from '../_components/controls';
import css from '../admin.module.css';
import { detroitTime } from '../format';
import type { DeviceActionResult, EnrollCodeView } from './actions';
import own from './devices.module.css';

/** A PowerShell line to paste, with a Copy button (the clipboard needs localhost or https). */
function Command({ text, testId }: { text: string; testId: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState<'copied' | 'select' | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      // Plain http on a LAN address has no clipboard API: select it for Ctrl+C instead.
      const range = document.createRange();
      if (ref.current) range.selectNodeContents(ref.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      setCopied('select');
    }
  };
  return (
    <div className={own.command}>
      <pre ref={ref} className={`${css.mono} ${own.commandText}`} data-testid={testId}>
        {text}
      </pre>
      <button type="button" className={css.button} onClick={copy}>
        {copied === 'copied' ? 'Copied' : copied === 'select' ? 'Ctrl+C' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * The wall kiosk runs on this PC in its own Chrome profile and opens localhost: the enrollment
 * must happen there (cookies belong to one host and one profile), not in this browser.
 */
function KioskSteps({ kiosk, deviceName }: { kiosk: KioskView; deviceName: string }) {
  return (
    <div className={css.stack} data-testid="enroll-kiosk">
      <h3>On this PC (wall kiosk)</h3>
      <p>
        1. Close the kiosk if it is running (Alt+F4). In PowerShell on this PC, run this once: it
        opens the kiosk&apos;s own Chrome profile on this code.
      </p>
      <Command text={kiosk.enroll} testId="enroll-kiosk-command" />
      <p>
        2. Press <strong>Enroll as {deviceName}</strong>: the board opens. Close that window.
      </p>
      <p>3. From then on, start the wall with:</p>
      <Command text={kiosk.start} testId="enroll-kiosk-start" />
      <p className={css.muted}>
        <span className={css.mono}>--force-device-scale-factor</span>: 2 for a 4K panel, 1 for a
        1080p one. The kiosk&apos;s link is{' '}
        <span className={css.mono} data-testid="enroll-kiosk-link">
          {kiosk.url}
        </span>
        : open it only in the kiosk profile (opening it here would make this browser the wall).
      </p>
    </div>
  );
}

type KioskView = NonNullable<EnrollCodeView['kiosk']>;

function CodePanel({ view }: { view: EnrollCodeView }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);
  return (
    <section ref={ref} className={css.card} data-testid="enroll-code-panel" aria-live="polite">
      <h2>Enroll “{view.deviceName}”</h2>
      {view.kiosk && <KioskSteps kiosk={view.kiosk} deviceName={view.deviceName} />}
      <div className={css.grid}>
        <div className={css.stack}>
          {view.kiosk && <h3>Another screen (its own computer or a tablet)</h3>}
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
            Works once, until {detroitTime(view.expiresAt)}.
            {view.kiosk ? ' Step by step: docs/kiosk.md.' : ''}
          </p>
          {view.localUrl && (
            <div className={css.stack} data-testid="enroll-lan-links">
              <p className={css.muted}>
                The link and QR code use this PC&apos;s shop-network address (an iPad or phone
                can&apos;t open localhost).
                {view.lanUrls.length > 1
                  ? " If the device can't reach it, try another of the PC's addresses (the `pnpm dev` banner says which adapter is the shop network):"
                  : " If the device can't reach it, check it is on the shop Wi-Fi and that the Windows firewall lets it in (README)."}
              </p>
              {view.lanUrls.slice(1).map((u) => (
                <a key={u} className={`${css.mono} ${own.codeLink}`} href={u}>
                  {u}
                </a>
              ))}
              {!view.kiosk && (
                <p className={css.muted}>
                  On this PC:{' '}
                  <a className={css.mono} href={view.localUrl}>
                    {view.localUrl}
                  </a>
                </p>
              )}
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
    <NoticeProvider<DeviceActionResult> onResult={onResult}>
      {header}
      {panel && <CodePanel key={panel.code} view={panel} />}
      {children}
    </NoticeProvider>
  );
}
