import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import { HandlerRegistry } from '../src/discord/handler-registry.js';
import { ScriptExecutor } from '../src/scripts/script-executor.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';

const SCRIPT = 'const ctx = message ?? interaction; await ctx.reply("one"); await ctx.reply("two"); return { hasMessage: !!message, hasInteraction: !!interaction };';

function setup(triggerType: 'hybrid' | 'slash' | 'prefix', script = SCRIPT) {
  const client = new EventEmitter() as EventEmitter & { token?: string };
  client.token = 'secret';
  const results: unknown[] = [];
  const errors: string[] = [];
  const base = new ScriptExecutor(5000);
  const executor = { execute: async (...args: Parameters<ScriptExecutor['execute']>) => {
    results.push(await base.execute(...args));
  } } as unknown as ScriptExecutor;
  const config = parseJsBotConfig({ prefix: '?', commands: [{ id: 'c', name: 'c', triggerType, script }] });
  const registry = new HandlerRegistry(client as unknown as Client, config, 'bot', executor,
    { getGlobalVariables: async () => ({}) } as VariableDatabase,
    (level, message) => { if (level === 'error') errors.push(message); });
  registry.mount();
  const calls: string[] = [];
  const state = { replied: false, deferred: false };
  const interaction = {
    id: 'i1', commandName: 'c', guild: null, member: null, channel: null, channelId: 'ch', guildId: null,
    user: { id: 'u' }, client, isAutocomplete: () => false, isChatInputCommand: () => true,
    isContextMenuCommand: () => false, isRepliable: () => true,
    get replied() { return state.replied; }, get deferred() { return state.deferred; },
    reply: async (o: unknown) => { calls.push(`reply:${JSON.stringify(o)}`); state.replied = true; },
    editReply: async (o: unknown) => { calls.push(`editReply:${JSON.stringify(o)}`); state.replied = true; },
    followUp: async (o: unknown) => { calls.push(`followUp:${JSON.stringify(o)}`); },
  };
  const slash = async () => { await Promise.all(client.listeners('interactionCreate').map(l => l(interaction))); };
  const prefix = async () => {
    const sent: string[] = [];
    const msg = { author: { bot: false }, content: '?c', guild: null, member: null, channel: null,
      reply: async (o: string) => { sent.push(o); } };
    await Promise.all(client.listeners('messageCreate').map(l => l(msg)));
    return sent;
  };
  return { slash, prefix, calls, results, errors, state };
}

describe('hybrid slash message compatibility', () => {
  it('maps message.reply to reply then followUp on a hybrid slash run', async () => {
    const t = setup('hybrid', 'await message.reply("one"); await message.reply({ content: "two" }); await message.channel.send("three"); return [message.author.id, typeof message.client.token, message.isInteractionCompat, !!interaction];');
    await t.slash();
    expect(t.errors).toEqual([]);
    expect(t.calls).toEqual(['reply:{"content":"one"}', 'followUp:{"content":"two"}', 'followUp:{"content":"three"}']);
    expect(t.results).toEqual([['u', 'undefined', true, true]]);
  });

  it('uses editReply when the interaction was deferred', async () => {
    const t = setup('hybrid', 'await message.reply("x"); await message.reply("y");');
    t.state.deferred = true;
    await t.slash();
    expect(t.calls).toEqual(['editReply:{"content":"x"}', 'followUp:{"content":"y"}']);
  });

  it('keeps `message ?? interaction` working', async () => {
    const t = setup('hybrid');
    await t.slash();
    expect(t.calls).toEqual(['reply:{"content":"one"}', 'followUp:{"content":"two"}']);
  });

  it('leaves hybrid prefix runs untouched (real message, no interaction)', async () => {
    const t = setup('hybrid');
    expect(await t.prefix()).toEqual(['one', 'two']);
    expect(t.results).toEqual([{ hasMessage: true, hasInteraction: false }]);
  });

  it('leaves pure slash runs untouched (message undefined)', async () => {
    const t = setup('slash');
    await t.slash();
    expect(t.results).toEqual([{ hasMessage: false, hasInteraction: true }]);
    expect(t.calls.length).toBe(2);
  });
});
