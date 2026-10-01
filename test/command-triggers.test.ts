import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { parseJsBotConfig, commandTriggerType } from '../src/config/js-bot-config.js';
import { HandlerRegistry } from '../src/discord/handler-registry.js';
import { registerSlashCommands, commandRegistrationsEqual } from '../src/discord/command-registerer.js';
import type { CommandRest } from '../src/discord/application-command-sync.js';
import type { ScriptExecutor } from '../src/scripts/script-executor.js';
import type { ScriptExecutionContext } from '../src/scripts/script-context.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';

function mixedConfig() {
  return parseJsBotConfig(JSON.parse(JSON.stringify({ prefix: '?', commands: [
    { id: 'prefix', name: 'prefix', triggerType: 'prefix', prefixName: 'p', aliases: ['alias'], script: 'prefix', data: { legacyModeEnabled: true } },
    { id: 'slash', name: 'slash', triggerType: 'slash', script: 'slash' },
    { id: 'hybrid', name: 'hybrid', triggerType: 'hybrid', script: 'hybrid' },
    { id: 'user', name: 'user', discordType: 'user', triggerType: 'slash', script: 'user' },
    { id: 'message', name: 'message', discordType: 'message', triggerType: 'slash', script: 'message' },
    { id: 'none', name: 'none', triggerType: 'none', script: 'none' },
    { id: 'disabled', name: 'disabled', triggerType: 'hybrid', enabled: false, script: 'disabled' },
    { id: 'old', name: 'old', aliases: ['oldalias'], script: 'old' },
    { id: 'oldprefix', name: 'oldprefix', legacyModeEnabled: true, legacyPrefixOverride: 'op', script: 'oldprefix' },
  ] })));
}

describe('mixed/restored command invocation types', () => {
  it('registers only slash/hybrid/context commands and removes old accidental prefix registrations', async () => {
    const bodies: Record<string, unknown>[] = [];
    const deletes: string[] = [];
    const rest: CommandRest = {
      get: async () => [{ id: 'obsolete-prefix-id', name: 'prefix', type: 1, description: 'prefix', options: [] }],
      post: async (_route, options) => { bodies.push(options.body as Record<string, unknown>); return { id: String(bodies.length) }; },
      patch: async () => { throw new Error('Unexpected patch'); },
      delete: async (route) => { deletes.push(route); },
    };
    await registerSlashCommands({ user: { id: 'application' } } as Client, '', mixedConfig().commands, rest);
    expect(bodies.map(body => [body.name, body.type])).toEqual([
      ['slash', 1], ['hybrid', 1], ['user', 2], ['message', 3], ['old', 1],
    ]);
    expect(deletes[0]).toContain('obsolete-prefix-id');
    const original = mixedConfig().commands.find(command => command.id === 'hybrid')!;
    expect(commandRegistrationsEqual([original], [{ ...original, triggerType: 'prefix' }])).toBe(false);
  });

  it('dispatches each route with its proper context, preserves legacy aliases and remount/upsert cleanup', async () => {
    const client = new EventEmitter();
    const executions: string[] = [];
    const errors: string[] = [];
    const executor = { execute: async (script: string, context: ScriptExecutionContext) => {
      executions.push(`${script}:${context.message ? 'prefix' : 'slash'}`);
    } } as unknown as ScriptExecutor;
    const registry = new HandlerRegistry(client as unknown as Client, mixedConfig(), 'bot', executor,
      { getGlobalVariables: async () => ({}) } as VariableDatabase,
      (level, message) => { if (level === 'error') errors.push(message); });
    let sequence = 0;
    const dispatch = async (event: string, value: unknown) => Promise.all(client.listeners(event).map(listener => listener(value)));
    const message = (name: string) => dispatch('messageCreate', { author: { bot: false }, content: `?${name}`, guild: null, member: null, channel: null });
    const interaction = (name: string, context = false) => dispatch('interactionCreate', {
      id: `i-${++sequence}`, commandName: name, guild: null, member: null, channel: null,
      isAutocomplete: () => false, isChatInputCommand: () => !context, isContextMenuCommand: () => context,
    });
    registry.mount();
    for (const name of ['p', 'alias', 'prefix', 'slash', 'hybrid', 'user', 'message', 'none', 'disabled', 'old', 'oldalias', 'op']) await message(name);
    for (const name of ['prefix', 'alias', 'slash', 'hybrid', 'none', 'disabled', 'old', 'oldprefix']) await interaction(name);
    await interaction('user', true); await interaction('message', true);
    expect(executions).toEqual(['prefix:prefix', 'prefix:prefix', 'hybrid:prefix', 'old:prefix', 'old:prefix', 'oldprefix:prefix', 'slash:slash', 'hybrid:slash', 'old:slash', 'user:slash', 'message:slash']);
    expect(errors).toEqual([]);
    executions.length = 0;
    const prefix = mixedConfig().commands.find(command => command.id === 'prefix')!;
    registry.upsertCommand({ ...prefix, triggerType: 'slash', script: 'changed' });
    await message('p'); await message('alias'); await interaction('prefix');
    expect(executions).toEqual(['changed:slash']);
    registry.updateConfig(mixedConfig());
    executions.length = 0;
    await message('p'); await interaction('prefix');
    expect(executions).toEqual(['prefix:prefix']);
    registry.clear();
    expect(client.listenerCount('messageCreate')).toBe(0);
    expect(client.listenerCount('interactionCreate')).toBe(0);
  });

  it('honours historical flags before ambiguous compatibility fallback', () => {
    for (const [data, expected] of [
      [{ legacyModeEnabled: true }, 'prefix'],
      [{ legacyModeEnabled: false }, 'slash'],
      [{ legacyLocalOnly: true }, 'none'],
      [{ triggerType: 'hybrid', legacyModeEnabled: true }, 'hybrid'],
      [{}, 'hybrid'],
    ] as const) {
      expect(commandTriggerType(parseJsBotConfig({ commands: [{ id: 'a', name: 'a', script: '', data }] }).commands[0]!)).toBe(expected);
    }
  });
});
