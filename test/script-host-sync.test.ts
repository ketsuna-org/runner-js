import { describe, expect, it } from 'vitest';

import { isSyncHostMethod } from '../src/scripts/script-host-sync.js';

describe('isSyncHostMethod', () => {
  it('treats generic host: proxy methods as sync', () => {
    expect(isSyncHostMethod('host:1', 'first')).toBe(true);
    expect(isSyncHostMethod('host:42', 'get')).toBe(true);
  });

  it('keeps channel Discord methods async', () => {
    expect(isSyncHostMethod('channel', 'awaitMessages')).toBe(false);
    expect(isSyncHostMethod('message', 'awaitMessageComponent')).toBe(false);
  });
});
