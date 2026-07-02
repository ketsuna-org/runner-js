import {
  Events,
  type Client,
  type Interaction,
  type Message,
} from 'discord.js';

import type {
  CommandHandler,
  EventHandler,
  InboundWebhookHandler,
  JsBotConfig,
  ScheduledHandler,
} from '../config/js-bot-config.js';
import type { ScriptExecutor } from '../scripts/script-executor.js';
import type { ScriptLogger } from '../scripts/script-context.js';

type HandlerDisposer = () => void;

export class HandlerRegistry {
  private readonly disposers: HandlerDisposer[] = [];
  private readonly scheduledTimers: NodeJS.Timeout[] = [];
  private readonly commandMap = new Map<string, CommandHandler>();
  private readonly eventMap = new Map<string, EventHandler>();
  private readonly webhookMap = new Map<string, InboundWebhookHandler>();
  private readonly inFlightInteractions = new Set<string>();
  private readonly handledInteractions = new Set<string>();
  private variables: Record<string, unknown>;

  constructor(
    private readonly client: Client,
    private config: JsBotConfig,
    private readonly botId: string,
    private readonly executor: ScriptExecutor,
    private readonly emitLog: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void,
  ) {
    this.variables = { ...config.globalVariables };
  }

  mount(): void {
    this.clear();

    for (const command of this.config.commands) {
      if (command.enabled === false) {
        continue;
      }
      this.commandMap.set(command.name.trim().toLowerCase(), command);
    }

    for (const event of this.config.events) {
      if (event.enabled === false) {
        continue;
      }
      this.eventMap.set(event.name.trim(), event);
      this.attachEvent(event);
    }

    for (const webhook of this.config.inboundWebhooks) {
      if (webhook.enabled === false) {
        continue;
      }
      this.webhookMap.set(webhook.path.trim().toLowerCase(), webhook);
    }

    for (const scheduled of this.config.scheduled ?? []) {
      if (scheduled.enabled === false) {
        continue;
      }
      this.attachScheduled(scheduled);
    }

    const onInteraction = async (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }

      if (!this.tryAcquireInteraction(interaction.id)) {
        return;
      }

      const handler = this.commandMap.get(interaction.commandName.trim().toLowerCase());
      if (!handler) {
        this.releaseInteraction(interaction.id);
        return;
      }

      try {
        await this.runScript(handler.script, {
          interaction,
          guild: interaction.guild,
          member: interaction.member,
          channel: interaction.channel,
        });
      } finally {
        this.releaseInteraction(interaction.id);
      }
    };

    this.client.on(Events.InteractionCreate, onInteraction);
    this.disposers.push(() => this.client.off(Events.InteractionCreate, onInteraction));

    if (this.config.prefix) {
      const onMessage = async (message: Message) => {
        if (message.author.bot || !message.content.startsWith(this.config.prefix!)) {
          return;
        }

        const withoutPrefix = message.content.slice(this.config.prefix!.length).trim();
        const commandName = withoutPrefix.split(/\s+/)[0]?.toLowerCase();
        if (!commandName) {
          return;
        }

        const handler = this.commandMap.get(commandName);
        if (!handler) {
          return;
        }

        await this.runScript(handler.script, {
          message,
          guild: message.guild,
          member: message.member,
          channel: message.channel,
        });
      };

      this.client.on(Events.MessageCreate, onMessage);
      this.disposers.push(() => this.client.off(Events.MessageCreate, onMessage));
    }
  }

  updateConfig(config: JsBotConfig): void {
    this.config = config;
    this.variables = { ...config.globalVariables };
    this.mount();
  }

  getWebhookHandler(pathKey: string): InboundWebhookHandler | undefined {
    return this.webhookMap.get(pathKey.trim().toLowerCase());
  }

  async triggerWebhook(
    pathKey: string,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<boolean> {
    const handler = this.getWebhookHandler(pathKey);
    if (!handler) {
      return false;
    }

    await this.runScript(handler.script, {
      webhook: { path: pathKey, payload, headers },
    });
    return true;
  }

  clear(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;

    for (const timer of this.scheduledTimers) {
      clearInterval(timer);
    }
    this.scheduledTimers.length = 0;

    this.commandMap.clear();
    this.eventMap.clear();
    this.webhookMap.clear();
  }

  private attachEvent(handler: EventHandler): void {
    const eventName = handler.name.trim();
    const listener = async (...args: unknown[]) => {
      const [first] = args;
      const message = isMessage(first) ? first : undefined;
      const interaction = isInteraction(first) ? first : undefined;

      if (interaction?.isChatInputCommand()) {
        const slashHandler = this.commandMap.get(
          interaction.commandName.trim().toLowerCase(),
        );
        if (slashHandler) {
          return;
        }
      }

      await this.runScript(handler.script, {
        message,
        interaction,
        guild: message?.guild ?? interaction?.guild ?? null,
        member: message?.member ?? null,
        channel: message?.channel ?? interaction?.channel ?? null,
        webhook: undefined,
      });
    };

    this.client.on(eventName, listener);
    this.disposers.push(() => this.client.off(eventName, listener));
  }

  private attachScheduled(handler: ScheduledHandler): void {
    const intervalMs = handler.everyMinutes * 60_000;
    const timer = setInterval(() => {
      void this.runScript(handler.script, {});
    }, intervalMs);
    this.scheduledTimers.push(timer);
  }

  private async runScript(
    script: string,
    partial: {
      interaction?: Interaction;
      message?: Message;
      guild?: Message['guild'] | Interaction['guild'] | null;
      member?: Message['member'] | Interaction['member'] | null;
      channel?: Message['channel'] | Interaction['channel'] | null;
      webhook?: { path: string; payload: unknown; headers: Record<string, string> };
    },
  ): Promise<void> {
    const logger = this.createLogger();

    try {
      await this.executor.execute(
        script,
        {
          client: this.client,
          config: this.config,
          variables: this.variables,
          interaction: partial.interaction,
          message: partial.message,
          guild: partial.guild ?? null,
          member: partial.member ?? null,
          channel: (partial.channel as never) ?? null,
          webhook: partial.webhook,
        },
        logger,
        this.config.scriptTimeoutMs,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        isUnknownInteractionError(message) &&
        partial.interaction?.isRepliable() &&
        (partial.interaction.replied || partial.interaction.deferred)
      ) {
        this.emitLog(
          'debug',
          `Ignored duplicate interaction response for ${partial.interaction.id}`,
        );
        return;
      }
      this.emitLog('error', `Handler script failed: ${message}`);
    }
  }

  private tryAcquireInteraction(interactionId: string): boolean {
    if (this.inFlightInteractions.has(interactionId) || this.handledInteractions.has(interactionId)) {
      return false;
    }

    this.inFlightInteractions.add(interactionId);
    return true;
  }

  private releaseInteraction(interactionId: string): void {
    this.inFlightInteractions.delete(interactionId);
    this.handledInteractions.add(interactionId);

    if (this.handledInteractions.size > 500) {
      this.handledInteractions.clear();
    }
  }

  private createLogger(): ScriptLogger {
    return {
      log: (...args: unknown[]) => this.emitLog('info', args.map(String).join(' ')),
      info: (...args: unknown[]) => this.emitLog('info', args.map(String).join(' ')),
      warn: (...args: unknown[]) => this.emitLog('warn', args.map(String).join(' ')),
      error: (...args: unknown[]) => this.emitLog('error', args.map(String).join(' ')),
      debug: (...args: unknown[]) => this.emitLog('debug', args.map(String).join(' ')),
    };
  }
}

function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && 'author' in value && 'content' in value;
}

function isInteraction(value: unknown): value is Interaction {
  return typeof value === 'object' && value !== null && 'isChatInputCommand' in value;
}

function isUnknownInteractionError(message: string): boolean {
  return message.includes('Unknown interaction');
}
