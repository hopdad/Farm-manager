/**
 * One label per group of machines that sit together on screen (pure; unit-tested). When a
 * combine, its grain cart and a semi work the same field, their rings overlap and three unit
 * labels printed on top of each other read as "GCC22". Machines whose screen positions are
 * within `radiusPx` of each other (transitively) share one label, "C1 · GC1 · S4", placed under
 * the most important of them: the selected machine, else a combine, a grain cart, then the rest.
 * Labels re-group when the zoom changes (the caller rebuilds on zoom).
 */
import type { MachineKind } from '../../../domain/fleet';
import type { FleetFrame } from './model';
import { markerLook } from './style';

export interface LabelGroup {
  /** The machine the label sits under. */
  anchor: FleetFrame;
  /** Members, most important first (the anchor first). */
  members: FleetFrame[];
  text: string;
  /** Every member is stale (the label takes the stale colour). */
  allStale: boolean;
}

const KIND_RANK: Partial<Record<MachineKind, number>> = { combine: 3, grain_cart: 2 };

function rank(f: FleetFrame, selectedId: string | null): number {
  if (f.id === selectedId) return 1000;
  return KIND_RANK[f.kind] ?? 1;
}

const byUnit = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function groupLabels(
  frames: readonly FleetFrame[],
  project: (lng: number, lat: number) => { x: number; y: number },
  radiusPx: number,
  selectedId: string | null,
): LabelGroup[] {
  const pts = frames.map((f) => project(f.lng, f.lat));
  // Union-find over pairs closer than radiusPx (~50 machines: the n² scan is cheap).
  const parent = frames.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    let j = i;
    while (parent[j] !== r) {
      const next = parent[j] as number;
      parent[j] = r;
      j = next;
    }
    return r;
  };
  const r2 = radiusPx * radiusPx;
  for (let i = 0; i < frames.length; i++) {
    const a = pts[i] as { x: number; y: number };
    for (let j = i + 1; j < frames.length; j++) {
      const b = pts[j] as { x: number; y: number };
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (dx * dx + dy * dy <= r2) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, FleetFrame[]>();
  frames.forEach((f, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(f);
    else groups.set(root, [f]);
  });
  const out: LabelGroup[] = [];
  for (const members of groups.values()) {
    members.sort(
      (a, b) => rank(b, selectedId) - rank(a, selectedId) || byUnit.compare(a.unitNo, b.unitNo),
    );
    const anchor = members[0] as FleetFrame;
    out.push({
      anchor,
      members,
      text: members.map((m) => markerLook(m).label).join(' · '),
      allStale: members.every((m) => m.stale),
    });
  }
  return out;
}
