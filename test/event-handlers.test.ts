import { expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { parseJsBotConfig, validateJsBotConfig } from '../src/config/js-bot-config.js';
import { HandlerRegistry } from '../src/discord/handler-registry.js';
import type { ScriptExecutor } from '../src/scripts/script-executor.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';

it('executes all enabled event handlers, isolates failures, and cleans up on remount', async () => {
  const client = new EventEmitter();
  const config = parseJsBotConfig({ events: [
    { id: 'first', name: 'interactionCreate', script: 'first' },
    { id: 'second', name: 'interactionCreate', script: 'second' },
    { id: 'disabled', name: 'interactionCreate', script: 'disabled', enabled: false },
  ] });
  validateJsBotConfig(config);
  const executed: string[] = [];
  const errors: string[] = [];
  const executor = { execute: async (script: string) => {
    executed.push(script);
    if (script === 'first') throw new Error('first handler failed');
  } } as unknown as ScriptExecutor;
  const variables = { getGlobalVariables: async () => ({}) } as VariableDatabase;
  const registry = new HandlerRegistry(client as unknown as Client, config,
    'bot-1', executor, variables, (level, message) => {
      if (level === 'error') errors.push(message);
    });
  const interaction = {
    id: 'interaction-1',
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isContextMenuCommand: () => false,
    isButton: () => true,
    isRepliable: () => false,
  };
  registry.mount();
  const listenerCount = client.listenerCount('interactionCreate');
  await Promise.all(client.listeners('interactionCreate').map(listener => listener(interaction)));
  expect(executed.sort()).toEqual(['first', 'second']);
  expect(errors.some(message => message.includes('first handler failed'))).toBe(true);
  executed.length = 0;
  registry.mount();
  expect(client.listenerCount('interactionCreate')).toBe(listenerCount);
  await Promise.all(client.listeners('interactionCreate').map(listener => listener(interaction)));
  expect(executed.sort()).toEqual(['first', 'second']);
  registry.clear();
  expect(client.listenerCount('interactionCreate')).toBe(0);
});

it('answers an unanswered interaction when its script throws', async () => {
  const { notifyScriptFailure, SCRIPT_FAILURE_NOTICE } = await import('../src/discord/handler-registry.js');
  const calls: Array<[string, unknown]> = [];
  const make = (state: { replied?: boolean; deferred?: boolean; repliable?: boolean }) => ({
    replied: state.replied ?? false,
    deferred: state.deferred ?? false,
    isRepliable: () => state.repliable ?? true,
    isAutocomplete: () => false,
    reply: async (arg: unknown) => { calls.push(['reply', arg]); },
    editReply: async (arg: unknown) => { calls.push(['editReply', arg]); },
  });
  await notifyScriptFailure(make({}) as never);
  await notifyScriptFailure(make({ deferred: true }) as never);
  await notifyScriptFailure(make({ replied: true }) as never);
  await notifyScriptFailure(make({ repliable: false }) as never);
  await notifyScriptFailure(undefined);
  expect(calls.map(([kind]) => kind)).toEqual(['reply', 'editReply']);
  expect((calls[0][1] as { content: string; ephemeral: boolean }).ephemeral).toBe(true);
  expect((calls[1][1] as { content: string }).content).toBe(SCRIPT_FAILURE_NOTICE);
});

it('isPrefixCommandMessage (caractérisation, non corrigée) : seul un message préfixé dont la commande est aussi slash masque les handlers messageCreate ; mention et sans-préfixe ne les masquent pas', async () => {
  const client = new EventEmitter() as EventEmitter & { user?: { id: string } };
  client.user = { id: '900' };
  const config = parseJsBotConfig({
    prefix: '!',
    mentionAsPrefix: true,
    allowNoPrefixCommands: true,
    commands: [
      { id: 'h', name: 'hyb', triggerType: 'hybrid', noPrefix: true, script: 'cmd:hyb' },
      { id: 'p', name: 'pfx', triggerType: 'prefix', noPrefix: true, script: 'cmd:pfx' },
    ],
    events: [{ id: 'ev', name: 'messageCreate', script: 'event' }],
  });
  const executed: string[] = [];
  const executor = { execute: async (script: string) => { executed.push(script); } } as unknown as ScriptExecutor;
  const registry = new HandlerRegistry(client as unknown as Client, config, 'bot-1', executor,
    { getGlobalVariables: async () => ({}) } as VariableDatabase, () => undefined, undefined,
    { messageContentAvailable: true, now: () => 1_000_000 });
  registry.mount();
  let sequence = 0;
  const send = async (content: string) => {
    executed.length = 0;
    sequence += 1;
    await Promise.all(client.listeners('messageCreate').map(listener => listener({
      author: { id: `u${sequence}`, bot: false }, content, guild: null, guildId: 'g1', channelId: 'c1', member: null, channel: null,
    })));
    return [...executed].sort();
  };
  // Route préfixe, commande aussi présente dans commandMap (hybride) : le handler est masqué.
  expect(await send('!hyb')).toEqual(['cmd:hyb']);
  // Route préfixe, commande préfixe seule (absente de commandMap) : le handler s exécute aussi (défaut probable, figé ici).
  expect(await send('!pfx')).toEqual(['cmd:pfx', 'event']);
  // Mention et sans préfixe : la commande ET le handler s exécutent.
  expect(await send('<@900> hyb')).toEqual(['cmd:hyb', 'event']);
  expect(await send('hyb')).toEqual(['cmd:hyb', 'event']);
  // Un message qui ne déclenche aucune commande atteint le handler.
  expect(await send('bonjour')).toEqual(['event']);
});
