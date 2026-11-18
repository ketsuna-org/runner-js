import type { Client, Guild, Interaction, Message, TextChannel } from 'discord.js';

import type { JsBotConfig } from '../config/js-bot-config.js';

export interface ScriptOrigin {
  kind: 'command' | 'workflow';
  name: string;
}

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
  db?: import('./script-db.js').ScriptDb;
  sql?: import('../runtime/database-manager.js').SqlInterface;
  pgsql?: import('../runtime/database-manager.js').PgsqlInterface;
  mongo?: import('../runtime/database-manager.js').MongoInterface;
  /** Commande ou workflow dont le script s'exécute : étiquette des statistiques de crédits IA (jamais un identifiant). */
  origin?: ScriptOrigin;
  /** Musique du bot (global `voice`), liée au serveur du déclencheur. */
  voice?: import('../runtime/music/music-manager.js').VoiceApi;
  /** Enregistrement vocal expérimental (`bc.recorder`), lié au serveur du déclencheur. */
  recorder?: import('../runtime/voice/voice-recorder.js').VoiceRecorderApi;
}

export interface ScriptLogger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}
