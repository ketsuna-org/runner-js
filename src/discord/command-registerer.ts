import {
  ApplicationCommandType,
  REST,
  Routes,
  type Client,
} from 'discord.js';

import type { CommandHandler } from '../config/js-bot-config.js';
import { transformCommandOptionsForDiscord } from './command-options.js';

const DISCORD_TYPE_MAP = {
  chatInput: ApplicationCommandType.ChatInput,
  user: ApplicationCommandType.User,
  message: ApplicationCommandType.Message,
} as const;

export async function registerSlashCommands(
  client: Client,
  token: string,
  commands: CommandHandler[],
): Promise<void> {
  if (!client.user) {
    throw new Error('Discord client is not ready.');
  }

  const enabled = commands.filter((command) => command.enabled !== false);
  const body = enabled.map((command) => {
    const discordType = command.discordType ?? 'chatInput';
    const type = DISCORD_TYPE_MAP[discordType] ?? ApplicationCommandType.ChatInput;
    if (type === ApplicationCommandType.ChatInput) {
      return {
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
    }
    // Context menu commands have no description/options.
    return {
      type,
      name: command.name,
    };
  });

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(client.user.id), { body });
}
