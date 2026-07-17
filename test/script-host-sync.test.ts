import { describe, expect, it } from 'vitest';

import { isSyncHostMethod } from '../src/scripts/script-host-sync.js';

describe('isSyncHostMethod', () => {
  it('treats Collection-like host: methods as sync', () => {
    expect(isSyncHostMethod('host:1', 'first')).toBe(true);
    expect(isSyncHostMethod('host:42', 'get')).toBe(true);
    expect(isSyncHostMethod('host:1', 'has')).toBe(true);
    expect(isSyncHostMethod('host:1', 'filter')).toBe(true);
  });

  it('keeps Discord async APIs async on nested host: proxies', () => {
    expect(isSyncHostMethod('host:1', 'fetch')).toBe(false);
    expect(isSyncHostMethod('host:1', 'send')).toBe(false);
    expect(isSyncHostMethod('host:1', 'reply')).toBe(false);
    expect(isSyncHostMethod('host:1', 'edit')).toBe(false);
    expect(isSyncHostMethod('host:1', 'delete')).toBe(false);
  });

  it('keeps channel Discord methods async', () => {
    expect(isSyncHostMethod('channel', 'awaitMessages')).toBe(false);
    expect(isSyncHostMethod('message', 'awaitMessageComponent')).toBe(false);
  });
});
