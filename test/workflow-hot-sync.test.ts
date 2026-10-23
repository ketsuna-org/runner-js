import { afterEach, describe, expect, it, setSystemTime, vi } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Client } from 'discord.js';

import type { RunnerEnv } from '../src/config/env.js';
import { loadRunnerEnv } from '../src/config/env.js';
import type { JsBotConfig } from '../src/config/js-bot-config.js';
import { parseJsBotConfig } from '../src/config/js-bot-config.js';
import { HandlerRegistry } from '../src/discord/handler-registry.js';
import { createHttpServer } from '../src/http/server.js';
import type { BotRunnerHandle } from '../src/runtime/bot-supervisor.js';
import { LogStore } from '../src/runtime/log-store.js';
import { RuntimeController } from '../src/runtime/runtime-controller.js';
import type { ScheduledSnapshot } from '../src/runtime/scheduled-tasks.js';
import type { ScriptExecutor } from '../src/scripts/script-executor.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';
import {
  applyWorkflowToConfig,
  removeWorkflowFromConfig,
} from '../src/runtime/workflow-projection.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function fakeRunner(): BotRunnerHandle & {
  reload: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    reload: vi.fn(async (_config: JsBotConfig) => undefined),
    triggerWebhook: vi.fn(async () => true),
    getGuildCount: vi.fn(() => 1),
    getHeapUsedBytes: vi.fn(() => null),
  };
}

async function harness(apiToken = '') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-hot-sync-'));
  const env = {
    ...loadRunnerEnv(),
    dataDir: dir,
    logFile: path.join(dir, 'logs', 'runner.log'),
    webHost: '127.0.0.1',
    webPort: 0,
    apiToken,
  } as RunnerEnv;
  const runners: ReturnType<typeof fakeRunner>[] = [];
  const logStore = new LogStore(env.logFile);
  const runtime = new RuntimeController(dir, logStore, {} as VariableDatabase, 4, () => {
    const runner = fakeRunner();
    runners.push(runner);
    return runner;
  });
  const app = createHttpServer({ env, runtime, logStore });
  cleanups.push(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const syncBot = async (botId: string, config: Record<string, unknown> = {}) => {
    const response = await post('/bots/sync', {
      botId,
      botName: botId,
      config: { token: 'test-token', ...config },
    });
    expect(response.status).toBe(200);
  };
  const stored = async (botId: string) => (await runtime.botStore.load(botId))!.config;
  return { app, runtime, runners, post, syncBot, stored };
}

const eventWorkflow = (script = 'ready();') => ({
  name: 'welcome',
  workflowType: 'event',
  eventTrigger: { event: 'guildMemberAdd' },
  jsScriptContent: script,
});

describe('POST /bots/:id/workflows/sync', () => {
  it('is registered: a bad payload answers 400, not the router 404', async () => {
    const { post, syncBot } = await harness();
    await syncBot('b1');

    for (const body of [
      '{not json',
      {},
      { workflowName: 'welcome' },
      { workflowName: 'welcome', workflow: 'oops' },
      { workflowName: 'welcome', workflow: [] },
      { workflow: { workflowType: 'event' } },
      { workflowName: '   ', workflow: {} },
    ]) {
      const response = await post('/bots/b1/workflows/sync', body);
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error');
    }
  });

  it('requires the bearer token like the neighbouring routes', async () => {
    const { post } = await harness('secret-token');
    const auth = { authorization: 'Bearer secret-token' };
    const sync = await post(
      '/bots/sync',
      { botId: 'b1', botName: 'b1', config: { token: 'x' } },
      auth,
    );
    expect(sync.status).toBe(200);

    const body = { workflowName: 'welcome', workflow: eventWorkflow() };
    expect((await post('/bots/b1/workflows/sync', body)).status).toBe(401);
    expect((await post('/bots/b1/workflows/delete', { workflowName: 'welcome' })).status).toBe(401);
    expect((await post('/bots/b1/workflows/sync', body, auth)).status).toBe(200);
    expect((await post('/bots/b1/workflows/delete', { workflowName: 'welcome' }, auth)).status).toBe(
      200,
    );
  });

  it('answers 404 for a bot this runner does not hold (the Manager then falls back to a full sync)', async () => {
    const { post } = await harness();
    const response = await post('/bots/ghost/workflows/sync', {
      workflowName: 'welcome',
      workflow: eventWorkflow(),
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain('not found');

    const removal = await post('/bots/ghost/workflows/delete', { workflowName: 'welcome' });
    expect(removal.status).toBe(404);
  });

  it('persists an event workflow for a stopped bot and reports running=false', async () => {
    const { post, syncBot, stored, runners } = await harness();
    await syncBot('b1');

    const response = await post('/bots/b1/workflows/sync', {
      workflowName: 'welcome',
      workflow: eventWorkflow(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      botId: 'b1',
      workflowName: 'welcome',
      running: false,
    });
    expect((await stored('b1')).events).toEqual([
      { id: 'welcome', type: 'event', name: 'guildMemberAdd', enabled: true, script: 'ready();' },
    ]);
    expect(runners).toHaveLength(0);
  });

  it('mounts the event workflow in a running bot through a reload, without restarting it', async () => {
    const { post, syncBot, runtime, runners } = await harness();
    await syncBot('b1');
    await runtime.startBot('b1');
    expect(runners).toHaveLength(1);
    const runner = runners[0]!;
    expect(runner.start).toHaveBeenCalledTimes(1);

    const response = await post('/bots/b1/workflows/sync', {
      workflowName: 'welcome',
      workflow: eventWorkflow('hello();'),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { running: boolean }).running).toBe(true);

    expect(runner.reload).toHaveBeenCalledTimes(1);
    const reloaded = runner.reload.mock.calls[0]![0] as JsBotConfig;
    expect(reloaded.events.map((event) => [event.id, event.name, event.script])).toEqual([
      ['welcome', 'guildMemberAdd', 'hello();'],
    ]);
    expect(reloaded.token).toBe('test-token');
    // Pas de redémarrage : même runner, un seul start, aucun stop.
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(runner.stop).not.toHaveBeenCalled();
    expect(runners).toHaveLength(1);
  });

  it('replaces an edited workflow in place instead of duplicating it', async () => {
    const { post, syncBot, runtime, runners, stored } = await harness();
    await syncBot('b1', {
      events: [
        { id: 'other', name: 'ready', script: 'keep();' },
        { id: 'welcome', name: 'guildMemberAdd', script: 'old();' },
      ],
    });
    await runtime.startBot('b1');

    await post('/bots/b1/workflows/sync', {
      workflowName: 'Welcome',
      workflow: eventWorkflow('new();'),
    });

    const events = (await stored('b1')).events;
    expect(events.map((event) => [event.id, event.script])).toEqual([
      ['other', 'keep();'],
      ['welcome', 'new();'],
    ]);
    expect(runners[0]!.reload).toHaveBeenCalledTimes(1);
  });

  it('refreshes the script of the scheduled entries that name the workflow', async () => {
    const { post, syncBot, stored } = await harness();
    await syncBot('b1', {
      scheduled: [
        { id: 't1', name: 'tick', everyMinutes: 5, script: 'old();' },
        { id: 't2', name: 'other', everyMinutes: 5, script: 'untouched();' },
      ],
    });

    await post('/bots/b1/workflows/sync', {
      workflowName: 'tick',
      workflow: { name: 'tick', workflowType: 'general', jsScriptContent: 'new();' },
    });

    expect((await stored('b1')).scheduled.map((entry) => [entry.id, entry.script])).toEqual([
      ['t1', 'new();'],
      ['t2', 'untouched();'],
    ]);
  });

  it('keeps cron, timezone, runOnStart, timeoutMs and the interval of a scheduled entry: only the script changes', async () => {
    const { post, syncBot, runtime, runners, stored } = await harness();
    const cronEntry = {
      id: 'daily',
      name: 'tick',
      cron: '0 9 * * 1-5',
      timezone: 'Europe/Paris',
      runOnStart: true,
      timeoutMs: 5000,
      everyMinutes: 10080,
      script: 'old();',
    };
    await syncBot('b1', { scheduled: [cronEntry] });
    await runtime.startBot('b1');

    const response = await post('/bots/b1/workflows/sync', {
      workflowName: 'tick',
      workflow: { name: 'tick', workflowType: 'general', jsScriptContent: 'new();' },
    });
    expect(response.status).toBe(200);

    expect((await stored('b1')).scheduled).toEqual([{ ...cronEntry, type: 'scheduled', enabled: true, script: 'new();' }]);
    const reloaded = runners[0]!.reload.mock.calls[0]![0] as JsBotConfig;
    expect(reloaded.scheduled[0]).toMatchObject({
      cron: '0 9 * * 1-5',
      timezone: 'Europe/Paris',
      runOnStart: true,
      timeoutMs: 5000,
      everyMinutes: 10080,
      script: 'new();',
    });
  });
});

describe('GET /bots/:id/status : tâches planifiées', () => {
  const snapshot: ScheduledSnapshot = {
    running: 0,
    maxConcurrent: 3,
    tasks: [
      {
        id: 'daily',
        kind: 'cron',
        schedule: 'cron "0 9 * * *" (Europe/Paris)',
        nextRunAt: '2026-03-11T08:00:00.000Z',
        lastRunAt: '2026-03-10T08:00:00.000Z',
        lastOk: true,
        lastDurationMs: 12,
        lastError: null,
        running: false,
        runs: 1,
        failures: 0,
        skippedOverlap: 0,
        skippedNotReady: 0,
        skippedConcurrency: 0,
      },
    ],
    ignored: [{ id: 'bad', reason: 'no valid schedule' }],
  };

  it('exposes the scheduler snapshot of a running bot (next run, last result) for bot_diagnose', async () => {
    const { app, syncBot, runtime, runners } = await harness();
    await syncBot('b1');
    await runtime.startBot('b1');
    runners[0]!.getScheduledSnapshot = vi.fn(() => snapshot);

    const body = (await (await app.request('/bots/b1/status')).json()) as {
      bot: { state: string; scheduled?: ScheduledSnapshot };
    };
    expect(body.bot.state).toBe('running');
    expect(body.bot.scheduled).toEqual(snapshot);

    // Les listes (/status) restent légères : le détail des tâches n'y figure pas.
    const list = (await (await app.request('/status')).json()) as { bots: Array<Record<string, unknown>> };
    expect(list.bots[0]).not.toHaveProperty('scheduled');
  });

  it('omits it for a stopped bot and for a runner that has no scheduler', async () => {
    const { app, syncBot, runtime } = await harness();
    await syncBot('b1');
    expect(((await (await app.request('/bots/b1/status')).json()) as { bot: object }).bot).not.toHaveProperty(
      'scheduled',
    );

    await runtime.startBot('b1');
    expect(((await (await app.request('/bots/b1/status')).json()) as { bot: object }).bot).not.toHaveProperty(
      'scheduled',
    );
  });
});

describe('RuntimeController : dossier d’état des runners', () => {
  it('transmet à chaque runner un dossier d’état sous le dossier de données (marqueurs de runOnStart)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-state-'));
    const seen: Array<string | undefined> = [];
    const runtime = new RuntimeController(
      dir,
      new LogStore(path.join(dir, 'logs', 'runner.log')),
      {} as VariableDatabase,
      4,
      (params) => {
        seen.push(params.stateDir);
        return fakeRunner();
      },
    );
    cleanups.push(async () => {
      await runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    });
    await runtime.syncBot('b1', 'b1', { token: 'test-token' });
    await runtime.startBot('b1');

    expect(seen).toEqual([path.join(dir, 'run-state')]);
  });
});

describe('hot-sync d’une tâche planifiée dans un bot qui tourne', () => {
  afterEach(() => {
    if (vi.isFakeTimers()) vi.clearAllTimers();
    vi.useRealTimers();
    setSystemTime();
  });

  it('ne remplace que le script : le timer n’est pas ré-armé, le nouveau script part à l’échéance suivante', async () => {
    vi.useFakeTimers();
    setSystemTime(new Date('2026-03-10T00:07:00Z'));
    const executed: string[] = [];
    const registry = new HandlerRegistry(
      new EventEmitter() as unknown as Client,
      parseJsBotConfig({
        token: 'x',
        scheduled: [
          { id: 'daily', name: 'tick', cron: '0 * * * *', timezone: 'Europe/Paris', script: 'old();' },
        ],
      }),
      'bot-1',
      { execute: async (script: string) => void executed.push(script) } as unknown as ScriptExecutor,
      { getGlobalVariables: async () => ({}) } as VariableDatabase,
      () => undefined,
    );
    registry.mount();
    const before = registry.getScheduler().snapshot().tasks[0]!;
    expect(vi.getTimerCount()).toBe(1);

    const next = applyWorkflowToConfig(parseJsBotConfig({ token: 'x', scheduled: [
      { id: 'daily', name: 'tick', cron: '0 * * * *', timezone: 'Europe/Paris', script: 'old();' },
    ] }), 'tick', { name: 'tick', workflowType: 'general', jsScriptContent: 'new();' });
    registry.updateConfig(next);

    const after = registry.getScheduler().snapshot().tasks[0]!;
    expect(after.nextRunAt).toBe(before.nextRunAt);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(60 * 60_000);
    for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
    expect(executed).toEqual(['new();']);
    registry.clear();
  });
});

describe('bots with inbound webhooks', () => {
  const webhook = { id: 'hook', path: '/hook', secret: 's3cret', script: 'old();' };
  const general = { name: 'tick', workflowType: 'general', jsScriptContent: 'new();' };

  it('refuses (501) a sync it could not apply to the webhooks, and writes and reloads nothing', async () => {
    const { post, syncBot, runtime, runners, stored } = await harness();
    await syncBot('b1', { inboundWebhooks: [webhook] });
    await runtime.startBot('b1');

    const response = await post('/bots/b1/workflows/sync', { workflowName: 'tick', workflow: general });
    expect(response.status).toBe(501);
    expect((await stored('b1')).inboundWebhooks.map((entry) => entry.script)).toEqual(['old();']);
    expect(runners[0]!.reload).not.toHaveBeenCalled();
  });

  it('refuses (501) a delete of a workflow it cannot prove is an event workflow', async () => {
    const { post, syncBot, runtime, runners } = await harness();
    await syncBot('b1', { inboundWebhooks: [webhook] });
    await runtime.startBot('b1');

    const response = await post('/bots/b1/workflows/delete', { workflowName: 'tick' });
    expect(response.status).toBe(501);
    expect(runners[0]!.reload).not.toHaveBeenCalled();
  });

  it('still hot-syncs event workflows, which webhooks never run', async () => {
    const { post, syncBot, stored } = await harness();
    await syncBot('b1', {
      inboundWebhooks: [webhook],
      events: [{ id: 'welcome', name: 'guildMemberAdd', script: 'old();' }],
    });

    expect(
      (await post('/bots/b1/workflows/sync', { workflowName: 'welcome', workflow: eventWorkflow('x();') }))
        .status,
    ).toBe(200);
    expect(
      (await post('/bots/b1/workflows/delete', { workflowName: 'welcome' })).status,
    ).toBe(200);
    expect((await stored('b1')).events).toEqual([]);
  });
});

describe('POST /bots/:id/workflows/delete', () => {
  it('rejects a missing workflow name with 400', async () => {
    const { post, syncBot } = await harness();
    await syncBot('b1');
    for (const body of ['{not json', {}, { workflowName: '  ' }, { workflowName: 3 }]) {
      expect((await post('/bots/b1/workflows/delete', body)).status).toBe(400);
    }
  });

  it('removes the workflow and reloads the running bot', async () => {
    const { post, syncBot, runtime, runners, stored } = await harness();
    await syncBot('b1', {
      events: [
        { id: 'welcome', name: 'guildMemberAdd', script: 'old();' },
        { id: 'other', name: 'ready', script: 'keep();' },
      ],
    });
    await runtime.startBot('b1');

    const response = await post('/bots/b1/workflows/delete', { workflowName: 'welcome' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      botId: 'b1',
      workflowName: 'welcome',
      running: true,
    });
    expect((await stored('b1')).events.map((event) => event.id)).toEqual(['other']);
    const reloaded = runners[0]!.reload.mock.calls[0]![0] as JsBotConfig;
    expect(reloaded.events.map((event) => event.id)).toEqual(['other']);
    expect(runners[0]!.stop).not.toHaveBeenCalled();
  });

  it('is idempotent for an unknown workflow', async () => {
    const { post, syncBot, stored } = await harness();
    await syncBot('b1', { events: [{ id: 'other', name: 'ready', script: 'keep();' }] });
    const response = await post('/bots/b1/workflows/delete', { workflowName: 'never-existed' });
    expect(response.status).toBe(200);
    expect((await stored('b1')).events.map((event) => event.id)).toEqual(['other']);
  });
});

describe('workflow projection', () => {
  const base = (): JsBotConfig => parseJsBotConfig({ token: 'x' });

  it('mirrors the Manager full sync: only event workflows with an event and a script become handlers', () => {
    const cases: Array<[string, Record<string, unknown>, number]> = [
      ['event', eventWorkflow(), 1],
      ['listenFor alias', { ...eventWorkflow(), eventTrigger: { listenFor: 'messageCreate' } }, 1],
      ['general workflow', { ...eventWorkflow(), workflowType: 'general' }, 0],
      ['blocks workflow without a script', { ...eventWorkflow(), jsScriptContent: '  ' }, 0],
      ['no event', { ...eventWorkflow(), eventTrigger: {} }, 0],
    ];
    for (const [label, workflow, expected] of cases) {
      const next = applyWorkflowToConfig(base(), 'welcome', workflow);
      expect([label, next.events.length]).toEqual([label, expected]);
    }
  });

  it('drops the previous handler when the workflow stops qualifying', () => {
    const config = applyWorkflowToConfig(base(), 'welcome', eventWorkflow());
    expect(config.events).toHaveLength(1);
    const next = applyWorkflowToConfig(config, 'welcome', { ...eventWorkflow(), jsScriptContent: '' });
    expect(next.events).toHaveLength(0);
  });

  it('removes scheduled entries of a deleted workflow, as a full sync would skip them', () => {
    const config = parseJsBotConfig({
      token: 'x',
      scheduled: [{ id: 't1', name: 'tick', everyMinutes: 5, script: 'a();' }],
    });
    expect(removeWorkflowFromConfig(config, 'TICK').scheduled).toEqual([]);
  });

  it('never produces a duplicate handler id when workflow.name differs from the route key', () => {
    const config = parseJsBotConfig({
      token: 'x',
      events: [
        { id: 'welcome', name: 'ready', script: 'a();' },
        { id: 'Welcome 2', name: 'ready', script: 'b();' },
      ],
    });
    const next = applyWorkflowToConfig(config, 'welcome', { ...eventWorkflow(), name: 'Welcome 2' });
    expect(next.events.map((event) => event.id)).toEqual(['Welcome 2']);
  });

  it('names the handler after its event when the workflow has no name, as the Manager does', () => {
    const next = applyWorkflowToConfig(base(), 'welcome', { ...eventWorkflow(), name: '' });
    expect(next.events.map((event) => [event.id, event.name])).toEqual([
      ['guildMemberAdd', 'guildMemberAdd'],
    ]);
  });

  it('keeps every other field of a scheduled entry (cron, timezone, runOnStart, timeoutMs, everyMinutes) and replaces only the script', () => {
    const config = parseJsBotConfig({
      token: 'x',
      scheduled: [
        {
          id: 't1',
          name: 'tick',
          cron: '30 2 * * *',
          timezone: 'America/New_York',
          runOnStart: true,
          timeoutMs: 1234,
          everyMinutes: 10080,
          script: 'a();',
        },
        { id: 't2', name: 'other', cron: '@hourly', script: 'keep();' },
      ],
    });
    const next = applyWorkflowToConfig(config, 'tick', {
      name: 'tick',
      workflowType: 'general',
      jsScriptContent: 'b();',
    });
    expect(next.scheduled).toEqual([{ ...config.scheduled[0]!, script: 'b();' }, config.scheduled[1]!]);
  });

  it('does not mutate its input', () => {
    const config = applyWorkflowToConfig(base(), 'welcome', eventWorkflow('a();'));
    const snapshot = JSON.stringify(config);
    applyWorkflowToConfig(config, 'welcome', eventWorkflow('b();'));
    removeWorkflowFromConfig(config, 'welcome');
    expect(JSON.stringify(config)).toBe(snapshot);
  });
});
