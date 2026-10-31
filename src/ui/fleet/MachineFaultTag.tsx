'use client';
/**
 * The fault tag on the phone's machine card (slice 1f, fleet-faults; docs/contracts-1f.md §1.2:
 * BoardScreen mounts it with one element, no layout or style change there): the tapped machine's
 * worst active code ("Critical: J1939 SPN 110 FMI 0 +1", every code in the title), "Faults not
 * reported" when its route reports none, else nothing.
 *
 * It reads the fleet panel's data through the shared feed (./useFleetPanel.ts), so it adds no
 * fetch and no subscription of its own; it follows `fleet`/`invalidate` (reason `faults`) with
 * the panel.
 */
import css from './fleet-panel.module.css';
import { faultBadgeText, faultListText } from './format';
import { worstFault } from './model';
import { useFleetPanel, useNow } from './useFleetPanel';

export function MachineFaultTag({ machineId }: { machineId: string }) {
  const { state } = useFleetPanel();
  const now = useNow(30_000);
  const m = state.machines.find((x) => x.id === machineId);
  if (!m) return null;
  const worst = worstFault(m);
  if (!worst) {
    return m.faultsNotReported ? (
      <div className={css.faultTag} data-severity="none" data-testid="machine-fault-tag">
        Faults not reported
      </div>
    ) : null;
  }
  return (
    <div
      className={css.faultTag}
      data-severity={worst.severity}
      title={faultListText(m.faults ?? [], now)}
      data-testid="machine-fault-tag"
    >
      {faultBadgeText(m.faults ?? [])}
    </div>
  );
}

export default MachineFaultTag;
