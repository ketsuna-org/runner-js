import { afterEach, describe, expect, it, vi } from 'bun:test';

import { InfrastructureError, isInfrastructureError } from '../src/runtime/infrastructure-error.js';
import { ManagedVariableStore } from '../src/runtime/managed-variable-store.js';

describe('ManagedVariableStore pendant une panne du Manager', () => {
  const originalFetch = globalThis.fetch;
  let status = 200;
  let down = false; // connexion refusée
  let hits = 0;
  const globals: Record<string, unknown> = { coins: 5 };
  const writes: string[] = [];

  const FAST = {
    maxRetries: 1,
    retryBaseDelayMs: 5,
    requestTimeoutMs: 2000,
    breakerThreshold: 2,
    breakerCooldownMs: 300,
    drainBaseDelayMs: 50,
    maxDrainDelayMs: 100,
  };

  function install() {
    status = 200;
    down = false;
    hits = 0;
    writes.length = 0;
    globals.coins = 5;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      hits++;
      if (down) throw new TypeError('connect ECONNREFUSED manager.bcm-staging.svc.cluster.local');
      if (status !== 200) return new Response('upstream error', { status });
      const url = String(input);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        writes.push(`${new URL(url).pathname} ${init.body}`);
        if (url.includes('/global/set')) globals[body.key] = body.value;
        return new Response('{}', { status: 200 });
      }
      if (url.includes('/global/get')) {
        return new Response(JSON.stringify({ value: globals[new URL(url).searchParams.get('key')!] }));
      }
      return new Response('[]');
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const make = () =>
    new ManagedVariableStore({
      baseUrl: 'https://mgr.example',
      token: 't',
      resilience: FAST,
      log: () => {},
    });

  it('sert la dernière valeur connue quand le Manager répond 502', async () => {
    install();
    const store = make();
    expect(await store.getGlobalVariable('b', 'coins')).toBe(5);
    status = 502;
    expect(await store.getGlobalVariable('b', 'coins')).toBe(5);
    store.dispose();
  });

  it("lecture sans cache : InfrastructureError au message sûr", async () => {
    install();
    status = 502;
    const store = make();
    let caught: unknown;
    try {
      await store.getGlobalVariable('b', 'jamais-vu');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InfrastructureError);
    const message = (caught as Error).message;
    expect(message).not.toContain('502');
    expect(message).not.toContain('mgr.example');
    expect(isInfrastructureError(caught)).toBe(true);
    store.dispose();
  });

  it("le disjoncteur s'ouvre et n'appelle plus le Manager", async () => {
    install();
    status = 502;
    const store = make();
    for (let i = 0; i < 2; i++) await store.getGlobalVariable('b', 'x').catch(() => null);
    expect(store.breakerOpen).toBe(true);
    const before = hits;
    await store.getGlobalVariable('b', 'x').catch(() => null);
    expect(hits).toBe(before);
    store.dispose();
  });

  it("met les écritures en file, les lit en attendant, les rejoue dans l'ordre", async () => {
    install();
    const store = make();
    expect(await store.getGlobalVariable('b', 'coins')).toBe(5);
    status = 503;
    await store.setGlobalVariable('b', 'coins', 6);
    await store.setGlobalVariable('b', 'coins', 7);
    expect(store.pendingWrites).toBe(2);
    expect(await store.getGlobalVariable('b', 'coins')).toBe(7);

    status = 200;
    for (let i = 0; i < 40 && store.pendingWrites > 0; i++) await Bun.sleep(50);
    expect(store.pendingWrites).toBe(0);
    expect(globals.coins).toBe(7);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain('6');
    store.dispose();
  });

  it('connexion refusée : cache puis file', async () => {
    install();
    const store = make();
    expect(await store.getGlobalVariable('b', 'coins')).toBe(5);
    down = true;
    expect(await store.getGlobalVariable('b', 'coins')).toBe(5);
    await store.setGlobalVariable('b', 'coins', 9);
    expect(store.pendingWrites).toBe(1);
    expect(await store.getGlobalVariable('b', 'coins')).toBe(9);
    store.dispose();
  });

  it('une vraie erreur 4xx reste une erreur d\'API', async () => {
    install();
    status = 400;
    const store = make();
    await expect(store.setGlobalVariable('b', 'k', 'v')).rejects.toThrow('API error');
    store.dispose();
  });
});
