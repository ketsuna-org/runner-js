import type { ChatInputCommandInteraction } from 'discord.js';

import { createTokenSafeClientProxy } from '../scripts/script-direct-runtime.js';

/**
 * `message` compatibility object handed to scripts of HYBRID commands (prefix +
 * slash) when they run from a slash invocation. Without it `message` is
 * `undefined` there and `await message.reply(...)` throws.
 *
 * Supported surface (everything else is intentionally absent, e.g. NO
 * `message.content`, `message.mentions`, `message.delete()`, `message.edit()`):
 *   - `reply(options)`            -> first call interaction.reply (or editReply when
 *                                    already deferred), then followUp
 *   - `channel.send(options)`     -> same routing as reply (so the interaction is
 *                                    always answered); other `channel.*` members are
 *                                    forwarded to interaction.channel
 *   - `author` / `member` / `guild` / `client` (token-safe) / `id`
 *   - `channelId` / `guildId`
 *   - `isInteractionCompat: true` marker; `interaction` is also always defined in
 *     slash mode and `undefined` in prefix mode, which is the reliable mode check.
 *
 * Only exposed to the script: variable scoping still sees the real (absent) message.
 */
export type InteractionMessageCompat = ReturnType<typeof createInteractionMessageCompat>;

export function createInteractionMessageCompat(interaction: ChatInputCommandInteraction) {
  const respond = async (options: unknown): Promise<unknown> => {
    const payload = (typeof options === 'string' ? { content: options } : options) as never;
    if (interaction.replied) {
      return interaction.followUp(payload);
    }
    if (interaction.deferred) {
      return interaction.editReply(payload);
    }
    return interaction.reply(payload);
  };

  const channel = new Proxy(
    { id: interaction.channelId } as Record<string | symbol, unknown>,
    {
      get(target, property) {
        if (property === 'send') return respond;
        if (property in target) return target[property];
        const real = interaction.channel as unknown as Record<string | symbol, unknown> | null;
        const value = real?.[property];
        return typeof value === 'function' ? value.bind(real) : value;
      },
    },
  );

  return {
    isInteractionCompat: true as const,
    id: interaction.id,
    author: interaction.user,
    member: interaction.member,
    guild: interaction.guild,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    channel,
    client: createTokenSafeClientProxy(interaction.client) as ChatInputCommandInteraction['client'],
    reply: respond,
  };
}
