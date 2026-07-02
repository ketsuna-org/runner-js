import { Client, Events } from 'discord.js';

import type { JsBotConfig } from '../config/js-bot-config.js';
import { registerSlashCommands } from '../discord/command-registerer.js';
import { HandlerRegistry } from '../discord/handler-registry.js';
import { mapIntents } from '../discord/intent-mapper.js';
import { applyPresence } from '../discord/presence.js';
import { ScriptExecutor } from '../scripts/script-executor.js';
import type { VariableDatabase } from '../runtime/variable-database.js';

export class JsDiscordRunner {
  private client: Client | null = null;
  private registry: HandlerRegistry | null = null;
  private startedAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly botId: string,
    private config: JsBotConfig,
    private readonly variableStore: VariableDatabase,
    private readonly onLog: (
      level: 'info' | 'warn' | 'error' | 'debug',
      message: string,
    ) => void,
  ) {}

  async start(): Promise<void> {
    await this.stop();

    this.client = new Client({
      intents: mapIntents(this.config.intents),
    });

    this.registry = new HandlerRegistry(
      this.client,
      this.config,
      this.botId,
      new ScriptExecutor(this.config.scriptTimeoutMs),
      this.variableStore,
      (level, message) => this.onLog(level, message),
    );

    this.client.once(Events.ClientReady, (client) => {
      applyPresence(client, this.config);
      void registerSlashCommands(client, this.config.token, this.config.commands).catch(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.onLog('error', `Failed to register slash commands: ${message}`);
        },
      );
    });

    this.client.on('error', (error: Error) => {
      this.lastError = error.message;
      this.onLog('error', `Discord client error: ${error.message}`);
    });

    this.registry.mount();
    await this.client.login(this.config.token);
    this.startedAt = new Date().toISOString();
    this.lastError = null;
  }

  async reload(config: JsBotConfig): Promise<void> {
    this.config = config;
    if (!this.client || !this.registry) {
      return;
    }

    this.registry.updateConfig(config);
    applyPresence(this.client, config);
    await registerSlashCommands(this.client, config.token, config.commands);
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

    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }

    this.startedAt = null;
  }

  getStatus(): {
    state: 'running' | 'stopped';
    startedAt: string | null;
    lastError: string | null;
  } {
    const running = this.client !== null && this.client.isReady();
    return {
      state: running ? 'running' : 'stopped',
      startedAt: this.startedAt,
      lastError: this.lastError,
    };
  }
}
