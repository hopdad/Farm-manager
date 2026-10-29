/**
 * Is a TCP port free to listen on? Checked the way the server will use it: by binding (exclusive)
 * and closing again, after a quick connect probe on loopback.
 *
 * A connect probe alone says "free" for a port held on another address (Next binds 0.0.0.0) and
 * for a port inside a Windows excluded port range (Hyper-V/WSL2/Docker reservations, see
 * `netsh interface ipv4 show excludedportrange protocol=tcp`): both refuse the connection like a
 * free port does, then `listen` fails with EADDRINUSE or EACCES and the launcher dies without a
 * hint. Binding sees both.
 */
import net from 'node:net';

export type PortState = 'free' | 'in_use' | 'reserved' | 'error';

export interface PortProbe {
  state: PortState;
  /** The bind error code for 'reserved' / 'error'. */
  code?: string;
}

function connects(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** The bind error code, or null when host:port could be bound. */
export function bindError(port: number, host: string): Promise<string | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'EUNKNOWN'));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(null)));
  });
}

/**
 * Probe `port` for a server that will listen on `host` ('0.0.0.0' for Next, '127.0.0.1' for the
 * stand-in): 'in_use' (something answers, or the bind says EADDRINUSE), 'reserved' (EACCES: a
 * Windows excluded port range, or a privileged port on POSIX), 'error' (another bind error).
 */
export async function probePort(port: number, host: string, timeoutMs = 1_000): Promise<PortProbe> {
  const loopback = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  if (await connects(port, loopback, timeoutMs)) return { state: 'in_use' };
  const code = await bindError(port, host);
  if (code === null) return { state: 'free' };
  if (code === 'EADDRINUSE') return { state: 'in_use' };
  if (code === 'EACCES') return { state: 'reserved', code };
  return { state: 'error', code };
}

/** What to tell the person when binding `port` failed with EACCES. `setting` names the knob. */
export function reservedPortHint(
  port: number,
  setting: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') {
    return `port ${port} needs elevated rights to listen on; pick another port (${setting})`;
  }
  return (
    `port ${port} is reserved by Windows (an excluded port range, usually Hyper-V/WSL/Docker): ` +
    'see `netsh interface ipv4 show excludedportrange protocol=tcp`; ' +
    `pick another port (${setting}), or in an admin PowerShell: net stop winnat; net start winnat`
  );
}
