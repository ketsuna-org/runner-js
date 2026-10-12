import { describe, expect, it } from 'bun:test';

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

  it('only skips the bearer token for a real inbound webhook path', () => {
    const open = (path: string, method = 'POST') =>
      !requiresAuthentication(path, method, 'secret', '0.0.0.0');
    expect(open('/bots/1/inbound/hook')).toBe(true);
    expect(open('/bots/1/inbound/a/b')).toBe(true);
    // the old `includes('/inbound/')` let all of these through without a token
    expect(open('/admin/inbound/x')).toBe(false);
    expect(open('/bots/1/stop/inbound/x')).toBe(false);
    expect(open('/bots/1/inbound/../stop')).toBe(false);
    expect(open('/bots/1/inbound/%2e%2e/stop')).toBe(false);
    expect(open('/bots/1/inbound//x')).toBe(false);
    expect(open('/bots//inbound/x')).toBe(false);
    expect(open('/bots/1/inbound/')).toBe(false);
    expect(open('/bots/1/inbound/hook', 'GET')).toBe(false);
    expect(open('/bots/1/inbound/hook', 'DELETE')).toBe(false);
  });
});
