import { describe, expect, it } from 'bun:test';

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
    const runtime = await RuntimeController.create(env.dataDir, logStore, env);
    const app = createHttpServer({ env, runtime, logStore });

    const health = await app.request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      version: env.version,
      engine: 'javascript',
      runtime: 'bun',
    });

    const info = await app.request('/');
    expect(info.status).toBe(200);
    const infoBody = (await info.json()) as { engine?: string };
    expect(infoBody.engine).toBe('javascript');

    const syncResponse = await app.request('/bots/sync', {
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

    const bots = await app.request('/bots');
    expect(bots.status).toBe(200);
    const botsBody = (await bots.json()) as { bots: Array<{ id: string }> };
    expect(botsBody.bots.some((bot) => bot.id === 'http-bot')).toBe(true);

    logStore.append('info', 'hello from bot', 'http-bot');

    const botLogs = await app.request('/bots/http-bot/logs?limit=10');
    expect(botLogs.status).toBe(200);
    const botLogsBody = (await botLogs.json()) as { lines: string[] };
    expect(botLogsBody.lines.some((line) => line.includes('hello from bot'))).toBe(true);

    const botMetrics = await app.request('/bots/http-bot/metrics');
    expect(botMetrics.status).toBe(200);
    const botMetricsBody = (await botMetrics.json()) as { bots: Array<{ botId: string }> };
    expect(botMetricsBody.bots).toHaveLength(1);
    expect(botMetricsBody.bots[0]?.botId).toBe('http-bot');

    const botStatus = await app.request('/bots/http-bot/status');
    expect(botStatus.status).toBe(200);
    const botStatusBody = (await botStatus.json()) as { bot: { botId: string } };
    expect(botStatusBody.bot.botId).toBe('http-bot');

    const runningStatus = await app.request('/bots/running-status');
    expect(runningStatus.status).toBe(200);
    const runningStatusBody = (await runningStatus.json()) as {
      bots: Record<string, { connected: boolean; state: string }>;
    };
    expect(runningStatusBody.bots).toEqual({});
    expect(runningStatusBody.bots['http-bot']).toBeUndefined();

    await runtime.dispose();
  });

  it('supports variable endpoints for global and scoped data', async () => {
    const dataDir = './data/test-http-variables';
    const logFile = './data/test-http-variables/logs/runner.log';
    const env = {
      ...loadRunnerEnv(),
      dataDir,
      logFile,
      webHost: '127.0.0.1',
      webPort: 0,
      apiToken: '',
    };

    const logStore = new LogStore(env.logFile);
    const runtime = await RuntimeController.create(env.dataDir, logStore, env);
    const app = createHttpServer({ env, runtime, logStore });
    const botId = 'bot-variables';

    const syncResponse = await app.request('/bots/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        botId,
        botName: 'Variables Bot',
        config: {
          token: 'test-token',
          globalVariables: { foo: 'bar' },
          scopedVariableDefinitions: [
            {
              scope: 'user',
              key: 'coins',
              defaultValue: 0,
              valueType: 'number',
            },
          ],
        },
      }),
    });
    expect(syncResponse.status).toBe(200);

    const globals = await app.request(`/bots/${botId}/variables/global`);
    expect(globals.status).toBe(200);
    const globalsBody = (await globals.json()) as { variables: Record<string, unknown> };
    expect(globalsBody.variables.foo).toBe('bar');

    const setGlobal = await app.request(`/bots/${botId}/variables/global/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'hello', value: 42 }),
    });
    expect(setGlobal.status).toBe(200);

    const globalsAfterSet = await app.request(`/bots/${botId}/variables/global`);
    const globalsAfterSetBody = (await globalsAfterSet.json()) as {
      variables: Record<string, unknown>;
    };
    expect(globalsAfterSetBody.variables.hello).toBe(42);

    const defs = await app.request(`/bots/${botId}/variables/scoped-definitions`);
    expect(defs.status).toBe(200);
    const defsBody = (await defs.json()) as { definitions: unknown[] };
    expect(defsBody.definitions).toHaveLength(1);

    await runtime.variableStore.setScopedVariable(botId, 'user', 'u1', 'coins', 99);

    const scopedValues = await app.request(
      `/bots/${botId}/variables/scoped-values?scope=user&key=coins`,
    );
    expect(scopedValues.status).toBe(200);
    const scopedValuesBody = (await scopedValues.json()) as {
      values: Record<string, unknown>;
    };
    expect(scopedValuesBody.values.u1).toBe(99);

    const setScoped = await app.request(`/bots/${botId}/variables/scoped-values/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        key: 'coins',
        contextId: 'u2',
        value: 12,
      }),
    });
    expect(setScoped.status).toBe(200);

    const scopedAfterSet = await app.request(
      `/bots/${botId}/variables/scoped-values?scope=user&key=coins`,
    );
    const scopedAfterSetBody = (await scopedAfterSet.json()) as {
      values: Record<string, unknown>;
    };
    expect(scopedAfterSetBody.values.u2).toBe(12);

    // Test Manager rehydration format: scope_id & scope_aux_id on /scoped-values/set and /scoped/set
    const setScopedGuildMember = await app.request(`/bots/${botId}/variables/scoped-values/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'guildMember',
        key: 'xp',
        scope_id: 'guild-1',
        scope_aux_id: 'user-1',
        value: 100,
      }),
    });
    expect(setScopedGuildMember.status).toBe(200);

    const setScopedAlias = await app.request(`/bots/${botId}/variables/scoped/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'guildMember',
        key: 'xp',
        scope_id: 'guild-1',
        scope_aux_id: 'user-2',
        value: 200,
      }),
    });
    expect(setScopedAlias.status).toBe(200);

    const scopedGuildMember = await app.request(
      `/bots/${botId}/variables/scoped-values?scope=guildMember&key=xp`,
    );
    expect(scopedGuildMember.status).toBe(200);
    const scopedGuildMemberBody = (await scopedGuildMember.json()) as {
      values: Record<string, unknown>;
    };
    expect(scopedGuildMemberBody.values['guild-1:user-1']).toBe(100);
    expect(scopedGuildMemberBody.values['guild-1:user-2']).toBe(200);

    const poolConfig = await app.request('/pool/config');
    expect(poolConfig.status).toBe(200);

    const patchPool = await app.request('/pool/config', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_bots: 25 }),
    });
    expect(patchPool.status).toBe(200);
    const patchPoolBody = (await patchPool.json()) as { max_bots: number };
    expect(patchPoolBody.max_bots).toBe(25);

    await runtime.dispose();
  });

  it('supports command delta sync and delete', async () => {
    const dataDir = './data/test-http-commands';
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
    const runtime = await RuntimeController.create(env.dataDir, logStore, env);
    const app = createHttpServer({ env, runtime, logStore });

    const botId = 'cmd-delta-bot';
    await app.request('/bots/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        botId,
        botName: 'Command Delta Bot',
        config: {
          token: 'test-token',
          commands: [],
        },
      }),
    });

    // 1. Sync a new command
    const syncCmdRes = await app.request(`/bots/${botId}/commands/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: 'cmd-ping',
        command: {
          id: 'cmd-ping',
          name: 'ping',
          description: 'Ping pong command',
          script: 'reply("pong");',
        },
      }),
    });
    expect(syncCmdRes.status).toBe(200);
    const syncCmdBody = (await syncCmdRes.json()) as { ok: boolean; commandId: string };
    expect(syncCmdBody.ok).toBe(true);
    expect(syncCmdBody.commandId).toBe('cmd-ping');

    // Verify command is in bot config
    const entryAfterSync = await runtime.botStore.load(botId);
    expect(entryAfterSync?.config.commands?.length).toBe(1);
    expect(entryAfterSync?.config.commands?.[0].name).toBe('ping');

    // 2. Delete the command
    const delCmdRes = await app.request(`/bots/${botId}/commands/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: 'cmd-ping',
      }),
    });
    expect(delCmdRes.status).toBe(200);
    const delCmdBody = (await delCmdRes.json()) as { ok: boolean; commandId: string };
    expect(delCmdBody.ok).toBe(true);

    const entryAfterDel = await runtime.botStore.load(botId);
    expect(entryAfterDel?.config.commands?.length).toBe(0);

    await runtime.dispose();
  });

  // Le secret du webhook est le SEUL contrôle d'accès de cette route : `auth.ts`
  // saute volontairement le jeton Bearer pour /inbound/. Sans secret, la route
  // était donc OUVERTE — et cette configuration s'atteint toute seule, puisque
  // `bot-store.ts` retire les secrets du fichier de config sur disque (un runner
  // redémarré et pas encore re-poussé porte un secret vide).
  it('refuses an inbound webhook without a secret, and checks the secret otherwise', async () => {
    const env = {
      ...loadRunnerEnv(),
      dataDir: './data/test-http-inbound',
      logFile: './data/test-http-inbound/logs/runner.log',
      webHost: '127.0.0.1',
      webPort: 0,
      apiToken: '',
    };

    const logStore = new LogStore(env.logFile);
    const runtime = await RuntimeController.create(env.dataDir, logStore, env);
    const app = createHttpServer({ env, runtime, logStore });

    const sync = await app.request('/bots/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        botId: 'inbound-bot',
        botName: 'Inbound Bot',
        config: {
          token: 'test-token',
          commands: [],
          inboundWebhooks: [
            { id: 'wh_open', path: 'sans-secret', secret: '', script: 'console.log(1);' },
            { id: 'wh_secret', path: 'avec-secret', secret: 's3cret', script: 'console.log(1);' },
          ],
        },
      }),
    });
    expect(sync.status).toBe(200);

    const post = (path: string, headers: Record<string, string> = {}) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      });

    const sansSecret = await post('/bots/inbound-bot/inbound/sans-secret');
    expect(sansSecret.status).toBe(401);
    expect(await sansSecret.text()).toContain('no secret');

    const mauvaisSecret = await post('/bots/inbound-bot/inbound/avec-secret', {
      'x-bot-webhook-secret': 'faux',
    });
    expect(mauvaisSecret.status).toBe(401);

    // Le bon secret passe la porte ; le bot n'est pas démarré, donc 409 — c'est
    // bien la preuve que le refus précédent venait du secret, pas du démarrage.
    const bonSecret = await post('/bots/inbound-bot/inbound/avec-secret?secret=s3cret');
    expect(bonSecret.status).toBe(409);
  });
});
