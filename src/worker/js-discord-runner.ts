import { Client, Events } from 'discord.js';

import type { CommandHandler, JsBotConfig } from '../config/js-bot-config.js';
import {
  buildEffectiveIntentsMap,
  buildSafeFallbackIntentsMap,
  describePortalSyncFailure,
  getLastKnownPortalIntents,
  rememberPortalIntents,
  fetchPortalEnabledPrivilegedIntents,
  intentsMapsEqual,
} from '../discord/application-intent-sync.js';
import { buildDiscordClientOptions } from '../discord/discord-client-options.js';
import {
  DiscordTokenUnauthorizedError,
  DiscordUnavailableError,
  asDiscordUnavailable,
  discordIpBlockRemainingMs,
  formatGatewayCloseMessage,
  isDiscordGatewayDisallowedIntentsClose,
  isDiscordGatewayFatalClose,
  isDiscordTokenUnauthorized,
} from '../discord/discord-auth-errors.js';
import { discordRest, removeStaleSlashCommands } from '../discord/command-registerer.js';
import { HandlerRegistry } from '../discord/handler-registry.js';
import { applyPresence, stopPresenceRotation } from '../discord/presence.js';
import { ScriptExecutor } from '../scripts/script-executor.js';
import { mergeScopedVariableDefinitions } from '../runtime/scoped-context.js';
import type { VariableDatabase } from '../runtime/variable-database.js';
import { DatabaseManager } from '../runtime/database-manager.js';
import type { LogOrigin } from '../runtime/log-store.js';

export class JsDiscordRunner {
  private client: Client | null = null;
  private registry: HandlerRegistry | null = null;
  private executor: ScriptExecutor | null = null;
  private databaseManager: DatabaseManager | null = null;
  private startedAt: string | null = null;
  private lastError: string | null = null;
  private effectiveIntents: Record<string, boolean> = {};
  private guildCount = 0;
  private fatalDisconnectHandled = false;

  constructor(
    private readonly botId: string,
    private config: JsBotConfig,
    private readonly variableStore: VariableDatabase,
    private readonly onLog: (
      level: 'info' | 'warn' | 'error' | 'debug',
      message: string,
      origin?: LogOrigin,
    ) => void,
    private readonly onFatalDisconnect?: (reason: string) => void,
  ) {}

  getGuildCount(): number {
    return this.guildCount;
  }

  /** Process V8 heap used bytes while the bot is running. */
  getHeapUsedBytes(): number | null {
    return this.executor?.getHeapUsedBytes() ?? null;
  }

  private async resolveEffectiveIntents(config: JsBotConfig = this.config): Promise<Record<string, boolean>> {
    const warnings: string[] = [];
    try {
      const portalSync = await fetchPortalEnabledPrivilegedIntents(config.token);
      rememberPortalIntents(this.botId, portalSync.enabled);
      const effective = buildEffectiveIntentsMap(config, portalSync.enabled, warnings);
      for (const warning of warnings) {
        this.onLog('warn', `Intent warning: ${warning}`);
      }
      return effective;
    } catch (error) {
      if (isDiscordTokenUnauthorized(error)) {
        throw error instanceof DiscordTokenUnauthorizedError
          ? error
          : new DiscordTokenUnauthorizedError(
              'Discord bot token is invalid or unauthorized while resolving intents',
              { cause: error },
            );
      }
      const effective = buildSafeFallbackIntentsMap(config, warnings, {
        cause: describePortalSyncFailure(error),
        lastKnown: getLastKnownPortalIntents(this.botId),
      });
      for (const warning of warnings) {
        this.onLog('warn', `Intent warning: ${warning}`);
      }
      return effective;
    }
  }

  private enabledIntentNames(): string[] {
    return Object.entries(this.effectiveIntents)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
  }

  private mountGatewayLifecycleHandlers(): void {
    if (!this.client) {
      return;
    }

    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      const code = event.code;
      const detail = formatGatewayCloseMessage(code, event.reason);
      const fullDetail = `Shard ${shardId}: ${detail}`;
      this.lastError = fullDetail;

      if (isDiscordGatewayDisallowedIntentsClose(code, event.reason)) {
        this.onLog('warn', fullDetail);
        void this.handleDisallowedIntentsDisconnect(fullDetail);
        return;
      }

      this.onLog('error', fullDetail);
      if (isDiscordGatewayFatalClose(code, event.reason)) {
        void this.handleFatalDisconnect(fullDetail);
      }
    });

    this.client.on(Events.Invalidated, () => {
      const detail = 'Discord session invalidated';
      this.lastError = detail;
      this.onLog('error', detail);
      void this.handleFatalDisconnect(detail);
    });
  }

  private async handleDisallowedIntentsDisconnect(reason: string): Promise<void> {
    if (this.fatalDisconnectHandled) {
      return;
    }
    this.fatalDisconnectHandled = true;
    await this.stop();
    this.onFatalDisconnect?.(reason);
  }

  private async handleFatalDisconnect(reason: string): Promise<void> {
    if (this.fatalDisconnectHandled) {
      return;
    }
    this.fatalDisconnectHandled = true;
    this.onLog('error', `Fatal gateway disconnect — stopping bot: ${reason}`);
    await this.stop();
    this.onFatalDisconnect?.(reason);
  }

  async start(): Promise<void> {
    await this.stop();

    this.fatalDisconnectHandled = false;
    this.effectiveIntents = await this.resolveEffectiveIntents();

    // Blocage d'IP connu (détecté à la lecture des intents ou par un login précédent) :
    // inutile de créer un client et de retenter une connexion qui échouera pareil.
    const blockedMs = discordIpBlockRemainingMs();
    if (blockedMs > 0) {
      const blocked = new DiscordUnavailableError('blocked', blockedMs / 1000);
      this.lastError = blocked.message;
      throw blocked;
    }

    this.client = new Client(buildDiscordClientOptions(this.effectiveIntents));

    this.onLog('info', '[ScriptRuntime] Direct (process isolation via pod/cgroup)');
    this.onLog(
      'info',
      `[DiscordCache] Minimal cache enabled; intents: ${this.enabledIntentNames().join(', ') || 'Guilds only'}`,
    );

    this.executor = new ScriptExecutor(this.config.scriptTimeoutMs);
    this.databaseManager = new DatabaseManager(this.config.databaseConfig);
    this.registry = new HandlerRegistry(
      this.client,
      this.config,
      this.botId,
      this.executor,
      this.variableStore,
      // Journaux des scripts et des handlers : leur volume suit le trafic, pas le runner.
      (level, message) => this.onLog(level, message, 'script'),
      this.databaseManager.handles,
    );

    this.mountGatewayLifecycleHandlers();

    this.client.once(Events.ClientReady, (client) => {
      applyPresence(client, this.config);
      this.guildCount = client.guilds.cache.size;
      this.onLog(
        'info',
        `Discord client ready as ${client.user?.tag ?? client.user?.username ?? 'unknown'} (${this.guildCount} server(s))`,
      );
      // Les commandes sont publiées par le Manager (bot Cloud) ou l'application (bot local), jamais ici.
      this.onLog('info', 'Slash commands are published by the Manager or the app; this runner only executes them.');
    });

    this.client.on('error', (error: Error) => {
      this.lastError = error.message;
      this.onLog('error', `Discord client error: ${error.message}`);
      if (isDiscordTokenUnauthorized(error) || isDiscordGatewayFatalClose(null, error.message)) {
        void this.handleFatalDisconnect(error.message);
      }
    });

    this.registry.mount();
    try {
      await this.client.login(this.config.token);
    } catch (error) {
      // 429 au login : erreur typée (le RateLimitError de discord.js a un message vide).
      const unavailable = asDiscordUnavailable(error);
      if (unavailable) {
        this.lastError = unavailable.message;
        await this.stop();
        throw unavailable;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      if (isDiscordTokenUnauthorized(error) || isDiscordGatewayFatalClose(null, message)) {
        await this.stop();
        this.onFatalDisconnect?.(message);
      }
      throw error;
    }
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    this.guildCount = this.client.guilds.cache.size;
  }

  async reload(config: JsBotConfig): Promise<void> {
    const previousCommands = this.config.commands ?? [];
    config.scopedVariableDefinitions = mergeScopedVariableDefinitions(
      config.scopedVariableDefinitions,
      this.config.scopedVariableDefinitions,
    );
    // Les intents se résolvent sur la NOUVELLE configuration : avec l'ancienne,
    // la comparaison portait sur elle-même et un changement n'était jamais vu.
    const nextEffective = await this.resolveEffectiveIntents(config);
    const intentsChanged = !intentsMapsEqual(this.effectiveIntents, nextEffective);
    const tokenChanged = this.config.token.trim() !== config.token.trim();
    const dbConfigChanged =
      JSON.stringify(this.config.databaseConfig) !== JSON.stringify(config.databaseConfig);

    if (dbConfigChanged) {
      await this.databaseManager?.dispose();
      this.databaseManager = new DatabaseManager(config.databaseConfig);
    }

    this.config = config;

    // Pendant un blocage d'IP, une reconnexion ne peut pas aboutir et start() détruirait d'abord
    // le client sain : seul un changement de jeton force le passage par start(). Pour les intents,
    // on garde le client et les intents actuels ; la reconnexion se refera au prochain reload
    // (this.effectiveIntents reste différent des intents attendus).
    const blockedMs = discordIpBlockRemainingMs();
    if (tokenChanged || (intentsChanged && blockedMs === 0)) {
      this.onLog('info', 'Intents or token changed — reconnecting Discord client...');
      await this.start();
      return;
    }
    if (intentsChanged) {
      this.onLog(
        'warn',
        `Intents changed but the reconnection is deferred: Discord is blocking requests from this network (retry after ${Math.ceil(blockedMs / 1000)}s)`,
      );
    }

    if (!this.client || !this.registry) {
      return;
    }

    this.registry.updateConfig(config, this.databaseManager?.handles);
    applyPresence(this.client, config);
    await this.propagateRemovals(previousCommands, config.commands ?? [], config.token);
  }

  /** Seule la suppression basique est propagée chez Discord : jamais de création ni de modification. */
  private async propagateRemovals(
    before: CommandHandler[],
    after: CommandHandler[],
    token: string,
  ): Promise<void> {
    if (!this.client) return;
    try {
      const removed = await removeStaleSlashCommands(this.client, before, after, discordRest(token));
      if (removed.length > 0) {
        this.onLog('info', `Slash commands removed from Discord: ${removed.join(', ')}.`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.onLog('error', `Failed to remove slash commands from Discord: ${message}`);
    }
  }

  async upsertCommand(command: CommandHandler): Promise<void> {
    const nextCommands = (this.config.commands ?? []).filter((c) => c.id !== command.id);
    nextCommands.push(command);
    const previousCommands = this.config.commands ?? [];
    this.config = { ...this.config, commands: nextCommands };

    if (!this.registry) {
      return;
    }

    this.registry.upsertCommand(command);

    // Un renommage retire l'ancien nom chez Discord ; le nouveau est publié par le Manager.
    void this.propagateRemovals(previousCommands, nextCommands, this.config.token);
  }

  async deleteCommand(commandId: string): Promise<void> {
    const previousCommands = this.config.commands ?? [];
    const nextCommands = previousCommands.filter((c) => c.id !== commandId);
    this.config = { ...this.config, commands: nextCommands };

    if (!this.registry) {
      return;
    }

    this.registry.deleteCommand(commandId);

    void this.propagateRemovals(previousCommands, nextCommands, this.config.token);
  }

  async triggerWebhook(
    pathKey: string,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<boolean> {
    if (!this.registry) {
      return false;
    }
    return this.registry.triggerWebhook(pathKey, payload, headers);
  }

  async stop(): Promise<void> {
    this.registry?.clear();
    this.registry = null;
    this.executor?.dispose();
    this.executor = null;
    await this.databaseManager?.dispose();
    this.databaseManager = null;

    if (this.client) {
      stopPresenceRotation(this.client);
      await this.client.destroy();
      this.client = null;
    }

    this.startedAt = null;
    this.guildCount = 0;
  }

  getStatus(): {
    state: 'running' | 'stopped';
    startedAt: string | null;
    lastError: string | null;
    guildCount: number;
  } {
    const running = this.client !== null && this.client.isReady();
    if (running && this.client) {
      this.guildCount = this.client.guilds.cache.size;
    }
    return {
      state: running ? 'running' : 'stopped',
      startedAt: this.startedAt,
      lastError: this.lastError,
      guildCount: this.guildCount,
    };
  }
}

/**
 * One log line per registration, saying WHAT happened.
 *
 * "No commands in Discord" is otherwise diagnosed by hand in the bot log: a bot
 * whose configuration carries no command reports "already up to date (0
 * unchanged)", which is not the same thing as a registration failure — and the
 * old version logged nothing at all on success.
 */
