import { describe, expect, it } from 'vitest';

import { BotProcessManager, type ManagedWorkerState } from '../src/runtime/bot-process-manager.js';
import { BotStore } from '../src/runtime/bot-store.js';
import { LogStore } from '../src/runtime/log-store.js';

function seedState(manager: BotProcessManager, botId: string, partial: Partial<ManagedWorkerState>) {
  const internal = manager as unknown as {
    states: Map<string, ManagedWorkerState>;
    handleWorkerMessage: (botId: string, raw: unknown) => void;
  };

  internal.states.set(botId, {
    botId,
    botName: botId,
    state: 'running',
    pid: 100,
    startedAt: null,
    lastError: null,
    lastSeenAt: null,
    rssBytes: null,
    heapUsedBytes: null,
    guildCount: null,
    autoRestart: true,
    ...partial,
  });

  return internal;
}

describe('BotProcessManager', () => {
  it('returns default stopped state for unknown bots', () => {
    const store = new BotStore('./data/test-bots/synced-bots');
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
    const store = new BotStore('./data/test-bots-starting/synced-bots');
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

  it('stores early worker metrics and error status guild counts', () => {
    const store = new BotStore('./data/test-bots-metrics/synced-bots');
    const logs = new LogStore('./data/test-logs/runner-metrics.log');
    const manager = new BotProcessManager({
      dataDir: './data/test-bots-metrics',
      botStore: store,
      logStore: logs,
    });

    const internal = seedState(manager, 'bot-1', {});

    internal.handleWorkerMessage('bot-1', {
      type: 'metrics',
      botId: 'bot-1',
      rssBytes: 12_000_000,
      heapUsedBytes: 4_000_000,
      guildCount: 0,
      pid: 4242,
    });

    let state = manager.getState('bot-1');
    expect(state.rssBytes).toBe(12_000_000);
    expect(state.guildCount).toBe(0);
    expect(state.pid).toBe(4242);

    internal.handleWorkerMessage('bot-1', {
      type: 'status',
      botId: 'bot-1',
      state: 'error',
      lastError: 'Disallowed intents (4014)',
      guildCount: 0,
    });

    state = manager.getState('bot-1');
    expect(state.state).toBe('error');
    expect(state.rssBytes).toBe(12_000_000);
    expect(state.guildCount).toBe(0);
  });
});
