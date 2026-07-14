import { describe, expect, it } from 'vitest';

import { createHttpServer } from '../src/http/server.js';
import type { RuntimeController } from '../src/runtime/runtime-controller.js';
import type { LogStore } from '../src/runtime/log-store.js';
import type { RunnerEnv } from '../src/config/env.js';

describe('metrics payload', () => {
  it('aggregates main and worker RSS bytes', async () => {
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
          baselineRssBytes: 50_000_000,
          heapUsedBytes: 20_000_000,
          guildCount: 3,
          pid: 1001,
        },
        {
          botId: 'bot-b',
          botName: 'Bot B',
          state: 'running',
          lastSeenAt: null,
          lastError: null,
          baselineRssBytes: 30_000_000,
          heapUsedBytes: 10_000_000,
          guildCount: 1,
          pid: 1002,
        },
      ],
      aggregateWorkerRssBytes: () => 80_000_000,
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
      totalWorkerRssBytes: number;
      mainRssBytes: number;
      rssBytes: number;
      bots: unknown[];
    };
    expect(body.totalWorkerRssBytes).toBe(80_000_000);
    expect(body.mainRssBytes).toBeGreaterThan(0);
    expect(body.rssBytes).toBe(body.mainRssBytes + body.totalWorkerRssBytes);
    expect(body.bots).toHaveLength(2);

    await app.close();
  });
});
