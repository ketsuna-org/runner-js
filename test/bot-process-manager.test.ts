import { describe, expect, it } from 'vitest';

import { BotProcessManager } from '../src/runtime/bot-process-manager.js';
import { BotStore } from '../src/runtime/bot-store.js';
import { LogStore } from '../src/runtime/log-store.js';

describe('BotProcessManager', () => {
  it('returns default stopped state for unknown bots', () => {
    const store = new BotStore();
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

  it('treats starting state as running for conflict checks', () => {
    const store = new BotStore();
    const logs = new LogStore('./data/test-logs/runner-starting.log');
    const manager = new BotProcessManager({
      dataDir: './data/test-bots-starting',
      botStore: store,
      logStore: logs,
    });

  const internal = manager as unknown as {
    states: Map<string, { botId: string; state: string }>;
  };
    internal.states.set('bot-1', { botId: 'bot-1', state: 'starting' });

    expect(manager.isRunning('bot-1')).toBe(true);
    expect(manager.runningCount).toBe(1);
  });
});
