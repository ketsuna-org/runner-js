import { describe, expect, it } from 'vitest';

import { BotProcessManager } from '../src/runtime/bot-process-manager.js';
import { BotStore } from '../src/runtime/bot-store.js';
import { LogStore } from '../src/runtime/log-store.js';

describe('BotProcessManager', () => {
  it('returns default stopped state for unknown bots', () => {
    const store = new BotStore('./data/test-bots');
    const logs = new LogStore('./data/test-logs/runner.log');
    const manager = new BotProcessManager({
      dataDir: './data/test-bots',
      botStore: store,
      logStore: logs,
    });

    const state = manager.getState('missing-bot');
    expect(state.state).toBe('stopped');
    expect(state.botId).toBe('missing-bot');
    expect(manager.runningCount).toBe(0);
  });
});
