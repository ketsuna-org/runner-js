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
