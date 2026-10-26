import type { CommandHandler, JsBotConfig } from '../config/js-bot-config.js';
import {
  discordIpBlockRemainingMs,
  isDiscordGatewayDisallowedIntentsClose,
  isDiscordTokenUnauthorized,
} from '../discord/discord-auth-errors.js';
import {
  DiscordRestStats,
  emptyDiscordRestSnapshot,
  type DiscordRestSnapshot,
} from '../discord/rest-observability.js';
import { JsDiscordRunner } from '../worker/js-discord-runner.js';
import type { BotStore } from './bot-store.js';
import type { LogOrigin, LogStore } from './log-store.js';
import type { ScheduledSnapshot } from './scheduled-tasks.js';
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
  /** Compteurs des réponses REST de Discord pour ce bot (voir rest-observability.ts). */
  discordRest?: DiscordRestSnapshot;
}

/** Compatibility alias from the per-bot worker-process era. */
export type ManagedWorkerState = ManagedBotState;

/** The subset of JsDiscordRunner the supervisor drives (injectable in tests). */
export interface BotRunnerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  reload(config: JsBotConfig): Promise<void>;
  upsertCommand?(command: CommandHandler): Promise<void>;
  deleteCommand?(commandId: string): Promise<void>;
  triggerWebhook(
    pathKey: string,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<boolean>;
  getGuildCount(): number;
  getHeapUsedBytes(): number | null;
  /** Tâches planifiées du bot (prochaine échéance, dernier résultat) ; absent pour un runner qui n'en a pas. */
  getScheduledSnapshot?(): ScheduledSnapshot;
  /** Une variable a été écrite par l'API du runner (hors scripts) : le runner vide ses lectures mises en cache. */
  notifyVariableWrite?(storageKey: string): void;
}

export interface CreateRunnerParams {
  botId: string;
  config: JsBotConfig;
  variableStore: VariableDatabase;
  onLog: (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    origin?: LogOrigin,
  ) => void;
  onFatalDisconnect: (reason: string) => void;
  /** Compteurs REST du bot : les mêmes pour tous les runners successifs d'un même bot. */
  restStats: DiscordRestStats;
  /** Dossier d'état du nœud (marqueurs de `runOnStart`). */
  stateDir?: string;
}

export interface BotSupervisorOptions {
  botStore: BotStore;
  logStore: LogStore;
  variableStore: VariableDatabase;
  /**
   * Max concurrent bots on this node. When <= 1 (JS 1:1 pods), refuse starting
   * a second bot as defense in depth.
   */
  maxBots: number;
  /** Runner factory, overridable in tests. Defaults to JsDiscordRunner. */
  createRunner?: (params: CreateRunnerParams) => BotRunnerHandle;
  /** Delay before auto-restarting a bot after a fatal disconnect. */
  restartDelayMs?: number;
  /** Interval of the metrics/memory maintenance tick. */
  metricsIntervalMs?: number;
  /** Dossier d'état du nœud, transmis aux runners (marqueurs de `runOnStart`). */
  stateDir?: string;
}

const DEFAULT_RESTART_DELAY_MS = 2000;
const DEFAULT_METRICS_INTERVAL_MS = 5000;
// Gigue ajoutée au redémarrage différé par un blocage d'IP (évite une reconnexion pile à l'expiration).
const RESTART_AFTER_BLOCK_JITTER_MS = 5000;
const MEMORY_LOG_EVERY_TICKS = 60; // ~5 minutes at the default tick interval

interface ManagedBot {
  runner: BotRunnerHandle;
}

/**
 * In-process supervisor for bots on this node. Each bot is a JsDiscordRunner
 * (discord.js client + script executor) inside the shared process. JS pool
 * nodes run with maxBots=1 so isolation is the pod/cgroup, not in-process
 * sandboxing.
 */
export class BotSupervisor {
  private readonly bots = new Map<string, ManagedBot>();
  private readonly states = new Map<string, ManagedBotState>();
  private readonly startingBots = new Set<string>();
  private readonly stoppingBots = new Set<string>();
  private readonly tokenInvalidBots = new Set<string>();
  // Un runner (donc un client discord.js) est recréé à chaque démarrage : un bot qui boucle sur ses
  // redémarrages est le cas où les compteurs REST doivent survivre. Une entrée par bot vu sur ce nœud.
  private readonly restStats = new Map<string, DiscordRestStats>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  // Fin (réussie ou non) du start() en cours d'un bot, et file des reloads d'un bot : un reload ne
  // doit jamais chevaucher un start() ni un autre reload (ils partagent client et registry).
  private readonly startSettled = new Map<string, Promise<void>>();
  private readonly reloadTails = new Map<string, Promise<void>>();
  private readonly createRunner: (params: CreateRunnerParams) => BotRunnerHandle;
  private readonly restartDelayMs: number;
  private readonly maintenanceTimer: NodeJS.Timeout;
  private maxBots: number;
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
          params.onFatalDisconnect,
          params.restStats,
          { stateDir: params.stateDir },
        ));
    this.maxBots = options.maxBots;
    this.restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    this.maintenanceTimer = setInterval(
      () => this.onMaintenanceTick(),
      options.metricsIntervalMs ?? DEFAULT_METRICS_INTERVAL_MS,
    );
    this.maintenanceTimer.unref();
  }

  setMaxBots(maxBots: number): void {
    this.maxBots = maxBots;
  }

  clearTokenInvalid(botId: string): void {
    this.tokenInvalidBots.delete(botId);
  }

  isTokenInvalid(botId: string): boolean {
    return this.tokenInvalidBots.has(botId);
  }

  listStates(): ManagedBotState[] {
    return [...this.states.values()].map((state) => this.withRestSnapshot(state));
  }

  getState(botId: string): ManagedBotState {
    return this.withRestSnapshot(
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
      },
    );
  }

  /** Tâches planifiées d'un bot qui tourne (null sinon). */
  getScheduledSnapshot(botId: string): ScheduledSnapshot | null {
    return this.bots.get(botId)?.runner.getScheduledSnapshot?.() ?? null;
  }

  /** Lecture seule : un identifiant inconnu n'ajoute rien à la table des compteurs. */
  private withRestSnapshot(state: ManagedBotState): ManagedBotState {
    return {
      ...state,
      discordRest: this.restStats.get(state.botId)?.snapshot() ?? emptyDiscordRestSnapshot(),
    };
  }

  private restStatsFor(botId: string): DiscordRestStats {
    let stats = this.restStats.get(botId);
    if (!stats) {
      stats = new DiscordRestStats();
      this.restStats.set(botId, stats);
    }
    return stats;
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

    // Defense in depth for JS 1:1 pods — refuse a second bot when maxBots <= 1.
    if (this.maxBots <= 1 && this.runningCount >= 1) {
      throw new Error(
        `This runner only allows ${this.maxBots} bot(s) (maxBots=${this.maxBots}).`,
      );
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
      onLog: (level, message, origin) =>
        this.options.logStore.append(level, message, botId, origin),
      onFatalDisconnect: (reason) => this.handleFatalDisconnect(botId, reason),
      restStats: this.restStatsFor(botId),
      stateDir: this.options.stateDir,
    });
    this.bots.set(botId, { runner });

    this.startingBots.add(botId);
    let settleStart!: () => void;
    this.startSettled.set(
      botId,
      new Promise<void>((resolve) => {
        settleStart = () => {
          this.startSettled.delete(botId);
          resolve();
        };
      }),
    );
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
      this.options.logStore.append('error', `Bot start failed: ${message}`, botId);
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
      settleStart();
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
    settleStart();
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

  /**
   * Les reloads d'un même bot passent l'un après l'autre et attendent la fin d'un start() en
   * cours : reload() peut se reconnecter via start() et détruirait le client que le premier
   * start() est en train de connecter. La configuration est relue une fois l'attente terminée.
   */
  async reloadBot(botId: string): Promise<boolean> {
    const previous = this.reloadTails.get(botId) ?? Promise.resolve();
    const run = previous.then(() => this.reloadBotNow(botId));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.reloadTails.set(botId, tail);
    try {
      return await run;
    } finally {
      if (this.reloadTails.get(botId) === tail) {
        this.reloadTails.delete(botId);
      }
    }
  }

  private async reloadBotNow(botId: string): Promise<boolean> {
    await this.startSettled.get(botId);
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

    try {
      await bot.runner.reload(entry.config);
    } catch (error) {
      // reload() peut avoir détruit le client (reconnexion échouée) : le bot ne
      // tourne plus, et l'état « running » restait affiché sans aucune erreur.
      const message = error instanceof Error ? error.message : String(error);
      this.options.logStore.append('error', `Bot reload failed: ${message}`, botId);
      const failed = this.states.get(botId);
      if (failed) {
        this.states.set(botId, {
          ...failed,
          state: 'error',
          lastError: message,
          lastSeenAt: new Date().toISOString(),
        });
      }
      throw error;
    }

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

  /** Écriture d'une variable par l'API : prévient le runner du bot, s'il tourne. */
  notifyVariableWrite(botId: string, storageKey: string): void {
    this.bots.get(botId)?.runner.notifyVariableWrite?.(storageKey);
  }

  async upsertCommand(botId: string, command: CommandHandler): Promise<void> {
    if (!this.isRunning(botId)) {
      return;
    }
    const bot = this.bots.get(botId);
    if (!bot) {
      return;
    }
    await bot.runner.upsertCommand?.(command);
  }

  async deleteCommand(botId: string, commandId: string): Promise<void> {
    if (!this.isRunning(botId)) {
      return;
    }
    const bot = this.bots.get(botId);
    if (!bot) {
      return;
    }
    await bot.runner.deleteCommand?.(commandId);
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
      // Blocage d'IP actif : se reconnecter ne ferait que l'entretenir, donc aucun redémarrage
      // pendant le blocage. Un seul est programmé après son expiration (plus une petite
      // gigue) : sans lui le bot restait en erreur, rien d'autre ne le relançant.
      const blockedMs = discordIpBlockRemainingMs();
      let delayMs = this.restartDelayMs;
      if (blockedMs > 0) {
        delayMs = Math.max(
          this.restartDelayMs,
          blockedMs + Math.floor(Math.random() * RESTART_AFTER_BLOCK_JITTER_MS),
        );
        this.options.logStore.append(
          'warn',
          `Auto-restart deferred: Discord is blocking requests from this network (retry in ${Math.ceil(delayMs / 1000)}s)`,
          botId,
        );
      } else {
        this.options.logStore.append('warn', 'Auto-restarting bot after fatal disconnect', botId);
      }
      this.cancelPendingRestart(botId);
      const timer = setTimeout(() => {
        this.restartTimers.delete(botId);
        void this.startBot(botId, current.botName).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.options.logStore.append('error', `Auto-restart failed: ${message}`, botId);
        });
      }, delayMs);
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
    const heapUsedBytes = process.memoryUsage().heapUsed;

    for (const [botId, bot] of this.bots) {
      const current = this.states.get(botId);
      if (!current || (current.state !== 'running' && current.state !== 'starting')) {
        continue;
      }
      const guildCount = bot.runner.getGuildCount();
      totalGuilds += guildCount;
      this.states.set(botId, {
        ...current,
        lastSeenAt: now,
        guildCount,
        // 1 bot = 1 process: report process V8 heap on the running bot.
        heapUsedBytes: bot.runner.getHeapUsedBytes() ?? heapUsedBytes,
      });
    }

    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

    if (this.tickCount % MEMORY_LOG_EVERY_TICKS === 0) {
      this.options.logStore.append(
        'debug',
        `[Memory] rss=${rssMb}MB bots=${this.bots.size} guilds=${totalGuilds}`,
      );
    }
  }
}
