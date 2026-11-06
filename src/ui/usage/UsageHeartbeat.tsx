'use client';
/**
 * The board's usage heartbeat (slice 2a, decision 2a-11; docs/contracts-2a.md §7.2): while the
 * page has a session and is visible it posts POST /api/v1/usage { route } every
 * USAGE_HEARTBEAT_MS (5 minutes), so the gate report counts board time per device and the
 * people signed in on it. Renders nothing.
 *
 * FOUNDATION STUB, owned by the rights-usage builder (src/ui/usage/**): does nothing yet. Props
 * frozen (additive changes only).
 */
export interface UsageHeartbeatProps {
  route: '/board' | '/m';
}

export function UsageHeartbeat(_props: UsageHeartbeatProps) {
  return null;
}
