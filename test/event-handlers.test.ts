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
