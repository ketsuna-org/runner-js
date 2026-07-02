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
});
