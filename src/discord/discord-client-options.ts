import { Options, type ClientOptions } from 'discord.js';

import { mapIntents } from './intent-mapper.js';

/**
 * Builds discord.js Client options with minimal in-memory caches.
 * Cache limits are intent-aware so we only retain data the bot can receive.
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
      MessageManager: 0,
      PresenceManager: 0,
      ReactionManager: 0,
      StageInstanceManager: 0,
      ThreadManager: 0,
      ThreadMemberManager: 0,
      UserManager: 0,
      VoiceStateManager: hasVoiceStates ? 50 : 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 300, lifetime: 300 },
      users: {
        interval: 300,
        filter: () => (user) => user.id !== user.client.user?.id,
      },
    },
  };
}
