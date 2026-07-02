import type { Client, Guild, Interaction, Message, TextChannel } from 'discord.js';

import type { JsBotConfig } from '../config/js-bot-config.js';

export interface ScriptExecutionContext {
  client: Client;
  config: JsBotConfig;
  variables: Record<string, unknown>;
  interaction?: Interaction;
  message?: Message;
  member?: Interaction['member'] | Message['member'] | null;
  guild?: Guild | null;
  channel?: TextChannel | Interaction['channel'] | Message['channel'] | null;
  webhook?: {
    path: string;
    payload: unknown;
    headers: Record<string, string>;
  };
}

export interface ScriptLogger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}
