import { afterEach, describe, expect, it, vi } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';

import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import { HandlerRegistry } from '../src/discord/handler-registry.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';
import { ScriptExecutor } from '../src/scripts/script-executor.js';

/**
 * Chaque point d entrée du runner passe par HandlerRegistry.runScript puis par le VRAI ScriptExecutor
 * (aucun faux exécuteur) : une commande préfixe, une commande slash, un événement, un webhook entrant, une
 * tâche planifiée et l autocomplétion JS doivent tous pouvoir appeler `fn.x`.
 */

type Logged = { level: string; message: string };
type FakeClient = EventEmitter & { user: { id: string }; calls: string[] };

const MARK = {
  id: 'mark',
  name: 'mark',
  params: ['where'],
  script: 'client.calls.push(where); return where;',
};

const executors: ScriptExecutor[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const executor of executors.splice(0)) executor.dispose();
});

function harness(rawConfig: Record<string, unknown>) {
  const client = new EventEmitter() as FakeClient;
  client.user = { id: '900' };
  client.calls = [];
  const logs: Logged[] = [];
  const executor = new ScriptExecutor(5000);
  executors.push(executor);
  const registry = new HandlerRegistry(
    client as unknown as Client,
    parseJsBotConfig({ prefix: '!', jsFunctions: [MARK], ...rawConfig }),
    'bot-fn',
    executor,
    { getGlobalVariables: async () => ({}) } as unknown as VariableDatabase,
    (level, message) => logs.push({ level, message }),
    undefined,
    { messageContentAvailable: true, now: () => 1_000_000 },
  );
  registry.mount();
  const dispatch = (event: string, value: unknown) =>
    Promise.all(client.listeners(event).map((listener) => listener(value)));
  const message = (content: string) =>
    dispatch('messageCreate', {
      author: { id: 'u1', bot: false },
      content,
      guild: null,
      guildId: null,
      member: null,
      channel: null,
    });
  let sequence = 0;
  const slash = (name: string) =>
    dispatch('interactionCreate', {
      id: `i-${(sequence += 1)}`,
      commandName: name,
      guild: null,
      member: null,
      channel: null,
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
    });
  return { client, registry, logs, dispatch, message, slash };
}

describe('fn depuis chaque point d entrée', () => {
  it('commande préfixe', async () => {
    const { client, message, logs } = harness({
      commands: [{ id: 'c', name: 'hello', triggerType: 'prefix', script: "await fn.mark('prefix:' + message.content);" }],
    });
    await message('!hello');
    expect(client.calls).toEqual(['prefix:!hello']);
    expect(logs.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('commande slash', async () => {
    const { client, slash, logs } = harness({
      commands: [{ id: 'c', name: 'ping', triggerType: 'slash', script: "await fn.mark('slash:' + interaction.commandName);" }],
    });
    await slash('ping');
    expect(client.calls).toEqual(['slash:ping']);
    expect(logs.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('commande hybride, appelée par préfixe puis en slash', async () => {
    const { client, message, slash } = harness({
      commands: [{ id: 'c', name: 'both', triggerType: 'hybrid', script: "await fn.mark(interaction ? 'hybrid:slash' : 'hybrid:prefix');" }],
    });
    await message('!both');
    await slash('both');
    expect(client.calls).toEqual(['hybrid:prefix', 'hybrid:slash']);
  });

  it('événement', async () => {
    const { client, message } = harness({
      events: [{ id: 'e', name: 'messageCreate', script: "await fn.mark('event:' + message.content);" }],
    });
    await message('bonjour');
    expect(client.calls).toEqual(['event:bonjour']);
  });

  it('webhook entrant', async () => {
    const { client, registry } = harness({
      inboundWebhooks: [{ id: 'w', path: 'deploy', script: "await fn.mark('webhook:' + webhook.path + ':' + webhook.payload.n);" }],
    });
    expect(await registry.triggerWebhook('deploy', { n: 7 }, {})).toBe(true);
    expect(client.calls).toEqual(['webhook:deploy:7']);
  });

  it('tâche planifiée', async () => {
    vi.useFakeTimers();
    const { client } = harness({
      scheduled: [{ id: 's', everyMinutes: 5, script: "await fn.mark('scheduled:' + typeof interaction + '/' + typeof message);" }],
    });
    await vi.advanceTimersByTime(5 * 60_000 + 1000);
    for (let attempt = 0; attempt < 200 && client.calls.length === 0; attempt += 1) await Promise.resolve();
    expect(client.calls).toEqual(['scheduled:undefined/undefined']);
  });

  it('autocomplétion JavaScript', async () => {
    const { client, dispatch } = harness({
      commands: [
        {
          id: 'c',
          name: 'search',
          triggerType: 'slash',
          script: 'return;',
          options: [
            {
              name: 'query',
              type: 'string',
              autocomplete: {
                enabled: true,
                mode: 'javascript',
                jsScript: "const hit = await fn.mark('autocomplete:' + interaction.options.getFocused()); await interaction.respond([{ name: hit, value: hit }]);",
              },
            },
          ],
        },
      ],
    });
    const respond = vi.fn(async () => undefined);
    await dispatch('interactionCreate', {
      id: 'ac-1',
      commandName: 'search',
      guild: null,
      member: null,
      channel: null,
      respond,
      options: {
        getFocused: (full?: boolean) => (full ? { name: 'query', value: 'ab' } : 'ab'),
        getSubcommand: () => null,
        getSubcommandGroup: () => null,
      },
      isAutocomplete: () => true,
    });
    expect(client.calls).toEqual(['autocomplete:ab']);
    expect(respond).toHaveBeenCalledWith([{ name: 'autocomplete:ab', value: 'autocomplete:ab' }]);
  });
});

describe('fn : rechargement et configuration', () => {
  it('updateConfig remplace le corps d une fonction à chaud', async () => {
    const commands = [{ id: 'c', name: 'run', triggerType: 'prefix', script: "client.calls.push(String(await fn.value()));" }];
    const { client, registry, message } = harness({
      commands,
      jsFunctions: [{ id: 'v', name: 'value', script: 'return 1;' }],
    });
    await message('!run');
    registry.updateConfig(
      parseJsBotConfig({ prefix: '!', commands, jsFunctions: [{ id: 'v', name: 'value', script: 'return 2;' }] }),
    );
    await message('!run');
    expect(client.calls).toEqual(['1', '2']);
  });

  it('updateConfig peut ajouter puis retirer une fonction', async () => {
    const commands = [
      { id: 'c', name: 'run', triggerType: 'prefix', script: "try { client.calls.push(String(await fn.extra())); } catch (e) { client.calls.push(e.message); }" },
    ];
    const { client, registry, message } = harness({ commands, jsFunctions: [] });
    await message('!run');
    registry.updateConfig(
      parseJsBotConfig({ prefix: '!', commands, jsFunctions: [{ id: 'x', name: 'extra', script: "return 'added';" }] }),
    );
    await message('!run');
    registry.updateConfig(parseJsBotConfig({ prefix: '!', commands }));
    await message('!run');
    expect(client.calls).toEqual([
      'Unknown function extra (disponibles : aucune)',
      'added',
      'Unknown function extra (disponibles : aucune)',
    ]);
  });

  it('une jsFunctions invalide est journalisée sans empêcher mount() ni les commandes', async () => {
    const { client, logs, message, registry } = harness({
      commands: [{ id: 'c', name: 'run', triggerType: 'prefix', script: "client.calls.push(await fn.good());" }],
      jsFunctions: [
        { id: 'a', name: '1bad', script: 'return 1;' },
        { id: 'b', name: 'delete', script: 'return 1;' },
        { id: 'c', name: 'good', script: "return 'still works';" },
      ],
    });
    expect(() => registry.mount()).not.toThrow();
    await message('!run');
    expect(client.calls).toEqual(['still works']);
    const warnings = logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message);
    expect(warnings.some((text) => text.includes('1bad'))).toBe(true);
    expect(warnings.some((text) => text.includes('delete'))).toBe(true);
    expect(logs.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('une erreur dans une fonction est journalisée comme erreur du script appelant, avec le nom de la fonction', async () => {
    const { client, logs, message } = harness({
      commands: [{ id: 'c', name: 'run', triggerType: 'prefix', script: 'await fn.explode();' }],
      jsFunctions: [{ id: 'x', name: 'explode', script: "throw new Error('boom');" }],
    });
    await message('!run');
    expect(client.calls).toEqual([]);
    expect(logs.some((entry) => entry.level === 'error' && entry.message.includes('Function explode failed: boom'))).toBe(true);
  });
});
