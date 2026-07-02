import {
  REST,
  Routes,
  type APIApplicationCommandOption,
  type Client,
} from 'discord.js';

import type { CommandHandler } from '../config/js-bot-config.js';

export async function registerSlashCommands(
  client: Client,
  token: string,
  commands: CommandHandler[],
): Promise<void> {
  if (!client.user) {
    throw new Error('Discord client is not ready.');
  }

  const enabled = commands.filter((command) => command.enabled !== false);
  const body = enabled.map((command) => ({
    name: command.name,
    description: command.description || command.name,
    options: (command.options ?? []) as unknown as APIApplicationCommandOption[],
  }));

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(client.user.id), { body });
}
