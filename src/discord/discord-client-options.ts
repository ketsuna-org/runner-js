import { GatewayIntentBits, Options, type Client, type ClientOptions } from 'discord.js';

import { mapIntents } from './intent-mapper.js';

function keepClientUser<T extends { id: string; client: { user?: { id: string } | null } }>(
  entry: T,
): boolean {
  return entry.id === entry.client.user?.id;
}

/**
 * Builds discord.js Client options with minimal in-memory caches.
 * Cache limits are intent-aware so we only retain data the bot can receive,
 * except GuildMemberManager which keeps a small cache so MESSAGE_CREATE
 * partial members remain resolvable via message.member.
 *
 * The bot's own GuildMember / VoiceState are always kept — discord.js only
 * forwards VOICE_STATE_UPDATE to @discordjs/voice when the bot member is
 * present in cache; otherwise joins stay stuck in signalling.
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
      // Keep a small member cache even without Guild Members intent so
      // MESSAGE_CREATE partial members remain resolvable via message.member.
      // Always retain the bot's own member for voice adapter wiring.
      GuildMemberManager: {
        maxSize: 25,
        keepOverLimit: keepClientUser,
      },
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
      VoiceStateManager: hasVoiceStates
        ? {
            maxSize: 50,
            keepOverLimit: keepClientUser,
          }
        : 0,
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

export function clientHasGuildVoiceStatesIntent(client: Client): boolean {
  const intents = client.options.intents;
  if (intents == null) {
    return false;
  }
  if (typeof (intents as { has?: (bit: number) => boolean }).has === 'function') {
    return (intents as { has: (bit: number) => boolean }).has(GatewayIntentBits.GuildVoiceStates);
  }
  const bits = Array.isArray(intents)
    ? intents.reduce<number>((acc, bit) => acc | Number(bit), 0)
    : Number(intents);
  return (bits & GatewayIntentBits.GuildVoiceStates) !== 0;
}
