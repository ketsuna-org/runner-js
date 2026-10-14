import { ApplicationCommandType, REST, type Client } from 'discord.js';

import { supportsSlash, type CommandHandler } from '../config/js-bot-config.js';
import {
  commandKeyOf,
  removeCommands,
  type CommandKey,
  type CommandRest,
} from './application-command-sync.js';
import { transformCommandOptionsForDiscord } from './command-options.js';

/** La commande telle que Discord l'attend. Sert à détecter qu'une inscription a changé. */
interface DesiredApplicationCommand {
  type: number;
  name: string;
  description?: string;
  options?: unknown[];
  default_member_permissions?: string;
  contexts?: number[];
  integration_types?: number[];
}

const DISCORD_TYPE_MAP = {
  chatInput: ApplicationCommandType.ChatInput,
  user: ApplicationCommandType.User,
  message: ApplicationCommandType.Message,
} as const;

/**
 * Builds the command Discord should expose for a local handler.
 *
 * `id` is NOT part of the payload: Discord assigns it and keeps it (the
 * Manager or the app publish it, never this runner). Sending the local id here was considered and rejected —
 * an imported bot carries ids that are not Discord snowflakes, and a rejected
 * command used to invalidate the whole registration.
 */
export function toDiscordCommand(command: CommandHandler): DesiredApplicationCommand {
  const discordType = command.discordType ?? 'chatInput';
  const type = DISCORD_TYPE_MAP[discordType] ?? ApplicationCommandType.ChatInput;
  if (type === ApplicationCommandType.ChatInput) {
    const payload: DesiredApplicationCommand = {
      type,
      name: command.name,
      description: command.description || command.name,
      options: transformCommandOptionsForDiscord(
        (command.options ?? []).filter(
          (option): option is Record<string, unknown> =>
            typeof option === 'object' && option !== null,
        ),
      ),
    };
    // Only when declared: PATCH is partial, so a permission we do not send keeps
    // whatever Discord already has instead of being reset to "everyone".
    const permissions = command.defaultMemberPermissions;
    if (permissions !== undefined && permissions !== null && `${permissions}`.length > 0) {
      payload.default_member_permissions = `${permissions}`;
    }
    if (command.contexts !== undefined) payload.contexts = command.contexts;
    if (command.integrationTypes !== undefined) payload.integration_types = command.integrationTypes;
    return payload;
  }
  // Context menu commands have no description/options.
  return {
    type, name: command.name,
    ...(command.defaultMemberPermissions !== undefined
      ? { default_member_permissions: `${command.defaultMemberPermissions}` } : {}),
    ...(command.contexts !== undefined ? { contexts: command.contexts } : {}),
    ...(command.integrationTypes !== undefined ? { integration_types: command.integrationTypes } : {}),
  };
}

/** Execution changes do not require even a Discord registration lookup. */
export function commandRegistrationsEqual(before: CommandHandler[], after: CommandHandler[]): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]));
    }
    return value;
  };
  const signature = (commands: CommandHandler[]) => JSON.stringify(canonical(commands
    .filter((command) => command.enabled !== false && supportsSlash(command))
    .map(toDiscordCommand)
    .sort((a, b) => a.type - b.type || a.name.localeCompare(b.name))));
  return signature(before) === signature(after);
}

/** Les clés (type, nom) des commandes que ce runner exposerait en slash. */
export function slashCommandKeys(commands: CommandHandler[]): CommandKey[] {
  return commands
    .filter((command) => command.enabled !== false && supportsSlash(command))
    .map((command) => toDiscordCommand(command))
    .map((command) => ({ type: command.type, name: command.name }));
}

/**
 * Propage la SUPPRESSION basique : les commandes slash présentes dans `before` et absentes de `after`
 * sont retirées chez Discord. Un runner ne crée et ne modifie JAMAIS de commande (le Manager ou
 * l'application en sont les auteurs) et ne supprime rien qu'il ne connaissait pas.
 */
export async function removeStaleSlashCommands(
  client: Client,
  before: CommandHandler[],
  after: CommandHandler[],
  rest: CommandRest,
): Promise<string[]> {
  const kept = new Set(slashCommandKeys(after).map((key) => commandKeyOf(key)));
  const stale = slashCommandKeys(before).filter((key) => !kept.has(commandKeyOf(key)));
  // Rien n'a disparu : on ne touche même pas au client.
  if (stale.length === 0) return [];
  if (!client.user) {
    throw new Error('Discord client is not ready.');
  }
  return removeCommands(rest, client.user.id, stale);
}

export function discordRest(token: string): CommandRest {
  return new REST({ version: '10' }).setToken(token) as unknown as CommandRest;
}
