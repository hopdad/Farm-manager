'use client';
/**
 * The field's last five seasons (plan 1a "5 seasons"): crop, variety, planted, harvested,
 * yield. A table on the wall; on phones a compact list (year, crop and yield on one line, the
 * rest under it). Read-only: the history tab (field-data builder) adds editing and lineage.
 */
import css from './field-panel.module.css';
import type { SeasonView } from './view-model';

export function SeasonsTable({
  seasons,
  variant,
}: {
  seasons: SeasonView[];
  variant: 'wall' | 'phone';
}) {
  if (seasons.length === 0) {
    return (
      <p className={css.empty} data-testid="field-seasons-empty">
        No seasons recorded yet.
      </p>
    );
  }
  if (variant === 'phone') {
    return (
      <ul className={css.seasonList} data-testid="field-seasons">
        {seasons.map((s) => (
          <li
            key={s.cropYear}
            className={css.seasonItem}
            data-testid="season-row"
            data-year={s.cropYear}
          >
            <span className={css.seasonYear}>{s.cropYear}</span>
            <span>{s.crop}</span>
            <span>{s.yield}</span>
            <span className={css.seasonSub}>
              {s.variety} · planted {s.planted} · harvested {s.harvested}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <table className={css.seasons} data-testid="field-seasons">
      <thead>
        <tr>
          <th scope="col">Year</th>
          <th scope="col">Crop</th>
          <th scope="col">Variety</th>
          <th scope="col">Planted</th>
          <th scope="col">Harvested</th>
          <th scope="col" className={css.num}>
            Yield <abbr title="bushels per acre">bu/ac</abbr>
          </th>
        </tr>
      </thead>
      <tbody>
        {seasons.map((s) => (
          <tr key={s.cropYear} data-testid="season-row" data-year={s.cropYear}>
            <th scope="row" className={css.seasonYear}>
              {s.cropYear}
            </th>
            <td>{s.crop}</td>
            <td className={css.wrap}>{s.variety}</td>
            <td>{s.planted}</td>
            <td>{s.harvested}</td>
            <td className={css.num}>{s.yieldValue}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
