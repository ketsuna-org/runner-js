import { describe, expect, it } from 'bun:test';
import type { CommandHandler, JsBotConfig } from '../src/config/js-bot-config.js';
import { commandRegistrationsEqual } from '../src/discord/command-registerer.js';
import { JsDiscordRunner } from '../src/worker/js-discord-runner.js';

const command = (overrides: Partial<CommandHandler> = {}): CommandHandler => ({
  id: 'stable-id', type: 'command', name: 'search', description: 'Search',
  discordType: 'chatInput', options: [], aliases: [], enabled: true, script: 'old',
  ...overrides,
});

describe('execution-only command updates', () => {
  it('ignores execution and autocomplete workflow changes', () => {
    const option = { type: 'string', name: 'query', description: 'Query',
      autocomplete: { enabled: true, mode: 'javascript', script: 'old' } };
    expect(commandRegistrationsEqual([command({ options: [option] })], [command({
      script: 'new', options: [{ ...option, autocomplete: { ...option.autocomplete, script: 'new' } }],
    })])).toBe(true);
    expect(commandRegistrationsEqual([command({ options: [option] })], [command({
      options: [{ ...option, autocomplete: { enabled: false } }],
    })])).toBe(false);
  });

  it('detects publication changes and ignores list ordering', () => {
    const before = command();
    for (const change of [{ name: 'find' }, { description: 'New' }, { enabled: false },
      { defaultMemberPermissions: '8' }, { contexts: [0] }, { integrationTypes: [0] }, { discordType: 'user' as const }]) {
      expect(commandRegistrationsEqual([before], [command(change)])).toBe(false);
    }
    const second = command({ id: 'second', name: 'ping' });
    expect(commandRegistrationsEqual([before, second], [second, before])).toBe(true);
  });

  it('updates the running handler without accessing Discord', async () => {
    const runner = new JsDiscordRunner('bot', { commands: [command()] } as JsBotConfig,
      {} as never, () => {});
    const updates: CommandHandler[] = [];
    // A registry is already mounted; touching the client would fail this test.
    Object.assign(runner, {
      registry: { upsertCommand: (value: CommandHandler) => updates.push(value) },
      client: { get user(): never { throw new Error('Unexpected Discord lookup'); } },
    });
    const changed = command({ script: 'new' });
    await runner.upsertCommand(changed);
    expect(updates).toEqual([changed]);
  });

  it('keeps execution changes during a full reload without registering commands', async () => {
    const config = { token: 'token', commands: [command()], scopedVariableDefinitions: [] } as unknown as JsBotConfig;
    const runner = new JsDiscordRunner('bot', config, {} as never, () => {});
    const updates: JsBotConfig[] = [];
    Object.assign(runner, {
      resolveEffectiveIntents: async () => ({}),
      registry: { updateConfig: (value: JsBotConfig) => updates.push(value) },
      client: { get user(): never { throw new Error('Unexpected registration'); } },
    });
    const changed = { ...config, commands: [command({ script: 'new' })] };
    await runner.reload(changed);
    expect(updates[0]?.commands?.[0]?.script).toBe('new');
  });
});
