/** The PC's shop-network addresses for enrollment links opened on iPads. */
import type { networkInterfaces } from 'node:os';
import { describe, expect, test } from 'vitest';
import { isLoopbackHost, privateAddresses } from './lan';

type Ifaces = ReturnType<typeof networkInterfaces>;
const v4 = (address: string, internal = false) =>
  ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '', cidr: null }) as const;

describe('lan', () => {
  test('private IPv4 addresses only, once each', () => {
    const ifaces = {
      lo: [v4('127.0.0.1', true)],
      'Wi-Fi': [v4('192.168.1.50'), { ...v4('fe80::1'), family: 'IPv6' as const }],
      'vEthernet (WSL)': [v4('172.20.16.1')],
      docker: [v4('172.32.0.1')],
      vpn: [v4('10.8.0.2'), v4('10.8.0.2')],
      public: [v4('203.0.113.9')],
    } as unknown as Ifaces;
    expect(privateAddresses(ifaces)).toEqual(['192.168.1.50', '172.20.16.1', '10.8.0.2']);
  });

  test('loopback hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', 'LOCALHOST']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ['192.168.1.50', 'farm-pc.local', '10.0.0.1'])
      expect(isLoopbackHost(h)).toBe(false);
  });
});
