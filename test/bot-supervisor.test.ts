import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsBotConfig } from '../src/config/js-bot-config.js';
import { DiscordTokenUnauthorizedError } from '../src/discord/discord-auth-errors.js';
import type { BotStore } from '../src/runtime/bot-store.js';
import {
  BotSupervisor,
  type BotRunnerHandle,
  type CreateRunnerParams,
} from '../src/runtime/bot-supervisor.js';
import type { LogStore } from '../src/runtime/log-store.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';

function fakeLogStore(): LogStore {
  return { append: vi.fn() } as unknown as LogStore;
}

function fakeBotStore(configOverrides: Record<string, unknown> = {}): BotStore {
  return {
    load: vi.fn(async (botId: string) => ({
      id: botId,
      name: `${botId}-name`,
      syncedAt: new Date().toISOString(),
      config: {
        token: 'x',
        autoRestart: true,
        ...configOverrides,
      } as unknown as JsBotConfig,
    })),
  } as unknown as BotStore;
}

function fakeRunner(overrides: Partial<BotRunnerHandle> = {}): BotRunnerHandle {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    triggerWebhook: vi.fn(async () => true),
    getGuildCount: vi.fn(() => 3),
    getHeapUsedBytes: vi.fn(() => 1_000_000),
    disposeIdleIsolate: vi.fn(() => false),
    ...overrides,
  };
}

interface Harness {
  supervisor: BotSupervisor;
  runners: BotRunnerHandle[];
  createdParams: CreateRunnerParams[];
  logStore: LogStore;
  exitProcess: ReturnType<typeof vi.fn>;
}

const disposers: Array<() => Promise<void>> = [];

function makeHarness(options: {
  botStore?: BotStore;
  nextRunner?: () => BotRunnerHandle;
  memoryPolicy?: ConstructorParameters<typeof BotSupervisor>[0]['memoryPolicy'];
} = {}): Harness {
  const logStore = fakeLogStore();
  const runners: BotRunnerHandle[] = [];
  const createdParams: CreateRunnerParams[] = [];
  const exitProcess = vi.fn();
  const supervisor = new BotSupervisor({
    botStore: options.botStore ?? fakeBotStore(),
    logStore,
    variableStore: {} as VariableDatabase,
    sandboxScripts: true,
    createRunner: (params) => {
      createdParams.push(params);
      const runner = options.nextRunner ? options.nextRunner() : fakeRunner();
      runners.push(runner);
      return runner;
    },
    memoryPolicy: options.memoryPolicy,
    exitProcess,
  });
  disposers.push(() => supervisor.dispose());
  return { supervisor, runners, createdParams, logStore, exitProcess };
}

afterEach(async () => {
  while (disposers.length > 0) {
    await disposers.pop()?.();
  }
  vi.useRealTimers();
});

describe('BotSupervisor', () => {
  it('returns default stopped state for unknown bots', () => {
    const { supervisor } = makeHarness();

    const state = supervisor.getState('missing-bot');
    expect(state.state).toBe('stopped');
    expect(state.botId).toBe('missing-bot');
    expect(supervisor.runningCount).toBe(0);
  });

  it('starts and stops a bot through an in-process runner', async () => {
    const { supervisor, runners } = makeHarness();

    await supervisor.startBot('bot-1', 'Bot One');

    expect(runners).toHaveLength(1);
    expect(runners[0].start).toHaveBeenCalledTimes(1);
    expect(supervisor.isRunning('bot-1')).toBe(true);
    expect(supervisor.runningCount).toBe(1);

    const state = supervisor.getState('bot-1');
    expect(state.state).toBe('running');
    expect(state.botName).toBe('Bot One');
    expect(state.guildCount).toBe(3);
    expect(state.heapUsedBytes).toBe(1_000_000);
    expect(state.pid).toBeNull();
    expect(state.rssBytes).toBeNull();
    expect(state.startedAt).not.toBeNull();

    await expect(supervisor.startBot('bot-1', 'Bot One')).rejects.toThrow(/already running/);

    await supervisor.stopBot('bot-1');
    expect(runners[0].stop).toHaveBeenCalled();
    expect(supervisor.isRunning('bot-1')).toBe(false);
    expect(supervisor.getState('bot-1').state).toBe('stopped');
  });

  it('marks the bot token-invalid when start fails with an auth error', async () => {
    const { supervisor, runners } = makeHarness({
      nextRunner: () =>
        fakeRunner({
          start: vi.fn(async () => {
            throw new DiscordTokenUnauthorizedError('token rejected');
          }),
        }),
    });

    await expect(supervisor.startBot('bot-1', '')).rejects.toThrow('token rejected');

    const state = supervisor.getState('bot-1');
    expect(state.state).toBe('stopped');
    expect(state.lastError).toBe('token rejected');
    expect(state.autoRestart).toBe(false);
    expect(supervisor.isTokenInvalid('bot-1')).toBe(true);
    expect(runners[0].stop).toHaveBeenCalled();

    supervisor.clearTokenInvalid('bot-1');
    expect(supervisor.isTokenInvalid('bot-1')).toBe(false);
  });

  it('auto-restarts a bot after a fatal disconnect', async () => {
    vi.useFakeTimers();
    const { supervisor, runners, createdParams } = makeHarness();

    await supervisor.startBot('bot-1', 'Bot One');
    expect(createdParams).toHaveLength(1);

    createdParams[0].onFatalDisconnect('Discord session invalidated');

    let state = supervisor.getState('bot-1');
    expect(state.state).toBe('error');
    expect(state.lastError).toBe('Discord session invalidated');

    await vi.advanceTimersByTimeAsync(2500);

    expect(createdParams).toHaveLength(2);
    expect(runners[1].start).toHaveBeenCalledTimes(1);
    state = supervisor.getState('bot-1');
    expect(state.state).toBe('running');
  });

  it('does not restart after a disallowed-intents disconnect', async () => {
    vi.useFakeTimers();
    const { supervisor, createdParams } = makeHarness();

    await supervisor.startBot('bot-1', 'Bot One');
    createdParams[0].onFatalDisconnect(
      'Shard 0: Disallowed intents (4014) — enable the required intents',
    );

    const state = supervisor.getState('bot-1');
    expect(state.state).toBe('stopped');
    expect(state.lastError).toContain('Disallowed intents');

    await vi.advanceTimersByTimeAsync(4000);
    expect(createdParams).toHaveLength(1);
  });

  it('does not restart when autoRestart is disabled in the config', async () => {
    vi.useFakeTimers();
    const { supervisor, createdParams } = makeHarness({
      botStore: fakeBotStore({ autoRestart: false }),
    });

    await supervisor.startBot('bot-1', 'Bot One');
    createdParams[0].onFatalDisconnect('Discord session invalidated');

    expect(supervisor.getState('bot-1').state).toBe('error');
    await vi.advanceTimersByTimeAsync(4000);
    expect(createdParams).toHaveLength(1);
  });

  it('cancels a pending auto-restart when the bot is stopped', async () => {
    vi.useFakeTimers();
    const { supervisor, createdParams } = makeHarness();

    await supervisor.startBot('bot-1', 'Bot One');
    createdParams[0].onFatalDisconnect('Discord session invalidated');
    await supervisor.stopBot('bot-1');

    await vi.advanceTimersByTimeAsync(4000);
    expect(createdParams).toHaveLength(1);
    expect(supervisor.getState('bot-1').state).toBe('stopped');
  });

  it('routes inbound webhooks to the runner and rejects unknown paths', async () => {
    const { supervisor, runners } = makeHarness({
      nextRunner: () =>
        fakeRunner({
          triggerWebhook: vi.fn(async (pathKey: string) => pathKey === 'known'),
        }),
    });

    await expect(
      supervisor.triggerInboundWebhook('bot-1', 'known', {}, {}),
    ).rejects.toThrow(/not running/);

    await supervisor.startBot('bot-1', 'Bot One');
    await supervisor.triggerInboundWebhook('bot-1', 'known', { a: 1 }, { h: 'v' });
    expect(runners[0].triggerWebhook).toHaveBeenCalledWith('known', { a: 1 }, { h: 'v' });

    await expect(
      supervisor.triggerInboundWebhook('bot-1', 'missing', {}, {}),
    ).rejects.toThrow(/Inbound webhook not found/);
  });

  it('reloads a running bot with the freshly synced config', async () => {
    const { supervisor, runners } = makeHarness();

    expect(await supervisor.reloadBot('bot-1')).toBe(false);

    await supervisor.startBot('bot-1', 'Bot One');
    expect(await supervisor.reloadBot('bot-1')).toBe(true);
    expect(runners[0].reload).toHaveBeenCalledTimes(1);
    expect(supervisor.getState('bot-1').state).toBe('running');
  });

  it('drains all running bots', async () => {
    const { supervisor, runners } = makeHarness();

    await supervisor.startBot('bot-1', '');
    await supervisor.startBot('bot-2', '');

    const stopped = await supervisor.drainAll();
    expect(stopped).toBe(2);
    expect(runners[0].stop).toHaveBeenCalled();
    expect(runners[1].stop).toHaveBeenCalled();
    expect(supervisor.runningCount).toBe(0);
  });

  it('updates per-bot isolate heap metrics on the maintenance tick', async () => {
    vi.useFakeTimers();
    const { supervisor } = makeHarness({
      nextRunner: () =>
        fakeRunner({
          getGuildCount: vi.fn(() => 7),
          getHeapUsedBytes: vi.fn(() => 42_000_000),
        }),
    });

    await supervisor.startBot('bot-1', '');
    await vi.advanceTimersByTimeAsync(5000);

    const state = supervisor.getState('bot-1');
    expect(state.guildCount).toBe(7);
    expect(state.heapUsedBytes).toBe(42_000_000);
    expect(state.rssBytes).toBeNull();
  });

  it('force-disposes idle isolates and exits on sustained critical RSS', async () => {
    vi.useFakeTimers();
    const disposeIdleIsolate = vi.fn(() => true);
    const { supervisor, exitProcess, logStore } = makeHarness({
      nextRunner: () => fakeRunner({ disposeIdleIsolate }),
      memoryPolicy: {
        softThresholdMb: 1,
        criticalThresholdMb: 1,
        requiredConsecutive: 1,
        minUptimeMs: 0,
      },
    });

    await supervisor.startBot('bot-1', '');
    await vi.advanceTimersByTimeAsync(5000);

    expect(disposeIdleIsolate).toHaveBeenCalledWith(true);
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(logStore.append).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/critical threshold/),
    );
  });
});
