import { describe, expect, it } from 'vitest';

import { createHttpServer } from '../src/http/server.js';
import type { RuntimeController } from '../src/runtime/runtime-controller.js';
import type { LogStore } from '../src/runtime/log-store.js';
import type { RunnerEnv } from '../src/config/env.js';

describe('running-status endpoint', () => {
  it('reports connected only for bots in the process manager state map', async () => {
    const runtime = {
      listRuntimeStates: () => [
        {
          botId: 'running-bot',
          botName: 'Running Bot',
          state: 'running',
          lastSeenAt: null,
          lastError: null,
          baselineRssBytes: 12_000_000,
          heapUsedBytes: 4_000_000,
          guildCount: 2,
          pid: 4242,
        },
        {
          botId: 'stopped-bot',
          botName: 'Stopped Bot',
          state: 'stopped',
          lastSeenAt: null,
          lastError: 'fatal',
          baselineRssBytes: null,
          heapUsedBytes: null,
          guildCount: null,
          pid: null,
        },
      ],
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

    const response = await fetch(`${baseUrl}/bots/running-status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bots: {
        'running-bot': {
          connected: true,
          state: 'running',
          rssBytes: 12_000_000,
          heapUsedBytes: 4_000_000,
          guildCount: 2,
          pid: 4242,
          lastError: null,
        },
        'stopped-bot': {
          connected: false,
          state: 'stopped',
          rssBytes: null,
          heapUsedBytes: null,
          guildCount: null,
          pid: null,
          lastError: 'fatal',
        },
      },
    });

    await app.close();
  });

  it('reports metrics for error-state bots in running-status', async () => {
    const runtime = {
      listRuntimeStates: () => [
        {
          botId: 'error-bot',
          botName: 'Error Bot',
          state: 'error',
          lastSeenAt: null,
          lastError: 'Disallowed intents (4014)',
          baselineRssBytes: 8_000_000,
          heapUsedBytes: 2_000_000,
          guildCount: 0,
          pid: 4242,
        },
      ],
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

    const response = await fetch(`${baseUrl}/bots/running-status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bots: {
        'error-bot': {
          connected: false,
          state: 'error',
          rssBytes: 8_000_000,
          heapUsedBytes: 2_000_000,
          guildCount: 0,
          pid: 4242,
          lastError: 'Disallowed intents (4014)',
        },
      },
    });

    await app.close();
  });
});
