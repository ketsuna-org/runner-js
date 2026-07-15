import { describe, expect, it } from 'vitest';

import {
  parseJsBotConfig,
  validateJsBotConfig,
} from '../src/config/js-bot-config.js';

describe('JsBotConfig', () => {
  it('parses a minimal valid config', () => {
    const config = parseJsBotConfig({
      token: 'test-token',
      commands: [
        {
          id: 'cmd-1',
          type: 'command',
          name: 'ping',
          description: 'Ping',
          script: "await interaction.reply('pong');",
        },
      ],
    });

    expect(config.token).toBe('test-token');
    expect(config.commands).toHaveLength(1);
    validateJsBotConfig(config);
  });

  it('rejects duplicate command names', () => {
    const config = parseJsBotConfig({
      token: 'test-token',
      commands: [
        { id: '1', type: 'command', name: 'ping', script: 'true;' },
        { id: '2', type: 'command', name: 'ping', script: 'true;' },
      ],
    });

    expect(() => validateJsBotConfig(config)).toThrow(/Duplicate command name/);
  });

  it('rejects script timeouts above 15 minutes', () => {
    expect(() =>
      parseJsBotConfig({
        token: 'test-token',
        scriptTimeoutMs: 15 * 60 * 1000 + 1,
      }),
    ).toThrow();
  });

  it('defaults script timeout to 15 minutes', () => {
    const config = parseJsBotConfig({ token: 'test-token' });
    expect(config.scriptTimeoutMs).toBe(15 * 60 * 1000);
  });

  it('accepts empty or null command lists', () => {
    const empty = parseJsBotConfig({ token: 'test-token', commands: [] });
    validateJsBotConfig(empty);
    expect(empty.commands).toEqual([]);

    const missing = parseJsBotConfig({ token: 'test-token' });
    validateJsBotConfig(missing);
    expect(missing.commands).toEqual([]);

    const nil = parseJsBotConfig({ token: 'test-token', commands: null });
    validateJsBotConfig(nil);
    expect(nil.commands).toEqual([]);
  });
});
