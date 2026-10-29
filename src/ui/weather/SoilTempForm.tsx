'use client';
/**
 * Enter a soil temperature probe reading from a phone (plan 1b: "soil temperature from manual
 * probe readings entered on a phone (shown with their age) until D5"). Posts to
 * POST /api/weather/soil-temp (ROLE_FOR.enterSoilTemp, checked on the server); the strips
 * refetch on the weather/updated event that write publishes.
 */
import { type FormEvent, useState } from 'react';
import type { SoilTempFormData, SoilTempResult } from './contract';
import { fmtAgeMinutes, fmtTemp } from './format';
import { useLiveJson } from './useLiveJson';
import css from './weather.module.css';

const DEPTHS = [2, 4, 6, 8] as const;

export function SoilTempForm({ onDone }: { onDone?(result: SoilTempResult | null): void }) {
  const { data } = useLiveJson<SoilTempFormData>('/api/weather/soil-temp', ['weather'], 300_000);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const temp = Number(String(form.get('tempF') ?? '').replace(',', '.'));
    if (!Number.isFinite(temp)) {
      setMessage({ ok: false, text: 'Enter the temperature in °F' });
      return;
    }
    const fieldId = String(form.get('fieldId') ?? '');
    const note = String(form.get('note') ?? '').trim();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/weather/soil-temp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fieldId: fieldId || null,
          tempF: temp,
          depthIn: Number(form.get('depthIn') ?? 2),
          ...(note ? { note } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | (SoilTempResult & { error?: string })
        | null;
      if (!res.ok || !body) {
        setMessage({ ok: false, text: body?.error ?? `Not saved (HTTP ${res.status})` });
        return;
      }
      setMessage({ ok: true, text: `Saved ${fmtTemp(temp)}` });
      onDone?.(body);
    } catch {
      setMessage({ ok: false, text: 'Not saved: no connection to the farm PC' });
    } finally {
      setBusy(false);
    }
  }

  if (data && !data.canEnter) {
    return (
      <p className={css.muted} data-testid="soil-temp-refused">
        Logging soil temperatures needs a driver, operator or manager sign-in on this phone.
      </p>
    );
  }

  return (
    <form className={css.form} onSubmit={submit} data-testid="soil-temp-form">
      {data?.latest && (
        <p className={css.muted}>
          Last reading {fmtTemp(data.latest.tempF)} at {data.latest.depthIn} in,{' '}
          {fmtAgeMinutes(data.latest.ageMinutes)}
          {data.latest.fieldName ? ` (${data.latest.fieldName})` : ''}
        </p>
      )}
      <label className={css.field}>
        Temperature (°F)
        <input
          name="tempF"
          className={css.input}
          type="number"
          inputMode="decimal"
          step="0.1"
          min={-40}
          max={140}
          required
          data-testid="soil-temp-value"
        />
      </label>
      <label className={css.field}>
        Depth
        <select name="depthIn" className={css.input} defaultValue="2" data-testid="soil-temp-depth">
          {DEPTHS.map((d) => (
            <option key={d} value={d}>
              {d} in
            </option>
          ))}
        </select>
      </label>
      <label className={css.field}>
        Field
        <select name="fieldId" className={css.input} defaultValue="" data-testid="soil-temp-field">
          <option value="">Not one field</option>
          {(data?.fields ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <label className={css.field}>
        Note (optional)
        <input name="note" className={css.input} maxLength={500} />
      </label>
      <button
        type="submit"
        className={`${css.button} ${css.primary}`}
        disabled={busy}
        data-testid="soil-temp-save"
      >
        {busy ? 'Saving…' : 'Save reading'}
      </button>
      {message && (
        <p
          role="status"
          className={message.ok ? css.ok : css.error}
          data-testid="soil-temp-message"
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
