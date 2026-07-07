import os from 'node:os';

import Fastify, { type FastifyInstance } from 'fastify';

import type { RunnerEnv } from '../config/env.js';
import { createAuthHook } from './auth.js';
import type { RuntimeController } from '../runtime/runtime-controller.js';
import type { LogStore } from '../runtime/log-store.js';
import {
  normalizeScopedStorageKey,
  toScopedReferenceKey,
} from '../runtime/variable-keys.js';

export interface HttpServerDeps {
  env: RunnerEnv;
  runtime: RuntimeController;
  logStore: LogStore;
}

export function createHttpServer(deps: HttpServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
    reply.header(
      'access-control-allow-headers',
      'content-type, authorization, x-bot-webhook-secret, x-webhook-secret',
    );
    reply.header('cache-control', 'no-store');

    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  app.addHook('onRequest', createAuthHook(deps.env.apiToken, deps.env.webHost));

  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number };
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    reply.code(statusCode).send({
      error: err.message ?? 'Internal server error',
    });
  });

  app.get('/', async () => ({
    name: 'Bot Creator JS Runner',
    version: deps.env.version,
    engine: 'javascript',
    capabilities: ['js-native', 'worker-process'],
  }));

  app.get('/health', async () => ({ ok: true }));

  app.get('/status', async () => buildStatusPayload(deps.runtime));

  app.get('/metrics', async () => buildMetricsPayload(deps.runtime));

  app.get('/bots/:id/metrics', async (request) => {
    const botId = (request.params as { id: string }).id;
    return buildBotMetricsPayload(deps.runtime, botId);
  });

  app.get('/logs', async (request) => {
    const query = request.query as { limit?: string };
    const limit = Number.parseInt(query.limit ?? '200', 10);
    return { lines: deps.logStore.tail(Number.isFinite(limit) ? limit : 200) };
  });

  app.get('/bots/:id/logs', async (request) => {
    const botId = (request.params as { id: string }).id;
    const query = request.query as { limit?: string };
    const limit = Number.parseInt(query.limit ?? '200', 10);
    return {
      lines: deps.logStore.tailForBot(botId, Number.isFinite(limit) ? limit : 200),
    };
  });

  app.get('/bots/:id/status', async (request) => {
    const botId = (request.params as { id: string }).id;
    return {
      apiVersion: 2,
      bot: buildBotStatePayload(deps.runtime, botId),
    };
  });

  app.get('/bots', async () => {
    const entries = await deps.runtime.botStore.listAll();
    return {
      bots: entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        syncedAt: entry.syncedAt,
      })),
    };
  });

  app.post('/bots/sync', async (request) => {
    const body = request.body as {
      botId?: string;
      botName?: string;
      config?: Record<string, unknown>;
    };

    const botId = (body.botId ?? '').trim();
    if (!botId) {
      throw badRequest('Missing botId.');
    }

    if (!body.config || typeof body.config !== 'object') {
      throw badRequest('Missing or invalid config payload.');
    }

    try {
      await deps.runtime.syncBot(botId, (body.botName ?? '').trim(), body.config);
      deps.logStore.append('info', `Synced bot ${botId}`);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw badRequest(`Invalid config: ${message}`);
    }
  });

  app.post('/bots/:id/start', async (request) => {
    const botId = (request.params as { id: string }).id;
    const body = (request.body as { botName?: string } | undefined) ?? {};

    try {
      await deps.runtime.startBot(botId, (body.botName ?? '').trim());
      deps.logStore.append('info', `Started bot ${botId}`);
      return buildStatusPayload(deps.runtime);
    } catch (error) {
      if (error instanceof Error && error.message.includes('already running')) {
        throw conflict(error.message);
      }
      throw error;
    }
  });

  app.post('/bots/:id/stop', async (request) => {
    const botId = (request.params as { id: string }).id;
    await deps.runtime.stopBot(botId);
    deps.logStore.append('info', `Stopped bot ${botId}`);
    return buildStatusPayload(deps.runtime);
  });

  app.post('/bots/:id/reload', async (request) => {
    const botId = (request.params as { id: string }).id;
    const body = (request.body as { config?: Record<string, unknown> } | undefined) ?? {};

    try {
      const reloaded = await deps.runtime.reloadBot(botId, body.config);
      return { ok: true, reloaded };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw badRequest(`Invalid config: ${message}`);
    }
  });

  app.get('/pool/config', async () => ({
    max_bots: deps.env.poolMaxBots,
  }));

  app.patch('/pool/config', async (request) => {
    const body = (request.body as { max_bots?: number | string } | undefined) ?? {};
    const parsed =
      typeof body.max_bots === 'number'
        ? body.max_bots
        : Number.parseInt(String(body.max_bots ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw badRequest('Invalid max_bots value.');
    }
    deps.env.poolMaxBots = parsed;
    return { max_bots: deps.env.poolMaxBots };
  });

  app.post('/pool/drain', async () => {
    const stopped = await deps.runtime.drainAllBots();
    deps.logStore.append('info', `Drained ${stopped} bot(s)`);
    return { stopped };
  });

  app.get('/bots/:id/variables/global', async (request) => {
    const botId = (request.params as { id: string }).id;
    const variables = await deps.runtime.getMergedGlobalVariables(botId);
    return { botId, variables };
  });

  app.post('/bots/:id/variables/global/set', async (request) => {
    const botId = (request.params as { id: string }).id;
    const body = (request.body as { key?: string; value?: unknown }) ?? {};
    const key = (body.key ?? '').trim();
    if (!key) {
      throw badRequest('Missing key.');
    }
    await deps.runtime.upsertGlobalVariable(botId, key, body.value);
    return { ok: true };
  });

  app.post('/bots/:id/variables/global/rename', async (request) => {
    const botId = (request.params as { id: string }).id;
    const body = (request.body as { oldKey?: string; newKey?: string }) ?? {};
    const oldKey = (body.oldKey ?? '').trim();
    const newKey = (body.newKey ?? '').trim();
    if (!oldKey || !newKey) {
      throw badRequest('Missing oldKey or newKey.');
    }
    await deps.runtime.renameGlobalVariable(botId, oldKey, newKey);
    return { ok: true };
  });

  app.post('/bots/:id/variables/global/remove', async (request) => {
    const botId = (request.params as { id: string }).id;
    const body = (request.body as { key?: string }) ?? {};
    const key = (body.key ?? '').trim();
    if (!key) {
      throw badRequest('Missing key.');
    }
    await deps.runtime.removeGlobalVariable(botId, key);
    return { ok: true };
  });

  app.get('/bots/:id/variables/scoped-definitions', async (request) => {
    const botId = (request.params as { id: string }).id;
    const entry = await deps.runtime.requireBotEntry(botId);
    return {
      botId,
      definitions: entry.config.scopedVariableDefinitions,
    };
  });

  app.post('/bots/:id/variables/scoped-definitions/set', async (request) => {
    const botId = (request.params as { id: string }).id;
    const body =
      (request.body as {
        scope?: string;
        key?: string;
        defaultValue?: unknown;
        valueType?: string;
      }) ?? {};
    const scope = (body.scope ?? '').trim();
    const key = normalizeScopedStorageKey((body.key ?? '').toString());
    if (!scope || !key) {
      throw badRequest('Missing scope or key.');
    }
    await deps.runtime.upsertScopedVariableDefinition(
      botId,
      key,
      scope,
      body.defaultValue,
      (body.valueType ?? 'string').toString(),
    );
    return { ok: true };
  });

  app.post('/bots/:id/variables/scoped-definitions/remove', async (request) => {
    const botId = (request.params as { id: string }).id;
    const body =
      (request.body as {
        key?: string;
        scope?: string;
        purgeStoredValues?: boolean;
      }) ?? {};
    const key = normalizeScopedStorageKey((body.key ?? '').toString());
    if (!key) {
      throw badRequest('Missing key.');
    }
    const scope = (body.scope ?? '').trim();
    await deps.runtime.deleteScopedVariableDefinition(
      botId,
      key,
      scope || undefined,
      body.purgeStoredValues === true,
    );
    return { ok: true };
  });

  app.get('/bots/:id/variables/scoped-values', async (request) => {
    const botId = (request.params as { id: string }).id;
    const entry = await deps.runtime.requireBotEntry(botId);
    const query = request.query as { scope?: string; key?: string };
    const scope = (query.scope ?? '').trim();
    const keyRaw = (query.key ?? '').trim();
    if (!scope || !keyRaw) {
      throw badRequest('Missing scope or key query parameter.');
    }

    const storageKey = normalizeScopedStorageKey(keyRaw);
    const legacyKey = toScopedReferenceKey(storageKey);
    const contextIds = new Set(
      await deps.runtime.variableStore.listContextIds(botId, scope, storageKey),
    );
    if (legacyKey !== storageKey) {
      for (const contextId of await deps.runtime.variableStore.listContextIds(
        botId,
        scope,
        legacyKey,
      )) {
        contextIds.add(contextId);
      }
    }

    const values: Record<string, unknown> = {};
    for (const contextId of [...contextIds].sort()) {
      let value = await deps.runtime.variableStore.getScopedVariable(
        botId,
        scope,
        contextId,
        storageKey,
      );
      if (value == null && legacyKey !== storageKey) {
        value = await deps.runtime.variableStore.getScopedVariable(
          botId,
          scope,
          contextId,
          legacyKey,
        );
      }
      if (isMissingOrEmpty(value)) {
        const defaultValue = defaultValueFor(
          entry.config.scopedVariableDefinitions,
          scope,
          storageKey,
        );
        if (defaultValue != null) {
          value = defaultValue;
        }
      }
      if (value != null) {
        values[contextId] = value;
      }
    }

    return { botId, scope, key: storageKey, values };
  });

  app.post('/bots/:id/variables/scoped-values/set', async (request) => {
    const botId = (request.params as { id: string }).id;
    await deps.runtime.requireBotEntry(botId);
    const body = (request.body as {
      scope?: string;
      key?: string;
      contextId?: string;
      value?: unknown;
    }) ?? {};
    const scope = (body.scope ?? '').trim();
    const keyRaw = (body.key ?? '').trim();
    const contextId = (body.contextId ?? '').trim();
    if (!scope || !keyRaw || !contextId) {
      throw badRequest('Missing scope, key, or contextId.');
    }
    const storageKey = normalizeScopedStorageKey(keyRaw);
    await deps.runtime.variableStore.setScopedVariable(
      botId,
      scope,
      contextId,
      storageKey,
      body.value,
    );
    return { ok: true };
  });

  app.post('/bots/:id/variables/scoped-values/remove', async (request) => {
    const botId = (request.params as { id: string }).id;
    await deps.runtime.requireBotEntry(botId);
    const body = (request.body as {
      scope?: string;
      key?: string;
      contextId?: string;
    }) ?? {};
    const scope = (body.scope ?? '').trim();
    const keyRaw = (body.key ?? '').trim();
    const contextId = (body.contextId ?? '').trim();
    if (!scope || !keyRaw || !contextId) {
      throw badRequest('Missing scope, key, or contextId.');
    }
    const storageKey = normalizeScopedStorageKey(keyRaw);
    await deps.runtime.variableStore.removeScopedVariable(
      botId,
      scope,
      contextId,
      storageKey,
    );
    return { ok: true };
  });

  app.post('/bots/:id/inbound/:pathKey', async (request) => {
    const { id: botId, pathKey } = request.params as { id: string; pathKey: string };
    const entry = await deps.runtime.botStore.load(botId);
    if (!entry) {
      throw notFound(`Bot "${botId}" not found.`);
    }

    const webhook = (entry.config.inboundWebhooks ?? []).find(
      (candidate) =>
        candidate.path.trim().toLowerCase() === pathKey.trim().toLowerCase() &&
        candidate.enabled !== false,
    );

    if (!webhook) {
      throw notFound('Inbound webhook path not found.');
    }

    const expectedSecret = (webhook.secret ?? '').trim();
    const providedSecret = (
      (request.headers['x-bot-webhook-secret'] as string | undefined) ??
      (request.headers['x-webhook-secret'] as string | undefined) ??
      (request.query as { secret?: string }).secret ??
      ''
    ).trim();

    if (expectedSecret.length > 0 && providedSecret !== expectedSecret) {
      throw unauthorized('Invalid webhook secret.');
    }

    if (!deps.runtime.isBotRunning(botId)) {
      throw conflict(`Bot "${botId}" is not running.`);
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }

    await deps.runtime.triggerInboundWebhook(botId, pathKey, request.body, headers);

    return {
      ok: true,
      botId,
      path: pathKey,
      handlerId: webhook.id,
    };
  });

  return app;
}

function buildStatusPayload(runtime: RuntimeController) {
  return {
    apiVersion: 2,
    running: runtime.isRunning,
    runningCount: runtime.runningCount,
    bots: runtime.listRuntimeStates().map((state) => ({
      botId: state.botId,
      botName: state.botName,
      state: state.state,
      lastSeenAt: state.lastSeenAt,
      lastError: state.lastError,
      baselineRssBytes: state.baselineRssBytes,
    })),
  };
}

function buildMetricsPayload(runtime: RuntimeController) {
  const memory = process.memoryUsage();
  return {
    apiVersion: 2,
    running: runtime.isRunning,
    runningCount: runtime.runningCount,
    rssBytes: memory.rss,
    cpuPercent: readCpuPercent(),
    bots: runtime.listRuntimeStates(),
  };
}

function buildBotMetricsPayload(runtime: RuntimeController, botId: string) {
  const botState = runtime.runtimeStateForBot(botId);
  const botRunning = botState.state === 'running' || botState.state === 'starting';
  const memory = process.memoryUsage();

  return {
    apiVersion: 2,
    running: runtime.isRunning,
    runningCount: runtime.runningCount,
    rssBytes: botRunning ? (botState.baselineRssBytes ?? memory.rss) : null,
    cpuPercent: botRunning ? readCpuPercent() : null,
    bots: [botState],
  };
}

function buildBotStatePayload(runtime: RuntimeController, botId: string) {
  return runtime.runtimeStateForBot(botId);
}

let lastCpu = { idle: 0, total: 0 };

function readCpuPercent(): number | null {
  const cpus = os.cpus();
  if (cpus.length === 0) {
    return null;
  }

  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }

  const idleDelta = idle - lastCpu.idle;
  const totalDelta = total - lastCpu.total;
  lastCpu = { idle, total };

  if (totalDelta <= 0) {
    return null;
  }

  return Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(2));
}

function badRequest(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}

function conflict(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 409;
  return error;
}

function notFound(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 404;
  return error;
}

function unauthorized(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 401;
  return error;
}

function isMissingOrEmpty(value: unknown): boolean {
  if (value == null) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim().length === 0;
  }
  return false;
}

function defaultValueFor(
  definitions: Array<Record<string, unknown>>,
  scope: string,
  storageKey: string,
): unknown {
  for (const def of definitions) {
    const defKey = normalizeScopedStorageKey(String(def.key ?? ''));
    const defScope = String(def.scope ?? '').trim();
    if (defKey !== storageKey || defScope !== scope.trim()) {
      continue;
    }
    const defaultValue = def.defaultValue;
    if (defaultValue == null) {
      return null;
    }
    if (typeof defaultValue === 'string' && defaultValue.trim().length === 0) {
      return null;
    }
    return defaultValue;
  }
  return null;
}
