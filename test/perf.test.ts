import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Client } from 'discord.js';

import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import { HandlerRegistry } from '../src/discord/handler-registry.js';
import { LogStore } from '../src/runtime/log-store.js';
import { ManagedVariableStore } from '../src/runtime/managed-variable-store.js';
import {
  PerfProbe,
  currentProbe,
  perfDiscordCall,
  perfManagerCall,
  perfPhase,
  perfSettings,
  runWithProbe,
} from '../src/runtime/perf.js';
import type { ScriptExecutor } from '../src/scripts/script-executor.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';

function parse(line: string): Record<string, any> {
  expect(line.startsWith('perf ')).toBe(true);
  return JSON.parse(line.slice('perf '.length));
}

afterEach(() => perfSettings.reset());

describe('PerfProbe', () => {
  it('sans sonde, les aides exécutent simplement la fonction', async () => {
    expect(currentProbe()).toBeUndefined();
    expect(await perfPhase('script', async () => 1)).toBe(1);
    expect(await perfManagerCall('scoped/list', async () => 2)).toBe(2);
    expect(await perfDiscordCall(async () => 3)).toBe(3);
  });

  it('compte phases, appels Manager et Discord de son exécution', async () => {
    const probe = new PerfProbe();
    await runWithProbe(probe, async () => {
      await perfPhase('hydrate', async () => {
        await perfManagerCall('global/list', async () => {});
        await Promise.all([
          perfManagerCall('scoped/list', async () => {}),
          perfManagerCall('scoped/list', async () => {}),
        ]);
      });
      await perfPhase('script', async () => {
        await perfDiscordCall(async () => {});
      });
    });
    const json = parse(probe.line('command', 'ping', true));
    expect(json.aud).toBe('internal');
    expect(json.v).toBe(1);
    expect(json.k).toBe('command');
    expect(json.n).toBe('ping');
    expect(Object.keys(json.ph)).toEqual(['hydrate', 'script']);
    expect(json.mg.n).toBe(3);
    expect(json.mg.by['scoped/list'][0]).toBe(2);
    expect(json.dc.n).toBe(1);
  });

  it('deux exécutions simultanées ne mélangent pas leurs mesures', async () => {
    const a = new PerfProbe();
    const b = new PerfProbe();
    await Promise.all([
      runWithProbe(a, async () => {
        await perfManagerCall('a', async () => {});
        await new Promise((r) => setTimeout(r, 5));
        await perfManagerCall('a', async () => {});
      }),
      runWithProbe(b, async () => {
        await perfManagerCall('b', async () => {});
      }),
    ]);
    expect(a.snapshot().managerCalls).toBe(2);
    expect(b.snapshot().managerCalls).toBe(1);
  });

  it('au-delà de 12 routes distinctes, le reste est regroupé et la ligne ne porte aucun identifiant', async () => {
    const probe = new PerfProbe();
    await runWithProbe(probe, async () => {
      for (let i = 0; i < 20; i += 1) await perfManagerCall(`route${i}`, async () => {});
    });
    const json = parse(probe.line('event', 'messageCreate', false));
    expect(Object.keys(json.mg.by)).toHaveLength(13);
    expect(json.mg.by.other).toBeDefined();
    for (const key of ['u', 'g', 'c']) expect(json[key]).toBeUndefined();
    expect(json.ok).toBe(false);
  });

  it('réglages : éteint par défaut, par bot ou pour tous, seuil sauf échec', () => {
    expect(perfSettings.probeFor(false)).toBeUndefined();
    expect(perfSettings.probeFor(true)).toBeDefined();
    perfSettings.configureFromEnv({ BOT_CREATOR_RUNNER_PERF: '1', BOT_CREATOR_RUNNER_PERF_MIN_MS: '200' });
    expect(perfSettings.probeFor(false)).toBeDefined();
    expect(perfSettings.shouldEmit(50, true)).toBe(false);
    expect(perfSettings.shouldEmit(250, true)).toBe(true);
    expect(perfSettings.shouldEmit(5, false)).toBe(true);
  });
});

describe('ManagedVariableStore mesure ses appels', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('chaque appel au Manager est compté sous un libellé statique', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    const store = new ManagedVariableStore({ baseUrl: 'http://manager', token: 't' });
    const probe = new PerfProbe();
    await runWithProbe(probe, async () => {
      await store.getGlobalVariables('b1');
    });
    const json = parse(probe.line('command', 'x', true));
    expect(json.mg.n).toBeGreaterThanOrEqual(1);
    expect(Object.keys(json.mg.by).every((k) => !k.includes('b1'))).toBe(true);
  });
});

describe('LogStore et audience internal', () => {
  it('cache les lignes perf par défaut, les rend à la lecture interne, et retire avant la limite', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-js-perf-'));
    try {
      const store = new LogStore(path.join(dir, 'runner.log'));
      await store.init();
      store.append('info', 'trace {"k":"command"}', 'b1');
      for (let i = 0; i < 30; i += 1) store.append('info', 'perf {"k":"command","ok":true,"ms":1}', 'b1');
      store.append('info', 'Bot connected', 'b1');
      const user = store.tailForBot('b1', 3);
      expect(user).toHaveLength(2);
      expect(user.some((l) => l.includes('perf {'))).toBe(false);
      const internal = store.tailForBot('b1', 100, true);
      expect(internal.filter((l) => l.includes('perf {'))).toHaveLength(30);
      expect(store.tail(100).some((l) => l.includes('perf {'))).toBe(false);
      expect(store.tail(100, true).some((l) => l.includes('perf {'))).toBe(true);
      await store.flush();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('HandlerRegistry écrit une ligne perf par exécution quand l option est active', () => {
  function build(perf: boolean) {
    const client = new EventEmitter();
    const config = parseJsBotConfig({
      perf,
      events: [{ id: 'h', name: 'interactionCreate', script: 'noop' }],
    });
    const logs: string[] = [];
    const executor = {
      execute: async () => {
        await perfManagerCall('scoped/list', async () => {});
      },
    } as unknown as ScriptExecutor;
    const variables = { getGlobalVariables: async () => ({}) } as VariableDatabase;
    const registry = new HandlerRegistry(client as unknown as Client, config, 'bot-1', executor, variables, (_level, message) => {
      logs.push(message);
    });
    registry.mount();
    const interaction = {
      id: 'i-1',
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isContextMenuCommand: () => false,
      isButton: () => true,
      isRepliable: () => false,
    };
    const fire = () => Promise.all(client.listeners('interactionCreate').map((l) => l(interaction)));
    return { logs, fire };
  }

  it('éteinte (défaut) : aucune ligne perf', async () => {
    const { logs, fire } = build(false);
    await fire();
    expect(logs.some((m) => m.startsWith('perf '))).toBe(false);
  });

  it('allumée pour le bot : une ligne perf interne avec phases et appels Manager', async () => {
    const { logs, fire } = build(true);
    await fire();
    const lines = logs.filter((m) => m.startsWith('perf '));
    expect(lines).toHaveLength(1);
    const json = parse(lines[0]);
    expect(json.aud).toBe('internal');
    expect(json.ok).toBe(true);
    expect(json.mg.by['scoped/list'][0]).toBe(1);
    expect(Object.keys(json.ph)).toContain('script');
  });
});
