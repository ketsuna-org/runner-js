import { afterEach, describe, expect, it, vi } from 'bun:test';

import type { JsBotConfig } from '../src/config/js-bot-config.js';
import {
  DiscordTokenUnauthorizedError,
  DiscordUnavailableError,
  armDiscordIpBlock,
  clearDiscordIpBlock,
} from '../src/discord/discord-auth-errors.js';
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
    ...overrides,
  };
}

interface Harness {
  supervisor: BotSupervisor;
  runners: BotRunnerHandle[];
  createdParams: CreateRunnerParams[];
  logStore: LogStore;
}

const disposers: Array<() => Promise<void>> = [];

function makeHarness(options: {
  botStore?: BotStore;
  nextRunner?: () => BotRunnerHandle;
  maxBots?: number;
} = {}): Harness {
  const logStore = fakeLogStore();
  const runners: BotRunnerHandle[] = [];
  const createdParams: CreateRunnerParams[] = [];
  const supervisor = new BotSupervisor({
    botStore: options.botStore ?? fakeBotStore(),
    logStore,
    variableStore: {} as VariableDatabase,
    maxBots: options.maxBots ?? 40,
    createRunner: (params) => {
      createdParams.push(params);
      const runner = options.nextRunner ? options.nextRunner() : fakeRunner();
      runners.push(runner);
      return runner;
    },
  });
  disposers.push(() => supervisor.dispose());
  return { supervisor, runners, createdParams, logStore };
}

afterEach(async () => {
  while (disposers.length > 0) {
    await disposers.pop()?.();
  }
  vi.useRealTimers();
  clearDiscordIpBlock();
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

  it('refuses a second bot when maxBots is 1', async () => {
    const { supervisor } = makeHarness({ maxBots: 1 });

    await supervisor.startBot('bot-1', 'Bot One');
    await expect(supervisor.startBot('bot-2', 'Bot Two')).rejects.toThrow(
      /only allows 1 bot/,
    );
    expect(supervisor.runningCount).toBe(1);
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

    await vi.advanceTimersByTime(2500);

    expect(createdParams).toHaveLength(2);
    expect(runners[1].start).toHaveBeenCalledTimes(1);
    state = supervisor.getState('bot-1');
    expect(state.state).toBe('running');
  });

  it('does not schedule the auto-restart while a Discord IP block is active', async () => {
    vi.useFakeTimers();
    const { supervisor, createdParams, logStore } = makeHarness();

    await supervisor.startBot('bot-1', 'Bot One');
    armDiscordIpBlock(120);
    createdParams[0].onFatalDisconnect('Discord session invalidated');

    expect(supervisor.getState('bot-1').state).toBe('error');
    expect(supervisor.isTokenInvalid('bot-1')).toBe(false);
    await vi.advanceTimersByTime(10_000);
    expect(createdParams).toHaveLength(1);
    expect(logStore.append).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('Auto-restart deferred'),
      'bot-1',
    );
  });

  it('schedules exactly one restart after the Discord IP block expires', async () => {
    vi.useFakeTimers();
    const { supervisor, createdParams } = makeHarness();

    await supervisor.startBot('bot-1', 'Bot One');
    armDiscordIpBlock(120);
    createdParams[0].onFatalDisconnect('Discord session invalidated');

    await vi.advanceTimersByTime(119_000);
    expect(createdParams).toHaveLength(1);
    expect(supervisor.getState('bot-1').state).toBe('error');

    // 120 s de blocage + 5 s de gigue au plus.
    await vi.advanceTimersByTime(7_000);
    expect(createdParams).toHaveLength(2);
    expect(supervisor.getState('bot-1').state).toBe('running');

    await vi.advanceTimersByTime(600_000);
    expect(createdParams).toHaveLength(2);
  });

  it('keeps a bot whose start hit a Discord block restartable and never token-invalid', async () => {
    for (const kind of ['blocked', 'rate_limited'] as const) {
      const { supervisor } = makeHarness({
        nextRunner: () =>
          fakeRunner({
            start: vi.fn(async () => {
              throw new DiscordUnavailableError(kind, 4013);
            }),
          }),
      });

      await expect(supervisor.startBot('bot-1', '')).rejects.toBeInstanceOf(
        DiscordUnavailableError,
      );

      const state = supervisor.getState('bot-1');
      expect(state.state).toBe('stopped');
      expect(state.autoRestart).toBe(true);
      expect(supervisor.isTokenInvalid('bot-1')).toBe(false);
    }
  });

  it('a failed auto-restart under a block does not loop', async () => {
    vi.useFakeTimers();
    let created = 0;
    const { supervisor, createdParams } = makeHarness({
      nextRunner: () => {
        created += 1;
        return fakeRunner(
          created === 1
            ? {}
            : {
                start: vi.fn(async () => {
                  throw new DiscordUnavailableError('rate_limited', 30);
                }),
              },
        );
      },
    });

    await supervisor.startBot('bot-1', 'Bot One');
    createdParams[0].onFatalDisconnect('Discord session invalidated');
    await vi.advanceTimersByTime(60_000);

    expect(createdParams).toHaveLength(2);
  });

  it('keeps the REST counters of a bot across restarts and exposes them in its state', async () => {
    vi.useFakeTimers();
    const { supervisor, createdParams } = makeHarness();

    await supervisor.startBot('bot-1', 'Bot One');
    createdParams[0].restStats.recordInvalidResponse({
      status: 403,
      method: 'POST',
      url: 'https://discord.com/api/v10/channels/123456789012345678/messages',
    });
    expect(supervisor.getState('bot-1').discordRest?.invalid.total).toBe(1);

    // Un bot qui boucle sur ses redémarrages recrée son runner à chaque tour : les compteurs,
    // eux, appartiennent au bot et ne repartent pas de zéro.
    createdParams[0].onFatalDisconnect('Discord session invalidated');
    await vi.advanceTimersByTime(4000);

    expect(createdParams).toHaveLength(2);
    expect(createdParams[1].restStats).toBe(createdParams[0].restStats);
    const [state] = supervisor.listStates();
    expect(state.discordRest?.invalid.total).toBe(1);
    expect(state.discordRest?.invalid.topRoutes[0]).toMatchObject({
      route: 'POST /channels/:id/messages',
      status: 403,
    });
  });

  it('gives a bot that never started an empty REST snapshot rather than none', () => {
    const { supervisor } = makeHarness();
    expect(supervisor.getState('ghost').discordRest?.invalid.total).toBe(0);
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

    await vi.advanceTimersByTime(4000);
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
    await vi.advanceTimersByTime(4000);
    expect(createdParams).toHaveLength(1);
  });

  it('cancels a pending auto-restart when the bot is stopped', async () => {
    vi.useFakeTimers();
    const { supervisor, createdParams } = makeHarness();

    await supervisor.startBot('bot-1', 'Bot One');
    createdParams[0].onFatalDisconnect('Discord session invalidated');
    await supervisor.stopBot('bot-1');

    await vi.advanceTimersByTime(4000);
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

  describe('reload serialization', () => {
    function gate() {
      let open!: () => void;
      let fail!: (error: Error) => void;
      const promise = new Promise<void>((resolve, reject) => {
        open = resolve;
        fail = reject;
      });
      return { promise, open, fail };
    }

    it('waits for a start in progress instead of overlapping it', async () => {
      const startGate = gate();
      const { supervisor, runners } = makeHarness({
        nextRunner: () => fakeRunner({ start: vi.fn(() => startGate.promise) }),
      });

      const starting = supervisor.startBot('bot-1', 'Bot One');
      await Promise.resolve();
      await Promise.resolve();
      expect(supervisor.getState('bot-1').state).toBe('starting');

      let reloadDone = false;
      const reloading = supervisor.reloadBot('bot-1').then((value) => {
        reloadDone = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runners[0].reload).not.toHaveBeenCalled();
      expect(reloadDone).toBe(false);

      startGate.open();
      await starting;
      expect(await reloading).toBe(true);
      expect(runners[0].reload).toHaveBeenCalledTimes(1);
      expect(supervisor.getState('bot-1').state).toBe('running');
    });

    it('does not reload, nor mark the bot running, when the start it waited for failed', async () => {
      const startGate = gate();
      const { supervisor, runners } = makeHarness({
        nextRunner: () => fakeRunner({ start: vi.fn(() => startGate.promise) }),
      });

      const starting = supervisor.startBot('bot-1', 'Bot One').catch((e: unknown) => e);
      await Promise.resolve();
      await Promise.resolve();
      const reloading = supervisor.reloadBot('bot-1');

      startGate.fail(new Error('login failed'));
      expect(((await starting) as Error).message).toBe('login failed');
      expect(await reloading).toBe(false);
      expect(runners[0].reload).not.toHaveBeenCalled();
      expect(supervisor.getState('bot-1').state).toBe('stopped');
    });

    it('runs two reloads of the same bot one after the other', async () => {
      const first = gate();
      let active = 0;
      let maxActive = 0;
      let calls = 0;
      const { supervisor } = makeHarness({
        nextRunner: () =>
          fakeRunner({
            reload: vi.fn(async () => {
              calls += 1;
              active += 1;
              maxActive = Math.max(maxActive, active);
              if (calls === 1) await first.promise;
              active -= 1;
            }),
          }),
      });
      await supervisor.startBot('bot-1', 'Bot One');

      const a = supervisor.reloadBot('bot-1');
      const b = supervisor.reloadBot('bot-1');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(1);

      first.open();
      expect(await Promise.all([a, b])).toEqual([true, true]);
      expect(calls).toBe(2);
      expect(maxActive).toBe(1);
    });
  });

  it('drains all running bots', async () => {
    const { supervisor, runners } = makeHarness({ maxBots: 40 });

    await supervisor.startBot('bot-1', '');
    await supervisor.startBot('bot-2', '');

    const stopped = await supervisor.drainAll();
    expect(stopped).toBe(2);
    expect(runners[0].stop).toHaveBeenCalled();
    expect(runners[1].stop).toHaveBeenCalled();
    expect(supervisor.runningCount).toBe(0);
  });

  it('updates per-bot process heap metrics on the maintenance tick', async () => {
    vi.useFakeTimers();
    const { supervisor } = makeHarness({
      nextRunner: () =>
        fakeRunner({
          getGuildCount: vi.fn(() => 7),
          getHeapUsedBytes: vi.fn(() => 42_000_000),
        }),
    });

    await supervisor.startBot('bot-1', '');
    await vi.advanceTimersByTime(5000);

    const state = supervisor.getState('bot-1');
    expect(state.guildCount).toBe(7);
    expect(state.heapUsedBytes).toBe(42_000_000);
    expect(state.rssBytes).toBeNull();
  });

});
