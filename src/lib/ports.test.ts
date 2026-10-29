import net from 'node:net';
import { describe, expect, test } from 'vitest';
import { bindError, probePort, reservedPortHint } from './ports';

async function listen(host: string): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, host, r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

describe('probePort', () => {
  test('free, then in use while something listens on loopback', async () => {
    const held = await listen('127.0.0.1');
    expect(await probePort(held.port, '0.0.0.0')).toEqual({ state: 'in_use' });
    expect(await probePort(held.port, '127.0.0.1')).toEqual({ state: 'in_use' });
    await held.close();
    expect(await probePort(held.port, '0.0.0.0')).toEqual({ state: 'free' });
  });

  test('a port held on all addresses is in use for loopback too', async () => {
    const held = await listen('0.0.0.0');
    expect((await probePort(held.port, '127.0.0.1')).state).toBe('in_use');
    expect(await bindError(held.port, '0.0.0.0')).toBe('EADDRINUSE');
    await held.close();
  });
});

describe('reservedPortHint', () => {
  test('Windows names the excluded port ranges and the fix', () => {
    const h = reservedPortHint(3000, 'PUBLIC_URL', 'win32');
    expect(h).toContain('port 3000 is reserved by Windows');
    expect(h).toContain('netsh interface ipv4 show excludedportrange protocol=tcp');
    expect(h).toContain('PUBLIC_URL');
    expect(h).toContain('net stop winnat; net start winnat');
  });
  test('elsewhere: a privileged port', () => {
    expect(reservedPortHint(80, 'PUBLIC_URL', 'linux')).toMatch(/elevated rights/);
  });
});
