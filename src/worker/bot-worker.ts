import process from 'node:process';

import { isParentMessage, type ParentToWorkerMessage } from '../ipc/messages.js';
import { BotStore } from '../runtime/bot-store.js';
import { parseJsBotConfig } from '../config/js-bot-config.js';
import { JsDiscordRunner } from './js-discord-runner.js';

const botId = (process.env.BOT_CREATOR_BOT_ID ?? '').trim();
const dataDir = (process.env.BOT_CREATOR_DATA_DIR ?? './data/bots').trim();

if (!botId) {
  console.error('[worker] BOT_CREATOR_BOT_ID is required.');
  process.exit(1);
}

const store = new BotStore(dataDir);
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

async function loadConfig() {
  const entry = await store.load(botId);
  if (!entry) {
    throw new Error(`Bot "${botId}" config not found.`);
  }
  return parseJsBotConfig(entry.config);
}

async function startRunner(): Promise<void> {
  const config = await loadConfig();
  runner = new JsDiscordRunner(botId, config, emitLog);
  send({ type: 'status', botId, state: 'starting' });
  await runner.start();
  send({ type: 'status', botId, state: 'running', startedAt: new Date().toISOString() });
}

async function reloadRunner(): Promise<void> {
  const config = await loadConfig();
  if (!runner) {
    await startRunner();
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
      await startRunner();
      break;
    case 'reload':
      await reloadRunner();
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

process.on('message', (raw: unknown) => {
  if (!isParentMessage(raw)) {
    return;
  }

  void handleMessage(raw).catch((error) => {
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
