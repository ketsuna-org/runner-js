import { fork, type ChildProcess } from 'node:child_process';

import {
  isWorkerMessage,
  type ParentToWorkerMessage,
  type WorkerToParentMessage,
} from '../ipc/messages.js';
import { resolveWorkerLaunch } from './worker-launch.js';
import type { LogStore } from '../runtime/log-store.js';
import type { BotStore } from '../runtime/bot-store.js';

export interface ManagedWorkerState {
  botId: string;
  botName: string;
  state: 'starting' | 'running' | 'stopped' | 'error';
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
  lastSeenAt: string | null;
  rssBytes: number | null;
  autoRestart: boolean;
}

export interface BotProcessManagerOptions {
  dataDir: string;
  botStore: BotStore;
  logStore: LogStore;
  onWorkerExit?: (botId: string, code: number | null, signal: NodeJS.Signals | null) => void;
}

export class BotProcessManager {
  private readonly workers = new Map<string, ChildProcess>();
  private readonly states = new Map<string, ManagedWorkerState>();
  private readonly stoppingBots = new Set<string>();
  private readonly pendingPings = new Map<
    string,
    { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly options: BotProcessManagerOptions) {}

  listStates(): ManagedWorkerState[] {
    return [...this.states.values()];
  }

  getState(botId: string): ManagedWorkerState {
    return (
      this.states.get(botId) ?? {
        botId,
        botName: botId,
        state: 'stopped',
        pid: null,
        startedAt: null,
        lastError: null,
        lastSeenAt: null,
        rssBytes: null,
        autoRestart: true,
      }
    );
  }

  isRunning(botId: string): boolean {
    const state = this.states.get(botId);
    return state?.state === 'running' || state?.state === 'starting';
  }

  get runningCount(): number {
    return [...this.states.values()].filter(
      (state) => state.state === 'running' || state.state === 'starting',
    ).length;
  }

  async startBot(botId: string, botName: string): Promise<void> {
    if (this.isRunning(botId)) {
      throw new Error(`Bot "${botId}" is already running.`);
    }

    const entry = await this.options.botStore.load(botId);
    if (!entry) {
      throw new Error(`Bot "${botId}" is not synced.`);
    }

    const launch = resolveWorkerLaunch();

    const child = fork(launch.executable, launch.args, {
      env: {
        ...process.env,
        BOT_CREATOR_BOT_ID: botId,
        BOT_CREATOR_DATA_DIR: this.options.dataDir,
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    this.workers.set(botId, child);
    this.states.set(botId, {
      botId,
      botName: botName || entry.name,
      state: 'starting',
      pid: child.pid ?? null,
      startedAt: null,
      lastError: null,
      lastSeenAt: new Date().toISOString(),
      rssBytes: null,
      autoRestart: entry.config.autoRestart,
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      this.options.logStore.append('debug', chunk.toString().trim(), botId);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.options.logStore.append('error', chunk.toString().trim(), botId);
    });

    child.on('message', (raw: unknown) => {
      this.handleWorkerMessage(botId, raw);
    });

    child.on('exit', (code, signal) => {
      this.workers.delete(botId);
      const intentionalStop = this.stoppingBots.delete(botId);
      const current = this.states.get(botId);
      if (!current) {
        return;
      }

      if (intentionalStop) {
        this.states.set(botId, {
          ...current,
          state: 'stopped',
          pid: null,
          lastSeenAt: new Date().toISOString(),
        });
        this.options.onWorkerExit?.(botId, code, signal);
        return;
      }

      if (current.state !== 'stopped') {
        this.states.set(botId, {
          ...current,
          state: 'error',
          pid: null,
          lastError: current.lastError ?? `Worker exited (code=${code}, signal=${signal})`,
          lastSeenAt: new Date().toISOString(),
        });

        if (current.autoRestart) {
          this.options.logStore.append('warn', `Auto-restarting bot after exit`, botId);
          setTimeout(() => {
            void this.startBot(botId, current.botName).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              this.options.logStore.append('error', `Auto-restart failed: ${message}`, botId);
            });
          }, 2000);
        }
      }

      this.options.onWorkerExit?.(botId, code, signal);
    });

    await this.waitForReady(botId, 30_000);
    await this.send(botId, { type: 'start' });
    await this.options.botStore.setRunning(botId, true);
  }

  async stopBot(botId: string): Promise<void> {
    const child = this.workers.get(botId);
    if (!child) {
      const current = this.states.get(botId);
      if (current) {
        this.states.set(botId, { ...current, state: 'stopped', pid: null });
      }
      await this.options.botStore.setRunning(botId, false);
      return;
    }

    this.stoppingBots.add(botId);
    await this.send(botId, { type: 'stop' });
    await waitForExit(child, 10_000);
    this.workers.delete(botId);

    const current = this.states.get(botId);
    if (current) {
      this.states.set(botId, {
        ...current,
        state: 'stopped',
        pid: null,
        lastSeenAt: new Date().toISOString(),
      });
    }

    await this.options.botStore.setRunning(botId, false);
  }

  async reloadBot(botId: string): Promise<boolean> {
    if (!this.isRunning(botId)) {
      return false;
    }
    await this.send(botId, { type: 'reload' });
    return true;
  }

  async triggerInboundWebhook(
    botId: string,
    pathKey: string,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<void> {
    if (!this.isRunning(botId)) {
      throw new Error(`Bot "${botId}" is not running.`);
    }

    await this.send(botId, {
      type: 'inbound-webhook',
      path: pathKey,
      payload,
      headers,
    });
  }

  async drainAll(): Promise<number> {
    const running = [...this.workers.keys()];
    for (const botId of running) {
      await this.stopBot(botId);
    }
    return running.length;
  }

  async dispose(): Promise<void> {
    await this.drainAll();
  }

  private handleWorkerMessage(botId: string, raw: unknown): void {
    if (!isWorkerMessage(raw)) {
      return;
    }

    const current = this.states.get(botId);
    if (!current) {
      return;
    }

    const message = raw as WorkerToParentMessage;
    const now = new Date().toISOString();

    switch (message.type) {
      case 'ready':
        this.states.set(botId, {
          ...current,
          pid: message.pid,
          lastSeenAt: now,
        });
        break;
      case 'status':
        this.states.set(botId, {
          ...current,
          state: message.state,
          startedAt: message.startedAt ?? current.startedAt,
          lastError: message.lastError ?? current.lastError,
          lastSeenAt: now,
        });
        break;
      case 'metrics':
        this.states.set(botId, {
          ...current,
          rssBytes: message.rssBytes,
          pid: message.pid,
          lastSeenAt: now,
        });
        break;
      case 'log':
        this.options.logStore.append(message.level, message.message, botId);
        break;
      case 'stopped':
        this.states.set(botId, {
          ...current,
          state: 'stopped',
          pid: null,
          lastSeenAt: now,
        });
        break;
      case 'pong': {
        const pending = this.pendingPings.get(message.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(message.ok);
          this.pendingPings.delete(message.requestId);
        }
        break;
      }
      default:
        break;
    }
  }

  private async send(botId: string, message: ParentToWorkerMessage): Promise<void> {
    const child = this.workers.get(botId);
    if (!child || !child.send) {
      throw new Error(`Worker for bot "${botId}" is not available.`);
    }

    await new Promise<void>((resolve, reject) => {
      child.send(message, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async waitForReady(botId: string, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const child = this.workers.get(botId);
      if (!child?.pid) {
        throw new Error(`Worker for bot "${botId}" failed to start.`);
      }
      const requestId = `${botId}-${Date.now()}`;
      const ok = await this.ping(botId, requestId, 1000);
      if (ok) {
        return;
      }
      await delay(100);
    }
    throw new Error(`Worker for bot "${botId}" did not become ready in time.`);
  }

  private ping(botId: string, requestId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPings.delete(requestId);
        resolve(false);
      }, timeoutMs);

      this.pendingPings.set(requestId, { resolve, timer });
      void this.send(botId, { type: 'ping', requestId }).catch(() => {
        clearTimeout(timer);
        this.pendingPings.delete(requestId);
        resolve(false);
      });
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve();
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
