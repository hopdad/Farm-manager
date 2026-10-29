/** The PC's shop-network addresses for enrollment links opened on iPads. */
import type { networkInterfaces } from 'node:os';
import { describe, expect, test } from 'vitest';
import { enrollLinks, isLoopbackHost, privateAddresses, rankLanAddresses } from './lan';

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

  test('the shop network first, Docker and WSL adapters last', () => {
    expect(rankLanAddresses(['172.20.16.1', '10.8.0.2', '192.168.1.50'])).toEqual([
      '192.168.1.50',
      '10.8.0.2',
      '172.20.16.1',
    ]);
  });

  test('on the PC (localhost) the QR link is a LAN address, never loopback', () => {
    const path = '/enroll?code=K7QD2M9XPA';
    const onPc = enrollLinks('http://localhost:3000', path, ['172.18.0.1', '192.168.1.50']);
    expect(onPc).toEqual({
      url: 'http://192.168.1.50:3000/enroll?code=K7QD2M9XPA',
      localUrl: 'http://localhost:3000/enroll?code=K7QD2M9XPA',
      lanUrls: [
        'http://192.168.1.50:3000/enroll?code=K7QD2M9XPA',
        'http://172.18.0.1:3000/enroll?code=K7QD2M9XPA',
      ],
      kioskUrl: 'http://localhost:3000/enroll?code=K7QD2M9XPA',
    });
    expect(isLoopbackHost(new URL(onPc.url).hostname)).toBe(false);
    // Already on the LAN address (or no LAN at all): that origin as is.
    expect(enrollLinks('http://192.168.1.50:3000', path, ['192.168.1.50'])).toEqual({
      url: 'http://192.168.1.50:3000/enroll?code=K7QD2M9XPA',
      localUrl: null,
      lanUrls: [],
      kioskUrl: 'http://localhost:3000/enroll?code=K7QD2M9XPA',
    });
    expect(enrollLinks('http://localhost:3000', path, []).url).toBe(
      'http://localhost:3000/enroll?code=K7QD2M9XPA',
    );
  });

  test('the wall kiosk link is localhost on the app port, whatever address the manager used', () => {
    // The kiosk opens http://localhost:<port>/board in its own profile; cookies belong to one
    // host, so an enrollment on the LAN address (or on 127.0.0.1) would leave it on /login.
    const path = '/enroll?code=K7QD2M9XPA';
    for (const origin of [
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      'http://192.168.1.50:3001',
      'http://farm-pc.local:3001',
    ]) {
      expect(enrollLinks(origin, path, ['192.168.1.50']).kioskUrl, origin).toBe(
        'http://localhost:3001/enroll?code=K7QD2M9XPA',
      );
    }
    expect(enrollLinks('http://192.168.1.50', path, []).kioskUrl).toBe(
      'http://localhost/enroll?code=K7QD2M9XPA',
    );
  });
});
