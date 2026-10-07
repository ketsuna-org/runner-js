import { describe, expect, test } from 'bun:test';

import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import { describeZodError } from '../src/http/server.js';

describe('config error text', () => {
  test('lists each problem on its own path instead of dumping the raw issues', () => {
    try {
      parseJsBotConfig({ commands: [{ id: 'a', name: 'ok', script: 'x' }, { id: 'b', name: 'blocks', type: 'chatInput' }] });
      throw new Error('should have failed');
    } catch (error) {
      const text = describeZodError(error as never);
      expect(text).toContain('commands[1].script');
      expect(text).toContain('commands[1].type');
      expect(text.startsWith('[')).toBe(false);
    }
  });
});
