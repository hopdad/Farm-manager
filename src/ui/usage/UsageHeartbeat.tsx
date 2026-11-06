'use client';
/**
 * The board's usage heartbeat (slice 2a, decision 2a-11; docs/contracts-2a.md §7.7): while the
 * page is visible it posts POST /api/v1/usage { route } every USAGE_HEARTBEAT_MS (4 minutes,
 * under the 5-minute bucket), so the gate report counts board time per device and the people
 * signed in on it. The server records a beat only for a session with a person (appUserId): an
 * unattended wall (a device session) answers `recorded: false` and logs no board time. Renders
 * nothing.
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
