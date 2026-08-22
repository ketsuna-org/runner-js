import os from 'node:os';

import { Hono } from 'hono';

import type { RunnerEnv } from '../config/env.js';
import { createAuthMiddleware } from './auth.js';
import type { RuntimeController } from '../runtime/runtime-controller.js';
import type { LogStore } from '../runtime/log-store.js';
import {
  normalizeScopedStorageKey,
  toScopedReferenceKey,
} from '../runtime/variable-keys.js';
import { isDiscordTokenUnauthorized } from '../discord/discord-auth-errors.js';

export interface HttpServerDeps {
  env: RunnerEnv;
  runtime: RuntimeController;
  logStore: LogStore;
}

export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

export function createHttpServer(deps: HttpServerDeps): Hono {
  const app = new Hono();

  // CORS and Cache-Control middleware
  app.use('*', async (c, next) => {
    c.header('access-control-allow-origin', '*');
    c.header('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
    c.header(
      'access-control-allow-headers',
      'content-type, authorization, x-bot-webhook-secret, x-webhook-secret',
    );
    c.header('cache-control', 'no-store');

    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }
    return next();
  });

  // Auth middleware
  app.use('*', createAuthMiddleware(deps.env.apiToken, deps.env.webHost));

  // Error handler
  app.onError((error, c) => {
    const err = error as Error & { statusCode?: number };
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    return c.json(
      {
        error: err.message ?? 'Internal server error',
      },
      statusCode as 400 | 401 | 404 | 409 | 500,
    );
  });

  app.get('/', (c) =>
    c.json({
      name: 'Bot Creator JS Runner',
      version: deps.env.version,
      engine: 'javascript',
      capabilities: ['js-native', 'in-process'],
    }),
  );

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/status', (c) => c.json(buildStatusPayload(deps.runtime)));

  app.get('/metrics', (c) => c.json(buildMetricsPayload(deps.runtime)));

  app.get('/bots/:id/metrics', (c) => {
    const botId = c.req.param('id');
    return c.json(buildBotMetricsPayload(deps.runtime, botId));
  });

  app.get('/logs', (c) => {
    const limitQuery = c.req.query('limit');
    const limit = Number.parseInt(limitQuery ?? '200', 10);
    return c.json({ lines: deps.logStore.tail(Number.isFinite(limit) ? limit : 200) });
  });

  app.get('/bots/:id/logs', (c) => {
    const botId = c.req.param('id');
    const limitQuery = c.req.query('limit');
    const limit = Number.parseInt(limitQuery ?? '200', 10);
    return c.json({
      lines: deps.logStore.tailForBot(botId, Number.isFinite(limit) ? limit : 200),
    });
  });

  app.get('/bots/:id/status', (c) => {
    const botId = c.req.param('id');
    return c.json({
      apiVersion: 2,
      bot: buildBotStatePayload(deps.runtime, botId),
    });
  });

  app.get('/bots', async (c) => {
    const entries = await deps.runtime.botStore.listAll();
    return c.json({
      bots: entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        syncedAt: entry.syncedAt,
      })),
    });
  });

  app.get('/bots/running-status', (c) => {
    const bots: Record<
      string,
      {
        connected: boolean;
        state: string;
        rssBytes: number | null;
        heapUsedBytes: number | null;
        guildCount: number | null;
        pid: number | null;
        lastError: string | null;
      }
    > = {};
    for (const state of deps.runtime.listRuntimeStates()) {
      bots[state.botId] = {
        connected: state.state === 'running',
        state: state.state,
        rssBytes: state.baselineRssBytes,
        heapUsedBytes: state.heapUsedBytes,
        guildCount: state.guildCount,
        pid: state.pid,
        lastError: state.lastError,
      };
    }
    return c.json({ bots });
  });

  app.post('/bots/sync', async (c) => {
    let body: {
      botId?: string;
      botName?: string;
      config?: Record<string, unknown>;
    } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      throw badRequest('Missing or invalid JSON body.');
    }

    const botId = (body.botId ?? '').trim();
    if (!botId) {
      throw badRequest('Missing botId.');
    }

    if (!body.config || typeof body.config !== 'object') {
      throw badRequest('Missing or invalid config payload.');
    }

    try {
      await deps.runtime.syncBot(botId, (body.botName ?? '').trim(), body.config);
      deps.logStore.append('info', `Synced bot ${botId}`, botId);
      return c.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw badRequest(`Invalid config: ${message}`);
    }
  });

  app.post('/bots/:id/start', async (c) => {
    const botId = c.req.param('id');
    let body: { botName?: string } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      body = {};
    }

    try {
      await deps.runtime.startBot(botId, (body.botName ?? '').trim());
      deps.logStore.append('info', `Started bot ${botId}`, botId);
      return c.json(buildStatusPayload(deps.runtime));
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('already running') || error.message.includes('only allows'))
      ) {
        throw conflict(error.message);
      }
      if (isDiscordTokenUnauthorized(error)) {
        throw unauthorized('discord_token_invalid');
      }
      throw error;
    }
  });

  app.post('/bots/:id/stop', async (c) => {
    const botId = c.req.param('id');
    await deps.runtime.stopBot(botId);
    deps.logStore.append('info', `Stopped bot ${botId}`, botId);
    return c.json(buildStatusPayload(deps.runtime));
  });

  app.post('/bots/:id/reload', async (c) => {
    const botId = c.req.param('id');
    let body: { config?: Record<string, unknown> } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      body = {};
    }

    try {
      const reloaded = await deps.runtime.reloadBot(botId, body.config);
      return c.json({ ok: true, reloaded });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw badRequest(`Invalid config: ${message}`);
    }
  });

  app.get('/pool/config', (c) =>
    c.json({
      max_bots: deps.env.poolMaxBots,
    }),
  );

  app.patch('/pool/config', async (c) => {
    let body: { max_bots?: number | string } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      body = {};
    }
    const parsed =
      typeof body.max_bots === 'number'
        ? body.max_bots
        : Number.parseInt(String(body.max_bots ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw badRequest('Invalid max_bots value.');
    }
    deps.env.poolMaxBots = parsed;
    deps.runtime.setMaxBots(parsed);
    return c.json({ max_bots: deps.env.poolMaxBots });
  });

  app.post('/pool/drain', async (c) => {
    const stopped = await deps.runtime.drainAllBots();
    deps.logStore.append('info', `Drained ${stopped} bot(s)`);
    return c.json({ stopped });
  });

  app.get('/bots/:id/variables/global', async (c) => {
    const botId = c.req.param('id');
    const variables = await deps.runtime.getMergedGlobalVariables(botId);
    return c.json({ botId, variables });
  });

  app.post('/bots/:id/variables/global/set', async (c) => {
    const botId = c.req.param('id');
    let body: { key?: string; value?: unknown } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      body = {};
    }
    const key = (body.key ?? '').trim();
    if (!key) {
      throw badRequest('Missing key.');
    }
    await deps.runtime.upsertGlobalVariable(botId, key, body.value);
    return c.json({ ok: true });
  });

  app.post('/bots/:id/variables/global/rename', async (c) => {
    const botId = c.req.param('id');
    let body: { oldKey?: string; newKey?: string } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      body = {};
    }
    const oldKey = (body.oldKey ?? '').trim();
    const newKey = (body.newKey ?? '').trim();
    if (!oldKey || !newKey) {
      throw badRequest('Missing oldKey or newKey.');
    }
    await deps.runtime.renameGlobalVariable(botId, oldKey, newKey);
    return c.json({ ok: true });
  });

  app.post('/bots/:id/variables/global/remove', async (c) => {
    const botId = c.req.param('id');
    let body: { key?: string } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      body = {};
    }
    const key = (body.key ?? '').trim();
    if (!key) {
      throw badRequest('Missing key.');
    }
    await deps.runtime.removeGlobalVariable(botId, key);
    return c.json({ ok: true });
  });

  app.get('/bots/:id/variables/scoped-definitions', async (c) => {
    const botId = c.req.param('id');
    const entry = await deps.runtime.requireBotEntry(botId);
    return c.json({
      botId,
      definitions: entry.config.scopedVariableDefinitions,
    });
  });

  app.post('/bots/:id/variables/scoped-definitions/set', async (c) => {
    const botId = c.req.param('id');
    let body: {
      scope?: string;
      key?: string;
      defaultValue?: unknown;
      valueType?: string;
    } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      body = {};
    }
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
    return c.json({ ok: true });
  });

  app.post('/bots/:id/variables/scoped-definitions/remove', async (c) => {
    const botId = c.req.param('id');
    let body: {
      key?: string;
      scope?: string;
      purgeStoredValues?: boolean;
    } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      body = {};
    }
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
    return c.json({ ok: true });
  });

  app.get('/bots/:id/variables/scoped-values', async (c) => {
    const botId = c.req.param('id');
    const entry = await deps.runtime.requireBotEntry(botId);
    const scope = (c.req.query('scope') ?? '').trim();
    const keyRaw = (c.req.query('key') ?? '').trim();
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

    return c.json({ botId, scope, key: storageKey, values });
  });

  app.post('/bots/:id/variables/scoped-values/set', async (c) => {
    const botId = c.req.param('id');
    await deps.runtime.requireBotEntry(botId);
    let body: {
      scope?: string;
      key?: string;
      contextId?: string;
      value?: unknown;
    } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      body = {};
    }
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
    return c.json({ ok: true });
  });

  app.post('/bots/:id/variables/scoped-values/remove', async (c) => {
    const botId = c.req.param('id');
    await deps.runtime.requireBotEntry(botId);
    let body: {
      scope?: string;
      key?: string;
      contextId?: string;
    } = {};
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      body = {};
    }
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
    return c.json({ ok: true });
  });

  app.post('/bots/:id/inbound/:pathKey', async (c) => {
    const botId = c.req.param('id');
    const pathKey = c.req.param('pathKey');
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
      c.req.header('x-bot-webhook-secret') ??
      c.req.header('x-webhook-secret') ??
      c.req.query('secret') ??
      ''
    ).trim();

    if (expectedSecret.length > 0 && providedSecret !== expectedSecret) {
      throw unauthorized('Invalid webhook secret.');
    }

    if (!deps.runtime.isBotRunning(botId)) {
      throw conflict(`Bot "${botId}" is not running.`);
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(c.req.header())) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }

    let parsedBody: unknown = undefined;
    try {
      parsedBody = await c.req.json();
    } catch {
      try {
        parsedBody = await c.req.text();
      } catch {
        parsedBody = undefined;
      }
    }

    await deps.runtime.triggerInboundWebhook(botId, pathKey, parsedBody, headers);

    return c.json({
      ok: true,
      botId,
      path: pathKey,
      handlerId: webhook.id,
    });
  });

  return app;
}

function buildStatusPayload(runtime: RuntimeController) {
  return {
    apiVersion: 2,
    running: runtime.isRunning,
    runningCount: runtime.runningCount,
    bots: runtime.listRuntimeStates().map((state) => serializeBotRuntimeState(state)),
  };
}

function serializeBotRuntimeState(state: ReturnType<RuntimeController['listRuntimeStates']>[number]) {
  return {
    botId: state.botId,
    botName: state.botName,
    state: state.state,
    lastSeenAt: state.lastSeenAt,
    lastError: state.lastError,
    baselineRssBytes: state.baselineRssBytes,
    heapUsedBytes: state.heapUsedBytes,
    guildCount: state.guildCount,
    pid: state.pid,
  };
}

function buildMetricsPayload(runtime: RuntimeController) {
  const memory = process.memoryUsage();
  const totalWorkerRssBytes = runtime.aggregateWorkerRssBytes();
  return {
    apiVersion: 2,
    running: runtime.isRunning,
    runningCount: runtime.runningCount,
    rssBytes: memory.rss + totalWorkerRssBytes,
    mainRssBytes: memory.rss,
    totalWorkerRssBytes,
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

function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

function unauthorized(message: string): HttpError {
  return new HttpError(401, message);
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
