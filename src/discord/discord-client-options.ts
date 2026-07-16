import { Options, type ClientOptions } from 'discord.js';

import { mapIntents } from './intent-mapper.js';

/**
 * Builds discord.js Client options with minimal in-memory caches.
 * Cache limits are intent-aware so we only retain data the bot can receive.
 *
 * Note: GuildManager / GuildChannelManager cannot be limited via cacheWithLimits
 * in current discord.js (typed as TODO) — guild/channel growth is mitigated by
 * worker RSS soft-restart instead.
 */
export function buildDiscordClientOptions(
  intentsMap: Record<string, boolean>,
): ClientOptions {
  const hasGuildMembers = Boolean(intentsMap['Guild Members']);
  const hasVoiceStates = Boolean(intentsMap['Guild Voice States']);

  return {
    intents: mapIntents(intentsMap),
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      ApplicationCommandManager: 0,
      AutoModerationRuleManager: 0,
      BaseGuildEmojiManager: 0,
      DMMessageManager: 0,
      GuildBanManager: 0,
      GuildEmojiManager: 0,
      GuildForumThreadManager: 0,
      GuildInviteManager: 0,
      GuildMemberManager: hasGuildMembers ? 25 : 0,
      GuildScheduledEventManager: 0,
      GuildStickerManager: 0,
      GuildTextThreadManager: 25,
      MessageManager: 0,
      PresenceManager: 0,
      ReactionManager: 0,
      StageInstanceManager: 0,
      ThreadManager: 25,
      ThreadMemberManager: 0,
      UserManager: 0,
      VoiceStateManager: hasVoiceStates ? 50 : 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 300, lifetime: 300 },
      threads: { interval: 300, lifetime: 600 },
      users: {
        interval: 300,
        filter: () => (user) => user.id !== user.client.user?.id,
      },
      ...(hasGuildMembers
        ? {
            guildMembers: {
              interval: 300,
              filter: () => (member) => member.id !== member.client.user?.id,
            },
          }
        : {}),
    },
  };
}
