import type { JsBotConfig } from '../config/js-bot-config.js';
import {
  isDiscordGatewayDisallowedIntentsClose,
  isDiscordTokenUnauthorized,
} from '../discord/discord-auth-errors.js';
import { JsDiscordRunner } from '../worker/js-discord-runner.js';
import type { BotStore } from './bot-store.js';
import type { LogStore } from './log-store.js';
import {
  evaluateSustainedRss,
  resolveProcessMemoryPolicy,
  type ProcessMemoryPolicy,
} from './memory-hygiene.js';
import type { VariableDatabase } from './variable-database.js';

export interface ManagedBotState {
  botId: string;
  botName: string;
  state: 'starting' | 'running' | 'stopped' | 'error';
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
  lastSeenAt: string | null;
  rssBytes: number | null;
  heapUsedBytes: number | null;
  guildCount: number | null;
  autoRestart: boolean;
}

/** Compatibility alias from the per-bot worker-process era. */
export type ManagedWorkerState = ManagedBotState;

/** The subset of JsDiscordRunner the supervisor drives (injectable in tests). */
export interface BotRunnerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  reload(config: JsBotConfig): Promise<void>;
  triggerWebhook(
    pathKey: string,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<boolean>;
  getGuildCount(): number;
  getHeapUsedBytes(): number | null;
  disposeIdleIsolate(force?: boolean): boolean;
}

export interface CreateRunnerParams {
  botId: string;
  config: JsBotConfig;
  variableStore: VariableDatabase;
  onLog: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
  sandboxScripts: boolean;
  onFatalDisconnect: (reason: string) => void;
}

export interface BotSupervisorOptions {
  botStore: BotStore;
  logStore: LogStore;
  variableStore: VariableDatabase;
  /** Force isolated-vm sandboxing for user scripts (managed/pool mode). */
  sandboxScripts: boolean;
  /** Runner factory, overridable in tests. Defaults to JsDiscordRunner. */
  createRunner?: (params: CreateRunnerParams) => BotRunnerHandle;
  /** Delay before auto-restarting a bot after a fatal disconnect. */
  restartDelayMs?: number;
  /** Interval of the metrics/memory maintenance tick. */
  metricsIntervalMs?: number;
  memoryPolicy?: Partial<ProcessMemoryPolicy>;
  /** Exit hook for the critical-memory path, overridable in tests. */
  exitProcess?: (code: number) => void;
}

const DEFAULT_RESTART_DELAY_MS = 2000;
const DEFAULT_METRICS_INTERVAL_MS = 5000;
const MEMORY_LOG_EVERY_TICKS = 60; // ~5 minutes at the default tick interval

interface ManagedBot {
  runner: BotRunnerHandle;
}

/**
 * In-process supervisor for all bots on this node. Each bot is a
 * JsDiscordRunner (discord.js client + per-bot script executor) inside the
 * shared process; script isolation is provided by isolated-vm, not by OS
 * processes. A native crash therefore affects every bot on the node — the
 * accepted trade-off for dropping ~1 Node runtime of overhead per bot.
 */
export class BotSupervisor {
  private readonly bots = new Map<string, ManagedBot>();
  private readonly states = new Map<string, ManagedBotState>();
  private readonly startingBots = new Set<string>();
  private readonly stoppingBots = new Set<string>();
  private readonly tokenInvalidBots = new Set<string>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private readonly createRunner: (params: CreateRunnerParams) => BotRunnerHandle;
  private readonly restartDelayMs: number;
  private readonly memoryPolicy: ProcessMemoryPolicy;
  private readonly exitProcess: (code: number) => void;
  private readonly maintenanceTimer: NodeJS.Timeout;
  private readonly startedAtMs = Date.now();
  private rssOverSoftStreak = 0;
  private rssOverCriticalStreak = 0;
  private tickCount = 0;
  private disposed = false;

  constructor(private readonly options: BotSupervisorOptions) {
    this.createRunner =
      options.createRunner ??
      ((params) =>
        new JsDiscordRunner(
          params.botId,
          params.config,
          params.variableStore,
          params.onLog,
          params.sandboxScripts,
          params.onFatalDisconnect,
        ));
    this.restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    this.memoryPolicy = {
      ...resolveProcessMemoryPolicy(),
      ...options.memoryPolicy,
    };
    this.exitProcess = options.exitProcess ?? ((code) => process.exit(code));
    this.maintenanceTimer = setInterval(
      () => this.onMaintenanceTick(),
      options.metricsIntervalMs ?? DEFAULT_METRICS_INTERVAL_MS,
    );
    this.maintenanceTimer.unref();
  }

  clearTokenInvalid(botId: string): void {
    this.tokenInvalidBots.delete(botId);
  }

  isTokenInvalid(botId: string): boolean {
    return this.tokenInvalidBots.has(botId);
  }

  listStates(): ManagedBotState[] {
    return [...this.states.values()];
  }

  getState(botId: string): ManagedBotState {
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
        heapUsedBytes: null,
        guildCount: null,
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

    this.cancelPendingRestart(botId);

    const name = botName || entry.name;
    this.states.set(botId, {
      botId,
      botName: name,
      state: 'starting',
      pid: null,
      startedAt: null,
      lastError: null,
      lastSeenAt: new Date().toISOString(),
      rssBytes: null,
      heapUsedBytes: null,
      guildCount: null,
      autoRestart: entry.config.autoRestart,
    });

    const runner = this.createRunner({
      botId,
      config: entry.config,
      variableStore: this.options.variableStore,
      onLog: (level, message) => this.options.logStore.append(level, message, botId),
      sandboxScripts: this.options.sandboxScripts,
      onFatalDisconnect: (reason) => this.handleFatalDisconnect(botId, reason),
    });
    this.bots.set(botId, { runner });

    this.startingBots.add(botId);
    try {
      await runner.start();
    } catch (error) {
      this.bots.delete(botId);
      this.cancelPendingRestart(botId);
      await runner.stop().catch(() => undefined);

      const message = error instanceof Error ? error.message : String(error);
      const tokenInvalid = isDiscordTokenUnauthorized(error);
      if (tokenInvalid) {
        this.tokenInvalidBots.add(botId);
      }
      this.options.logStore.append('info', `Bot start failed: ${message}`, botId);
      const current = this.states.get(botId);
      if (current) {
        this.states.set(botId, {
          ...current,
          state: 'stopped',
          lastError: message,
          lastSeenAt: new Date().toISOString(),
          autoRestart: tokenInvalid ? false : current.autoRestart,
        });
      }
      throw error;
    } finally {
      this.startingBots.delete(botId);
    }

    const current = this.states.get(botId);
    if (current && current.state === 'starting') {
      this.states.set(botId, {
        ...current,
        state: 'running',
        startedAt: new Date().toISOString(),
        lastError: null,
        lastSeenAt: new Date().toISOString(),
        guildCount: runner.getGuildCount(),
        heapUsedBytes: runner.getHeapUsedBytes(),
      });
    }
  }

  async stopBot(botId: string): Promise<void> {
    this.cancelPendingRestart(botId);

    const bot = this.bots.get(botId);
    if (!bot) {
      const current = this.states.get(botId);
      if (current) {
        this.states.set(botId, { ...current, state: 'stopped', pid: null });
      }
      return;
    }

    this.stoppingBots.add(botId);
    try {
      await bot.runner.stop();
    } finally {
      this.stoppingBots.delete(botId);
      this.bots.delete(botId);
    }

    const current = this.states.get(botId);
    if (current) {
      this.states.set(botId, {
        ...current,
        state: 'stopped',
        pid: null,
        lastSeenAt: new Date().toISOString(),
      });
    }
  }

  async reloadBot(botId: string): Promise<boolean> {
    if (!this.isRunning(botId)) {
      return false;
    }

    const entry = await this.options.botStore.load(botId);
    if (!entry) {
      throw new Error(`Bot "${botId}" is not synced.`);
    }

    const bot = this.bots.get(botId);
    if (!bot) {
      return false;
    }

    await bot.runner.reload(entry.config);

    const current = this.states.get(botId);
    if (current) {
      this.states.set(botId, {
        ...current,
        state: 'running',
        startedAt: current.startedAt ?? new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        guildCount: bot.runner.getGuildCount(),
        autoRestart: entry.config.autoRestart,
      });
    }
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

    const bot = this.bots.get(botId);
    if (!bot) {
      throw new Error(`Bot "${botId}" is not running.`);
    }

    const handled = await bot.runner.triggerWebhook(pathKey, payload, headers);
    if (!handled) {
      throw new Error(`Inbound webhook not found: ${pathKey}`);
    }
  }

  async drainAll(): Promise<number> {
    for (const timer of this.restartTimers.values()) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();

    const running = [...this.bots.keys()];
    for (const botId of running) {
      await this.stopBot(botId);
    }
    return running.length;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.maintenanceTimer);
    await this.drainAll();
  }

  private cancelPendingRestart(botId: string): void {
    const timer = this.restartTimers.get(botId);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(botId);
    }
  }

  /**
   * Called by the runner after it has already torn itself down following a
   * fatal gateway disconnect. Never exits the process — a leftover
   * process.exit here would take down every bot on the node.
   */
  private handleFatalDisconnect(botId: string, reason: string): void {
    this.bots.delete(botId);

    const current = this.states.get(botId);
    if (!current) {
      return;
    }

    const now = new Date().toISOString();

    // startBot's catch (start failure) or stopBot (intentional stop) owns the
    // final state; just record the reason.
    if (this.startingBots.has(botId) || this.stoppingBots.has(botId)) {
      this.states.set(botId, { ...current, lastError: reason, lastSeenAt: now });
      return;
    }

    const tokenInvalid = isDiscordTokenUnauthorized(reason);
    if (tokenInvalid) {
      this.tokenInvalidBots.add(botId);
    }

    if (isDiscordGatewayDisallowedIntentsClose(null, reason)) {
      this.options.logStore.append('warn', reason, botId);
      this.states.set(botId, {
        ...current,
        state: 'stopped',
        pid: null,
        lastError: reason,
        lastSeenAt: now,
      });
      return;
    }

    this.options.logStore.append('error', `Fatal disconnect: ${reason}`, botId);
    this.states.set(botId, {
      ...current,
      state: 'error',
      pid: null,
      lastError: reason,
      lastSeenAt: now,
      autoRestart: tokenInvalid ? false : current.autoRestart,
    });

    if (current.autoRestart && !tokenInvalid && !this.tokenInvalidBots.has(botId)) {
      this.options.logStore.append('warn', 'Auto-restarting bot after fatal disconnect', botId);
      this.cancelPendingRestart(botId);
      const timer = setTimeout(() => {
        this.restartTimers.delete(botId);
        void this.startBot(botId, current.botName).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.options.logStore.append('error', `Auto-restart failed: ${message}`, botId);
        });
      }, this.restartDelayMs);
      timer.unref?.();
      this.restartTimers.set(botId, timer);
    }
  }

  private onMaintenanceTick(): void {
    if (this.disposed) {
      return;
    }

    this.tickCount += 1;
    const now = new Date().toISOString();
    let totalGuilds = 0;

    for (const [botId, bot] of this.bots) {
      const current = this.states.get(botId);
      if (!current || (current.state !== 'running' && current.state !== 'starting')) {
        continue;
      }
      if (bot.runner.disposeIdleIsolate()) {
        this.options.logStore.append('debug', '[ScriptRuntime] Disposed idle isolate', botId);
      }
      const guildCount = bot.runner.getGuildCount();
      totalGuilds += guildCount;
      this.states.set(botId, {
        ...current,
        lastSeenAt: now,
        guildCount,
        heapUsedBytes: bot.runner.getHeapUsedBytes(),
      });
    }

    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

    if (this.tickCount % MEMORY_LOG_EVERY_TICKS === 0) {
      this.options.logStore.append(
        'info',
        `[Memory] rss=${rssMb}MB bots=${this.bots.size} guilds=${totalGuilds}`,
      );
    }

    this.checkProcessMemory(rssMb);
  }

  private checkProcessMemory(rssMb: number): void {
    const uptimeMs = Date.now() - this.startedAtMs;

    const soft = evaluateSustainedRss({
      rssMb,
      thresholdMb: this.memoryPolicy.softThresholdMb,
      consecutiveOver: this.rssOverSoftStreak,
      requiredConsecutive: this.memoryPolicy.requiredConsecutive,
      uptimeMs,
      minUptimeMs: this.memoryPolicy.minUptimeMs,
    });
    this.rssOverSoftStreak = soft.nextConsecutiveOver;
    if (soft.shouldTrigger) {
      this.rssOverSoftStreak = 0;
      let disposedCount = 0;
      for (const bot of this.bots.values()) {
        if (bot.runner.disposeIdleIsolate(true)) {
          disposedCount += 1;
        }
      }
      this.options.logStore.append(
        'warn',
        `[Memory] rss=${rssMb}MB over ${this.memoryPolicy.softThresholdMb}MB soft threshold — disposed ${disposedCount} idle isolate(s)`,
      );
    }

    const critical = evaluateSustainedRss({
      rssMb,
      thresholdMb: this.memoryPolicy.criticalThresholdMb,
      consecutiveOver: this.rssOverCriticalStreak,
      requiredConsecutive: this.memoryPolicy.requiredConsecutive,
      uptimeMs,
      minUptimeMs: this.memoryPolicy.minUptimeMs,
    });
    this.rssOverCriticalStreak = critical.nextConsecutiveOver;
    if (critical.shouldTrigger) {
      this.options.logStore.append(
        'error',
        `[Memory] rss=${rssMb}MB over ${this.memoryPolicy.criticalThresholdMb}MB critical threshold — exiting so the orchestrator restarts this node`,
      );
      this.exitProcess(1);
    }
  }
}
