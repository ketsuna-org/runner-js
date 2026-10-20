import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRunnerEnv } from '../src/config/env.js';
import { createHttpServer } from '../src/http/server.js';
import { LogStore } from '../src/runtime/log-store.js';
import { RuntimeController } from '../src/runtime/runtime-controller.js';
import type { CreateRunnerParams } from '../src/runtime/bot-supervisor.js';
import type { VariableDatabase } from '../src/runtime/variable-database.js';

describe('discordRest in the runner status endpoints', () => {
  let dir: string;
  let runtime: RuntimeController | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-js-rest-status-'));
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows per-bot Discord REST counters in /status, /metrics and /bots/:id/status', async () => {
    const env = {
      ...loadRunnerEnv(),
      dataDir: dir,
      logFile: path.join(dir, 'logs', 'runner.log'),
      webHost: '127.0.0.1',
      webPort: 0,
      apiToken: '',
    };
    const logStore = new LogStore(env.logFile);
    const created: CreateRunnerParams[] = [];
    runtime = new RuntimeController(dir, logStore, {} as VariableDatabase, 1, (params) => {
      created.push(params);
      return {
        start: async () => undefined,
        stop: async () => undefined,
        reload: async () => undefined,
        triggerWebhook: async () => true,
        getGuildCount: () => 0,
        getHeapUsedBytes: () => null,
      };
    });
    const app = createHttpServer({ env, runtime, logStore });
    const post = (url: string, body: unknown) =>
      app.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post('/bots/sync', { botId: 'b1', botName: 'B', config: { token: 'x', commands: [] } })).status).toBe(200);
    expect((await post('/bots/b1/start', {})).status).toBe(200);

    for (let i = 0; i < 3; i++) {
      created[0].restStats.recordInvalidResponse({
        status: 403,
        method: 'POST',
        url: 'https://discord.com/api/v10/channels/123456789012345678/messages',
      });
    }
    created[0].restStats.recordRateLimited();

    const expectCounters = (discordRest: any) => {
      expect(discordRest.invalid.window10m).toBe(3);
      expect(discordRest.invalid.byStatus).toEqual({ '401': 0, '403': 3, '429': 0 });
      expect(discordRest.invalid.topRoutes[0]).toEqual({
        route: 'POST /channels/:id/messages',
        status: 403,
        count: 3,
      });
      expect(discordRest.rateLimited).toBe(1);
      expect(discordRest.invalidRequestWarnings).toBe(0);
    };

    const status = (await (await app.request('/status')).json()) as any;
    expectCounters(status.bots.find((bot: any) => bot.botId === 'b1').discordRest);

    const metrics = (await (await app.request('/metrics')).json()) as any;
    expectCounters(metrics.bots.find((bot: any) => bot.botId === 'b1').discordRest);

    const one = (await (await app.request('/bots/b1/status')).json()) as any;
    expectCounters(one.bot.discordRest);
  });
});
