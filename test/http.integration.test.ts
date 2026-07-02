import { describe, expect, it } from 'vitest';

import { requiresAuthentication } from '../src/http/auth.js';

describe('auth', () => {
  it('allows public health without token on loopback', () => {
    expect(requiresAuthentication('/health', 'GET', 'secret', '127.0.0.1')).toBe(false);
    expect(requiresAuthentication('/bots', 'GET', 'secret', '127.0.0.1')).toBe(true);
  });

  it('allows inbound webhooks without bearer token', () => {
    expect(
      requiresAuthentication('/bots/1/inbound/hook', 'POST', 'secret', '0.0.0.0'),
    ).toBe(false);
  });
});
