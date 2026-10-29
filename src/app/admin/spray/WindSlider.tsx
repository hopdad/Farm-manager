'use client';
/**
 * The spray demo's wind slider (plan 1b done-when): a range input that shows its value as it
 * moves. Submitted with the simulated-weather form (./actions.ts simWeatherAction).
 */
import { useState } from 'react';
import css from './spray.module.css';

export function WindSlider({ initial, max }: { initial: number; max: number }) {
  const [value, setValue] = useState(initial);
  return (
    <label className={css.slider}>
      <span>
        Sustained wind{' '}
        <output className={css.windValue} data-testid="sim-wind-value">
          {value}
        </output>{' '}
        mph
      </span>
      <input
        type="range"
        name="windMph"
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        aria-label="Simulated wind (mph)"
        data-testid="sim-wind"
      />
    </label>
  );
}
