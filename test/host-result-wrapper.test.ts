import { describe, expect, it } from 'vitest';

import { createHostResultWrapper } from '../src/scripts/script-host-modules.js';
import { HostObjectRegistry, isHostProxyDescriptor } from '../src/scripts/script-host-registry.js';

describe('createHostResultWrapper', () => {
  it('keeps plain objects with methods as host proxies', () => {
    const registry = new HostObjectRegistry();
    const wrap = createHostResultWrapper(registry);
    const candidate = { content: 'hello world' };
    const collection = {
      first: () => candidate,
      size: 1,
    };

    const wrapped = wrap(collection);
    expect(isHostProxyDescriptor(wrapped)).toBe(true);
    if (!isHostProxyDescriptor(wrapped)) {
      return;
    }
    const resolved = registry.resolve(wrapped.id) as typeof collection;
    expect(resolved.first()).toEqual(candidate);
    expect(resolved.size).toBe(1);
  });

  it('still copies plain data objects without methods', () => {
    const registry = new HostObjectRegistry();
    const wrap = createHostResultWrapper(registry);
    const wrapped = wrap({ size: 1, content: 'hello' });
    expect(isHostProxyDescriptor(wrapped)).toBe(false);
    expect(wrapped).toEqual({ size: 1, content: 'hello' });
  });
});
