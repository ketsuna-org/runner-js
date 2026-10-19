import { afterEach, describe, expect, it, vi } from 'bun:test';
import { Client } from 'discord.js';

import { parseJsBotConfig, type JsBotConfig } from '../src/config/js-bot-config.js';
import {
  armDiscordIpBlock,
  clearDiscordIpBlock,
} from '../src/discord/discord-auth-errors.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';
import { JsDiscordRunner } from '../src/worker/js-discord-runner.js';

type Level = 'info' | 'warn' | 'error' | 'debug';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  clearDiscordIpBlock();
});

function liveRunner(token = 'token') {
  const logs: Array<{ level: Level; message: string; origin?: string }> = [];
  const runner = new JsDiscordRunner(
    'bot-1',
    parseJsBotConfig({ token, events: [], commands: [] }),
    {} as VariableDatabase,
    (level, message, origin) => logs.push({ level, message, origin }),
  );
  const destroy = vi.fn(async () => undefined);
  const updateConfig = vi.fn();
  const internals = runner as unknown as Record<string, unknown>;
  internals.client = { destroy, isReady: () => true, guilds: { cache: { size: 1 } } };
  internals.registry = { updateConfig, clear: vi.fn() };
  internals.effectiveIntents = { Guilds: true };
  vi.spyOn(
    runner as unknown as { resolveEffectiveIntents: () => Promise<Record<string, boolean>> },
    'resolveEffectiveIntents',
  ).mockResolvedValue({ Guilds: true, GuildMembers: true });
  const start = vi.spyOn(runner, 'start').mockResolvedValue(undefined);
  return { runner, logs, destroy, updateConfig, start, internals };
}

const nextConfig = (token = 'token'): JsBotConfig =>
  parseJsBotConfig({ token, events: [], commands: [] });

describe('JsDiscordRunner.reload under a Discord IP block', () => {
  it('keeps the healthy client when only the intents changed', async () => {
    const { runner, logs, destroy, updateConfig, start, internals } = liveRunner();
    armDiscordIpBlock(120);

    await runner.reload(nextConfig());

    expect(start).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(internals.effectiveIntents).toEqual({ Guilds: true });
    const warnings = logs.filter((line) => line.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('deferred');
  });

  it('reconnects as before when no block is active', async () => {
    const { runner, start, updateConfig } = liveRunner();

    await runner.reload(nextConfig());

    expect(start).toHaveBeenCalledTimes(1);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('still goes through start() when the token changed (the old client cannot serve the new one)', async () => {
    const { runner, start } = liveRunner('old');
    armDiscordIpBlock(120);

    await runner.reload(nextConfig('new'));

    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('JsDiscordRunner script logs', () => {
  it('tags what handlers and scripts log with the script origin, the runner own lines without', async () => {
    const logs: Array<{ level: Level; message: string; origin?: string }> = [];
    vi.spyOn(Client.prototype, 'login').mockResolvedValue('token');
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ flags: 0 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const runner = new JsDiscordRunner(
      'bot-1',
      parseJsBotConfig({ token: 'token', events: [], commands: [] }),
      {} as VariableDatabase,
      (level, message, origin) => logs.push({ level, message, origin }),
    );

    await runner.start();
    const registry = (runner as unknown as {
      registry: { emitLog: (level: Level, message: string) => void };
    }).registry;
    registry.emitLog('error', 'Handler script failed (command:x): boom');
    await runner.stop();

    expect(logs.find((line) => line.message.startsWith('Handler script failed'))?.origin).toBe(
      'script',
    );
    expect(logs.find((line) => line.message.startsWith('[ScriptRuntime]'))?.origin).toBeUndefined();
  });
});
