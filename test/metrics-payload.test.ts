import { describe, expect, it } from 'vitest';

import { createHttpServer } from '../src/http/server.js';
import type { RuntimeController } from '../src/runtime/runtime-controller.js';
import type { LogStore } from '../src/runtime/log-store.js';
import type { RunnerEnv } from '../src/config/env.js';

describe('metrics payload', () => {
  it('keeps the apiVersion 2 shape with process RSS as the total', async () => {
    // Single-process runner: bots have no dedicated processes, so per-bot RSS
    // is null and the worker aggregate is 0; per-bot heapUsedBytes comes from
    // the bot's isolate.
    const runtime = {
      isRunning: true,
      runningCount: 2,
      listRuntimeStates: () => [
        {
          botId: 'bot-a',
          botName: 'Bot A',
          state: 'running',
          lastSeenAt: null,
          lastError: null,
          baselineRssBytes: null,
          heapUsedBytes: 20_000_000,
          guildCount: 3,
          pid: null,
        },
        {
          botId: 'bot-b',
          botName: 'Bot B',
          state: 'running',
          lastSeenAt: null,
          lastError: null,
          baselineRssBytes: null,
          heapUsedBytes: 10_000_000,
          guildCount: 1,
          pid: null,
        },
      ],
      aggregateWorkerRssBytes: () => 0,
    } as unknown as RuntimeController;

    const env = {
      version: 'test',
      apiToken: '',
      webHost: '127.0.0.1',
    } as RunnerEnv;

    const app = createHttpServer({
      env,
      runtime,
      logStore: { tail: () => [], tailForBot: () => [] } as unknown as LogStore,
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      apiVersion: number;
      totalWorkerRssBytes: number;
      mainRssBytes: number;
      rssBytes: number;
      bots: Array<{ heapUsedBytes: number | null }>;
    };
    expect(body.apiVersion).toBe(2);
    expect(body.totalWorkerRssBytes).toBe(0);
    expect(body.mainRssBytes).toBeGreaterThan(0);
    expect(body.rssBytes).toBe(body.mainRssBytes);
    expect(body.bots).toHaveLength(2);
    expect(body.bots[0].heapUsedBytes).toBe(20_000_000);

    await app.close();
  });
});
