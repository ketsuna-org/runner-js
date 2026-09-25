import { ApplicationCommandType, REST, type Client } from 'discord.js';

import type { CommandHandler } from '../config/js-bot-config.js';
import {
  applyCommandDiff,
  type CommandRest,
  type CommandSyncReport,
  type DesiredApplicationCommand,
} from './application-command-sync.js';
import { transformCommandOptionsForDiscord } from './command-options.js';

const DISCORD_TYPE_MAP = {
  chatInput: ApplicationCommandType.ChatInput,
  user: ApplicationCommandType.User,
  message: ApplicationCommandType.Message,
} as const;

/**
 * Builds the command Discord should expose for a local handler.
 *
 * `id` is NOT part of the payload: Discord assigns it and keeps it (see
 * `applyCommandDiff`). Sending the local id here was considered and rejected —
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
    return payload;
  }
  // Context menu commands have no description/options.
  return { type, name: command.name };
}

/**
 * Aligns Discord's application commands with the bot's configuration.
 *
 * Returns what actually changed, so a caller can tell "nothing to do" from
 * "N commands registered" — the previous version returned nothing at all, and
 * its failures were swallowed by a `.catch` at every call site.
 */
export async function registerSlashCommands(
  client: Client,
  token: string,
  commands: CommandHandler[],
  rest: CommandRest = new REST({ version: '10' }).setToken(token) as unknown as CommandRest,
): Promise<CommandSyncReport> {
  if (!client.user) {
    throw new Error('Discord client is not ready.');
  }

  const desired = commands
    .filter((command) => command.enabled !== false)
    .map((command) => toDiscordCommand(command));

  return applyCommandDiff(rest, client.user.id, desired);
}
