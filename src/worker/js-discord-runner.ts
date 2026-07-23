import { Client, Events } from 'discord.js';

import type { JsBotConfig } from '../config/js-bot-config.js';
import {
  buildEffectiveIntentsMap,
  buildSafeFallbackIntentsMap,
  fetchPortalEnabledPrivilegedIntents,
  intentsMapsEqual,
} from '../discord/application-intent-sync.js';
import { buildDiscordClientOptions } from '../discord/discord-client-options.js';
import {
  DiscordTokenUnauthorizedError,
  formatGatewayCloseMessage,
  isDiscordGatewayDisallowedIntentsClose,
  isDiscordGatewayFatalClose,
  isDiscordTokenUnauthorized,
} from '../discord/discord-auth-errors.js';
import { registerSlashCommands } from '../discord/command-registerer.js';
import { HandlerRegistry } from '../discord/handler-registry.js';
import { applyPresence } from '../discord/presence.js';
import { ScriptExecutor } from '../scripts/script-executor.js';
import type { VariableDatabase } from '../runtime/variable-database.js';

export class JsDiscordRunner {
  private client: Client | null = null;
  private registry: HandlerRegistry | null = null;
  private executor: ScriptExecutor | null = null;
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
    ) => void,
    private readonly sandboxScripts = false,
    private readonly onFatalDisconnect?: (reason: string) => void,
  ) {}

  getGuildCount(): number {
    return this.guildCount;
  }

  /** Heap used by the bot's sandbox isolate, or null without a sandbox. */
  getHeapUsedBytes(): number | null {
    return this.executor?.getHeapUsedBytes() ?? null;
  }

  /**
   * Disposes the bot's sandbox isolate when idle (or unconditionally between
   * runs when `force` is set). It is recreated on the next script execution.
   */
  disposeIdleIsolate(force = false): boolean {
    return this.executor?.disposeIdleIsolate(force) ?? false;
  }

  private async resolveEffectiveIntents(): Promise<Record<string, boolean>> {
    const warnings: string[] = [];
    try {
      const portalSync = await fetchPortalEnabledPrivilegedIntents(this.config.token);
      const effective = buildEffectiveIntentsMap(this.config, portalSync.enabled, warnings);
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
      const effective = buildSafeFallbackIntentsMap(this.config, warnings);
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

    this.client = new Client(buildDiscordClientOptions(this.effectiveIntents));

    this.onLog(
      'info',
      this.sandboxScripts
        ? '[ScriptRuntime] Sandboxed (managed runner)'
        : '[ScriptRuntime] Direct (unrestricted require)',
    );
    this.onLog(
      'info',
      `[DiscordCache] Minimal cache enabled; intents: ${this.enabledIntentNames().join(', ') || 'Guilds only'}`,
    );

    this.executor = new ScriptExecutor(this.config.scriptTimeoutMs, {
      sandboxed: this.sandboxScripts,
    });
    this.registry = new HandlerRegistry(
      this.client,
      this.config,
      this.botId,
      this.executor,
      this.variableStore,
      (level, message) => this.onLog(level, message),
    );

    this.mountGatewayLifecycleHandlers();

    this.client.once(Events.ClientReady, (client) => {
      applyPresence(client, this.config);
      this.guildCount = client.guilds.cache.size;
      this.onLog(
        'info',
        `Discord client ready as ${client.user?.tag ?? client.user?.username ?? 'unknown'} (${this.guildCount} server(s))`,
      );
      void registerSlashCommands(client, this.config.token, this.config.commands ?? []).catch(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.onLog('error', `Failed to register slash commands: ${message}`);
        },
      );
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
    const nextEffective = await this.resolveEffectiveIntents();
    const intentsChanged = !intentsMapsEqual(this.effectiveIntents, nextEffective);
    const tokenChanged = this.config.token.trim() !== config.token.trim();

    this.config = config;

    if (intentsChanged || tokenChanged) {
      this.onLog('info', 'Intents or token changed — reconnecting Discord client...');
      await this.start();
      return;
    }

    if (!this.client || !this.registry) {
      return;
    }

    this.registry.updateConfig(config);
    applyPresence(this.client, config);
    await registerSlashCommands(this.client, config.token, config.commands ?? []);
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

    if (this.client) {
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
