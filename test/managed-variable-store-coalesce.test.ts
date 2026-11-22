import { afterEach, describe, expect, it, vi } from 'bun:test';

import { ManagedVariableStore } from '../src/runtime/managed-variable-store.js';

describe('ManagedVariableStore: écritures fusionnées et lectures récentes', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function setup() {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/global/get')) return new Response(JSON.stringify({ value: 'v' }), { status: 200 });
      if (url.includes('/global/list')) return new Response(JSON.stringify([{ key: 'k', value: 'last' }]), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const store = new ManagedVariableStore({
      baseUrl: 'https://mgr.example/internal/runners/o',
      token: 't',
      resilience: { writeCoalesceMs: 50, readCacheMs: 200 },
    });
    return { calls, store };
  }

  it('envoie la première écriture tout de suite et fusionne les suivantes (la dernière gagne)', async () => {
    const { calls, store } = setup();
    for (let i = 1; i <= 5; i++) await store.setGlobalVariable('b', 'k', i);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ key: 'k', value: 1 });
    await new Promise((r) => setTimeout(r, 120));
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toMatchObject({ key: 'k', value: 5 });
    store.dispose();
  });

  it("relit sa propre écriture en attente sans appel, et envoie avant une liste", async () => {
    const { calls, store } = setup();
    await store.setGlobalVariable('b', 'k', 1);
    await store.setGlobalVariable('b', 'k', 2);
    expect(await store.getGlobalVariable('b', 'k')).toBe(2);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0);
    await store.getGlobalVariables('b');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.at(-1)?.body).toMatchObject({ key: 'k', value: 2 });
    store.dispose();
  });

  it('sert une lecture récente sans rappeler le Manager, jusqu à une écriture de la même clé', async () => {
    const { calls, store } = setup();
    expect(await store.getGlobalVariable('b', 'x')).toBe('v');
    expect(await store.getGlobalVariable('b', 'x')).toBe('v');
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    await store.setGlobalVariable('b', 'x', 'w');
    await store.getGlobalVariable('b', 'x');
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 250));
    await store.getGlobalVariable('b', 'x');
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3);
    store.dispose();
  });
});
