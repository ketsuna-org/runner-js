import { describe, expect, it } from 'vitest';

import { createHttpServer } from '../src/http/server.js';
import { loadRunnerEnv } from '../src/config/env.js';
import { LogStore } from '../src/runtime/log-store.js';
import { RuntimeController } from '../src/runtime/runtime-controller.js';

describe('HTTP server integration', () => {
  it('serves health and syncs a bot config', async () => {
    const dataDir = './data/test-http-bots';
    const logFile = './data/test-http/logs/runner.log';
    const env = {
      ...loadRunnerEnv(),
      dataDir,
      logFile,
      webHost: '127.0.0.1',
      webPort: 0,
      apiToken: '',
    };

    const logStore = new LogStore(env.logFile);
    const runtime = new RuntimeController(env.dataDir, logStore);
    const app = createHttpServer({ env, runtime, logStore });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const info = await fetch(`${baseUrl}/`);
    expect(info.status).toBe(200);
    const infoBody = (await info.json()) as { engine?: string };
    expect(infoBody.engine).toBe('javascript');

    const syncResponse = await fetch(`${baseUrl}/bots/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        botId: 'http-bot',
        botName: 'HTTP Bot',
        config: {
          token: 'test-token',
          commands: [],
        },
      }),
    });

    expect(syncResponse.status).toBe(200);
    expect(await syncResponse.json()).toEqual({ ok: true });

    const bots = await fetch(`${baseUrl}/bots`);
    expect(bots.status).toBe(200);
    const botsBody = (await bots.json()) as { bots: Array<{ id: string }> };
    expect(botsBody.bots.some((bot) => bot.id === 'http-bot')).toBe(true);

    logStore.append('info', 'hello from bot', 'http-bot');

    const botLogs = await fetch(`${baseUrl}/bots/http-bot/logs?limit=10`);
    expect(botLogs.status).toBe(200);
    const botLogsBody = (await botLogs.json()) as { lines: string[] };
    expect(botLogsBody.lines.some((line) => line.includes('hello from bot'))).toBe(true);

    const botMetrics = await fetch(`${baseUrl}/bots/http-bot/metrics`);
    expect(botMetrics.status).toBe(200);
    const botMetricsBody = (await botMetrics.json()) as { bots: Array<{ botId: string }> };
    expect(botMetricsBody.bots).toHaveLength(1);
    expect(botMetricsBody.bots[0]?.botId).toBe('http-bot');

    const botStatus = await fetch(`${baseUrl}/bots/http-bot/status`);
    expect(botStatus.status).toBe(200);
    const botStatusBody = (await botStatus.json()) as { bot: { botId: string } };
    expect(botStatusBody.bot.botId).toBe('http-bot');

    await app.close();
    await runtime.dispose();
  });
});
