import { describe, expect, it } from 'vitest';

import { createHttpServer } from '../src/http/server.js';
import type { RuntimeController } from '../src/runtime/runtime-controller.js';
import type { LogStore } from '../src/runtime/log-store.js';
import type { RunnerEnv } from '../src/config/env.js';

describe('running-status endpoint', () => {
  it('reports connected only for bots in the supervisor state map', async () => {
    // Single-process runner: per-bot rssBytes/pid are null; heapUsedBytes
    // reflects the bot's isolate heap.
    const runtime = {
      listRuntimeStates: () => [
        {
          botId: 'running-bot',
          botName: 'Running Bot',
          state: 'running',
          lastSeenAt: null,
          lastError: null,
          baselineRssBytes: null,
          heapUsedBytes: 4_000_000,
          guildCount: 2,
          pid: null,
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
          rssBytes: null,
          heapUsedBytes: 4_000_000,
          guildCount: 2,
          pid: null,
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
          baselineRssBytes: null,
          heapUsedBytes: 2_000_000,
          guildCount: 0,
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
        'error-bot': {
          connected: false,
          state: 'error',
          rssBytes: null,
          heapUsedBytes: 2_000_000,
          guildCount: 0,
          pid: null,
          lastError: 'Disallowed intents (4014)',
        },
      },
    });

    await app.close();
  });
});
