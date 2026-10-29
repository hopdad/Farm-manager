import { describe, expect, test } from 'vitest';
import { userAgentHasContact } from './weather';

describe('weather.nws', () => {
  test('a User-Agent with contact info (NWS asks for a website or an email)', () => {
    expect(userAgentHasContact('farm-manager (derrick@example.com)')).toBe(true);
    expect(userAgentHasContact('(myweatherapp.com, contact@myweatherapp.com)')).toBe(true);
    expect(userAgentHasContact('farm-manager (https://farm.example)')).toBe(true);
    expect(userAgentHasContact('farm-manager (local development)')).toBe(false);
  });
});
