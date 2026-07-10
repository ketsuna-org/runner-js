import process from 'node:process';

import { isParentMessage, type ParentToWorkerMessage } from '../ipc/messages.js';
import type { JsBotConfig } from '../config/js-bot-config.js';
import { parseJsBotConfig } from '../config/js-bot-config.js';
import { isManagedRunner, loadRunnerEnv } from '../config/env.js';
import { resolveVariableStore } from '../runtime/resolve-variable-store.js';
import { JsDiscordRunner } from './js-discord-runner.js';

export async function runBotWorker(): Promise<void> {
  const botId = (process.env.BOT_CREATOR_BOT_ID ?? '').trim();
  const dataDir = (process.env.BOT_CREATOR_DATA_DIR ?? './data/bots').trim();

  if (!botId) {
    console.error('[worker] BOT_CREATOR_BOT_ID is required.');
    process.exit(1);
  }

  const env = loadRunnerEnv();
  const sandboxScripts = isManagedRunner(env);

  const variableStore = await resolveVariableStore(dataDir, {
    managedRunnerApi: env.managedRunnerApi,
    managedRunnerToken: env.managedRunnerToken,
  });

  let runner: JsDiscordRunner | null = null;
  let stopping = false;

  function send(message: Record<string, unknown>): void {
    if (process.send) {
      process.send(message);
    }
  }

  function emitLog(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
    send({ type: 'log', botId, level, message });
  }

  function parseWorkerConfig(raw: Record<string, unknown>): JsBotConfig {
    return parseJsBotConfig(raw);
  }

  async function startRunner(config: JsBotConfig): Promise<void> {
    if (runner) {
      await runner.stop();
      runner = null;
    }

    runner = new JsDiscordRunner(botId, config, variableStore, emitLog, sandboxScripts);
    send({ type: 'status', botId, state: 'starting' });
    await runner.start();
    send({ type: 'status', botId, state: 'running', startedAt: new Date().toISOString() });
  }

  async function reloadRunner(config: JsBotConfig): Promise<void> {
    if (!runner) {
      await startRunner(config);
      return;
    }
    await runner.reload(config);
    send({ type: 'status', botId, state: 'running', startedAt: new Date().toISOString() });
  }

  async function stopRunner(reason?: string): Promise<void> {
    if (stopping) {
      return;
    }
    stopping = true;
    await runner?.stop();
    runner = null;
    send({ type: 'stopped', botId, reason });
    process.exit(0);
  }

  async function handleMessage(message: ParentToWorkerMessage): Promise<void> {
    switch (message.type) {
      case 'start':
        await startRunner(parseWorkerConfig(message.config));
        break;
      case 'reload':
        await reloadRunner(parseWorkerConfig(message.config));
        break;
      case 'stop':
        await stopRunner('ipc-stop');
        break;
      case 'ping':
        send({ type: 'pong', requestId: message.requestId, ok: true });
        break;
      case 'inbound-webhook': {
        if (!runner) {
          throw new Error('Bot is not running.');
        }
        const ok = await runner.triggerWebhook(message.path, message.payload, message.headers);
        if (!ok) {
          throw new Error(`Inbound webhook not found: ${message.path}`);
        }
        break;
      }
      default:
        break;
    }
  }

  let messageChain: Promise<void> = Promise.resolve();

  process.on('message', (raw: unknown) => {
    if (!isParentMessage(raw)) {
      return;
    }

    messageChain = messageChain
      .then(() => handleMessage(raw))
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        send({ type: 'status', botId, state: 'error', lastError: msg });
        emitLog('error', msg);
      });
  });

  process.on('uncaughtException', (error) => {
    send({ type: 'status', botId, state: 'error', lastError: error.message });
    emitLog('error', `uncaughtException: ${error.message}`);
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    send({ type: 'status', botId, state: 'error', lastError: message });
    emitLog('error', `unhandledRejection: ${message}`);
  });

  const metricsTimer = setInterval(() => {
    const memory = process.memoryUsage();
    send({
      type: 'metrics',
      botId,
      rssBytes: memory.rss,
      cpuPercent: null,
      pid: process.pid,
    });
  }, 5000);

  metricsTimer.unref();

  send({ type: 'ready', botId, pid: process.pid });
}
