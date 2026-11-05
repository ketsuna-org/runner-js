import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';

import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import { HandlerRegistry } from '../src/discord/handler-registry.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';
import { ScriptExecutor } from '../src/scripts/script-executor.js';

const executors: ScriptExecutor[] = [];
afterEach(() => {
  for (const executor of executors.splice(0)) executor.dispose();
});

function harness(events: Record<string, unknown>[]) {
  const client = new EventEmitter() as EventEmitter & { user: { id: string }; calls: string[] };
  client.user = { id: '900' };
  client.calls = [];
  const executor = new ScriptExecutor(5000);
  executors.push(executor);
  const registry = new HandlerRegistry(
    client as unknown as Client,
    parseJsBotConfig({ prefix: '!', events }),
    'bot-cmd-events',
    executor,
    { getGlobalVariables: async () => ({}) } as unknown as VariableDatabase,
    () => undefined,
    undefined,
    { messageContentAvailable: true, now: () => 1_000_000 },
  );
  registry.mount();
  return { client, registry };
}

const payload = {
  id: 'c1',
  name: 'salut',
  description: 'Dit bonjour',
  type: 'chatInput',
  previousName: 'hello',
  command: {},
};

describe('événements de commande', () => {
  it('lance seulement les handlers du bon événement, avec la commande dans webhook.payload', async () => {
    const { client, registry } = harness([
      {
        id: 'e1',
        name: 'commandUpdated',
        script: "client.calls.push(webhook.path + ':' + webhook.payload.id + ':' + webhook.payload.previousName);",
      },
      { id: 'e2', name: 'commandCreated', script: "client.calls.push('created');" },
      { id: 'e3', name: 'commandDeleted', enabled: false, script: "client.calls.push('deleted');" },
    ]);
    expect(await registry.triggerCommandEvent('commandUpdated', payload)).toBe(1);
    expect(client.calls).toEqual(['commandUpdated:c1:hello']);
    expect(await registry.triggerCommandEvent('commandDeleted', payload)).toBe(0);
  });
});
