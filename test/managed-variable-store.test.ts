import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManagedVariableStore } from '../src/runtime/managed-variable-store.js';

describe('ManagedVariableStore', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = handler(url, init);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  }

  it('uses global/get, scoped/list, delete-by-key, and all/delete', async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    mockFetch((url, init) => {
      calls.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes('/global/get')) {
        return { key: 'welcome', value: 'hi' };
      }
      if (url.includes('/scoped/list')) {
        return [{ key: 'coins', value: 42 }];
      }
      if (url.includes('/scoped/delete-by-key') || url.includes('/all/delete')) {
        return { ok: true, deleted: 3 };
      }
      return {};
    });

    const store = new ManagedVariableStore({
      baseUrl: 'https://mgr.example/internal/runners/owner-1',
      token: 'tok',
    });

    expect(await store.getGlobalVariable('bot-1', 'welcome')).toBe('hi');
    expect(await store.getScopedVariables('bot-1', 'user', 'u1')).toEqual({ coins: 42 });
    await store.removeAllScopedValuesForKey('bot-1', 'user', 'coins');
    await store.deleteAllForBot('bot-1');

    expect(calls[0].url).toContain('/global/get?key=welcome');
    expect(calls[1].url).toContain('/scoped/list?');
    expect(calls[1].url).toContain('scope=user');
    expect(calls[2]).toMatchObject({
      method: 'POST',
      body: { scope: 'user', key: 'coins' },
    });
    expect(calls[2].url).toContain('/scoped/delete-by-key');
    expect(calls[3].url).toContain('/all/delete');
  });
});
