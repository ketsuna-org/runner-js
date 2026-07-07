import { fork, spawn, type ChildProcess, type StdioOptions } from 'node:child_process';

import {
  isWorkerMessage,
  type ParentToWorkerMessage,
  type WorkerToParentMessage,
} from '../ipc/messages.js';
import { resolveWorkerLaunch, shouldSpawnWorkerProcess } from './worker-launch.js';
import { buildWorkerProcessEnv } from './worker-env.js';
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
  private readonly workerStderr = new Map<string, string>();

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
    this.options.logStore.append(
      'debug',
      `Spawning worker via ${shouldSpawnWorkerProcess(launch) ? 'spawn' : 'fork'}: ${launch.executable}`,
      botId,
    );
    const child = this.spawnWorker(
      launch,
      buildWorkerProcessEnv(botId, this.options.dataDir),
    );

    child.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const previous = this.workerStderr.get(botId) ?? '';
      this.workerStderr.set(botId, `${previous}\n${message}`.trim());
      this.options.logStore.append('error', `Worker spawn error: ${message}`, botId);
    });

    this.workers.set(botId, child);
    this.workerStderr.set(botId, '');
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
      const text = chunk.toString().trim();
      if (text.length > 0) {
        this.options.logStore.append('info', text, botId);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      const previous = this.workerStderr.get(botId) ?? '';
      this.workerStderr.set(botId, `${previous}\n${text}`.trim());
      this.options.logStore.append('error', text, botId);
    });

    child.on('message', (raw: unknown) => {
      this.handleWorkerMessage(botId, raw);
    });

    child.on('exit', (code, signal) => {
      this.workers.delete(botId);
      const stderr = (this.workerStderr.get(botId) ?? '').trim();
      this.workerStderr.delete(botId);
      const intentionalStop = this.stoppingBots.delete(botId);
      const current = this.states.get(botId);
      if (!current) {
        return;
      }

      const exitDetail = stderr.length > 0
        ? `Worker exited (code=${code}, signal=${signal}): ${stderr}`
        : `Worker exited (code=${code}, signal=${signal})`;

      if (!intentionalStop && current.state === 'starting') {
        this.options.logStore.append('info', exitDetail, botId);
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
          lastError: current.lastError ?? exitDetail,
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

    try {
      await this.waitForReady(botId, 30_000);
      await this.send(botId, { type: 'start' });
      await this.options.botStore.setRunning(botId, true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.cleanupFailedStart(botId, reason);
      throw error;
    }
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

  private async cleanupFailedStart(botId: string, reason?: string): Promise<void> {
    const stderr = (this.workerStderr.get(botId) ?? '').trim();
    const detail = reason ?? 'Worker start failed';
    const message = stderr.length > 0 ? `${detail}: ${stderr}` : detail;
    this.options.logStore.append('info', message, botId);

    const child = this.workers.get(botId);
    if (child) {
      this.stoppingBots.add(botId);
      child.kill('SIGTERM');
      await waitForExit(child, 5_000);
      this.workers.delete(botId);
      this.stoppingBots.delete(botId);
    }
    this.workerStderr.delete(botId);
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

  private spawnWorker(
    launch: { executable: string; args: string[] },
    env: NodeJS.ProcessEnv,
  ): ChildProcess {
    const stdio: StdioOptions = ['pipe', 'pipe', 'pipe', 'ipc'];
    const options = {
      env,
      stdio,
      cwd: this.options.dataDir,
      windowsHide: true,
    };

    if (shouldSpawnWorkerProcess(launch)) {
      return spawn(launch.executable, launch.args, options);
    }

    return fork(launch.executable, launch.args, options);
  }

  private workerStartError(botId: string, reason: string): Error {
    const stderr = (this.workerStderr.get(botId) ?? '').trim();
    if (stderr.length > 0) {
      return new Error(`${reason} ${stderr}`);
    }
    return new Error(reason);
  }

  private async waitForReady(botId: string, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const child = this.workers.get(botId);
      if (!child) {
        throw this.workerStartError(
          botId,
          `Worker for bot "${botId}" failed to start.`,
        );
      }
      if (!child.pid) {
        throw this.workerStartError(
          botId,
          `Worker for bot "${botId}" failed to start.`,
        );
      }
      const requestId = `${botId}-${Date.now()}`;
      const ok = await this.ping(botId, requestId, 1000);
      if (ok) {
        return;
      }
      await delay(100);
    }
    throw this.workerStartError(
      botId,
      `Worker for bot "${botId}" did not become ready in time.`,
    );
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
